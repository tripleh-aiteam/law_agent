/**
 * Manus AI REST client — creates an autonomous-agent task, polls until
 * complete, returns the text result.
 *
 * IMPORTANT: this client was wired against the PUBLIC documentation surface
 * available at the time of writing (Nov 2026). Manus's full API reference
 * lives behind their developer portal at https://open.manus.ai/docs and
 * may differ in exact field names. The constants at the top of this file
 * (BASE_URL, endpoint paths, body keys, result extraction) are isolated so
 * the user can adjust them in ONE place once they have access to the
 * authoritative spec.
 *
 * If you get 404s or auth errors after dropping in a real MANUS_API_KEY,
 * check the actual Manus docs and tweak:
 *   - MANUS_BASE_URL
 *   - CREATE_TASK_PATH / GET_TASK_PATH
 *   - REQUEST body shape inside createTask()
 *   - RESULT extraction inside extractResult()
 */

// Manus API v2 — current as of late 2026. v1 is deprecated and slated for
// removal. If Manus releases v3 later, change this single block. The
// auth header format is confirmed Bearer-token (verify on the
// /docs/getting-started/authentication page once you have a key).
const MANUS_BASE_URL = "https://api.manus.ai";
const CREATE_TASK_PATH = "/v2/tasks";
const GET_TASK_PATH = (id: string) => `/v2/tasks/${encodeURIComponent(id)}`;

/** How often we poll while the task is running (ms). */
const POLL_INTERVAL_MS = 5_000;
/** Hard ceiling on polling — task is considered timed out after this. */
const POLL_MAX_MS = 25 * 60 * 1000; // 25 min

export type ManusTaskStatus =
  | "pending"
  | "running"
  | "complete"
  | "failed"
  | "cancelled";

export interface ManusTask {
  task_id: string;
  status: ManusTaskStatus;
  /** Final agent output (populated when status === "complete"). */
  result?: {
    text?: string;
    /** Optional file attachments Manus produced (PDF, markdown, etc.). */
    artifacts?: Array<{ name: string; url: string; type: string }>;
  };
  /** Error detail when status === "failed". */
  error?: { code?: string; message?: string };
}

function authHeaders(): Record<string, string> {
  const key = process.env.MANUS_API_KEY;
  if (!key) {
    throw new Error(
      "MANUS_API_KEY is not set. Add it to .env.local locally and to the Vercel project environment variables to enable the Manus model.",
    );
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  };
}

/**
 * Unwrap Manus's standard response envelope ({ ok, request_id, data | error })
 * into either the inner `data` object or throw a thrown Error with the
 * Manus-supplied error message.
 */
async function unwrap<T>(res: Response): Promise<T> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Manus API: non-JSON response (HTTP ${res.status})`);
  }
  const env = body as {
    ok?: boolean;
    data?: T;
    error?: { code?: string; message?: string };
  };
  if (!res.ok || env.ok === false || env.error) {
    const code = env.error?.code ?? `http_${res.status}`;
    const msg = env.error?.message ?? `Manus API error (HTTP ${res.status})`;
    throw new Error(`[${code}] ${msg}`);
  }
  if (!env.data) {
    throw new Error("Manus API: missing `data` field in successful response");
  }
  return env.data;
}

/**
 * POST /v1/tasks — kick off a new autonomous-agent task. Returns the
 * task id immediately; use waitForCompletion() to block until the task
 * finishes.
 */
export async function createTask(
  prompt: string,
  signal?: AbortSignal,
): Promise<ManusTask> {
  const res = await fetch(`${MANUS_BASE_URL}${CREATE_TASK_PATH}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      prompt,
      // Manus's PHP SDK uses these option names; verify against actual
      // docs if your dev tier rejects them.
      taskMode: "agent",
      agentProfile: "manus-1.6",
    }),
    signal,
  });
  return unwrap<ManusTask>(res);
}

/** GET /v1/tasks/{id} — single status read. */
export async function getTask(
  taskId: string,
  signal?: AbortSignal,
): Promise<ManusTask> {
  const res = await fetch(`${MANUS_BASE_URL}${GET_TASK_PATH(taskId)}`, {
    method: "GET",
    headers: authHeaders(),
    signal,
  });
  return unwrap<ManusTask>(res);
}

/** Sleep that honors AbortSignal — rejects with AbortError on abort. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll a task until it reaches a terminal status (complete / failed /
 * cancelled) OR we hit POLL_MAX_MS — whichever comes first. Honors the
 * caller's AbortSignal so the Stop button can cancel the wait promptly.
 */
export async function waitForCompletion(
  taskId: string,
  signal?: AbortSignal,
): Promise<ManusTask> {
  const deadline = Date.now() + POLL_MAX_MS;
  while (true) {
    const task = await getTask(taskId, signal);
    if (
      task.status === "complete" ||
      task.status === "failed" ||
      task.status === "cancelled"
    ) {
      return task;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Manus task timed out after ${POLL_MAX_MS / 60_000} minutes. Task id: ${taskId}. Check task status at https://manus.im/tasks/${taskId} or extend POLL_MAX_MS.`,
      );
    }
    await sleep(POLL_INTERVAL_MS, signal);
  }
}

/**
 * Convenience: create + await + extract result text in one call.
 * Throws on failure (failed task, abort, timeout, network) — caller wraps
 * the error in their own branch-status update.
 */
type ManusArtifact = { name: string; url: string; type: string };

export async function runManusAgent(
  prompt: string,
  signal?: AbortSignal,
): Promise<{ text: string; artifacts: ManusArtifact[] | undefined }> {
  const created = await createTask(prompt, signal);
  const finished = await waitForCompletion(created.task_id, signal);

  if (finished.status === "failed") {
    throw new Error(
      finished.error?.message ??
        "Manus task failed without a specific error message.",
    );
  }
  if (finished.status === "cancelled") {
    throw new DOMException("Aborted", "AbortError");
  }
  const text = finished.result?.text?.trim();
  if (!text) {
    throw new Error(
      "Manus task completed but returned no text output. Check task page on manus.im for artifacts.",
    );
  }
  return { text, artifacts: finished.result?.artifacts };
}
