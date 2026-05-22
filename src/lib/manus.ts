/**
 * Manus AI REST client — creates an autonomous-agent task, polls until
 * complete, returns the text result.
 *
 * Endpoint shape verified via live probe on 2026-05-20:
 *   - Base URL:  https://api.manus.ai
 *   - Auth:      X-Manus-Api-Key header (NOT Bearer)
 *   - Create:    POST /v1/tasks   body: { prompt, ... }
 *                 → { task_id, task_title, task_url }
 *   - Get:       GET  /v1/tasks/{id}
 *                 → { id, status, output: [{ role, content: [{ text }] }],
 *                     credit_usage }
 *   - Status:    "pending" / "in_progress" / "completed" / "failed" /
 *                "cancelled"
 *
 * NOT an enveloped response — there's no { ok, data } wrapper. Top-level
 * fields are returned directly. Errors come back as
 *   { code: int, message: string, details: [...] }
 * with a 4xx HTTP status.
 */

const MANUS_BASE_URL = "https://api.manus.ai";
const CREATE_TASK_PATH = "/v1/tasks";
const GET_TASK_PATH = (id: string) => `/v1/tasks/${encodeURIComponent(id)}`;

/** How often we poll while the task is running (ms). */
const POLL_INTERVAL_MS = 2_000;
/**
 * Hard ceiling on polling. 4 min covers real Manus research tasks
 * producing the new 8-paragraph mandatory legal memorandum (which
 * Manus lite can take 90-180s to write end-to-end in Korean).
 * Previously 180s was bailing on tasks that were genuinely still
 * producing the long required output.
 */
const POLL_MAX_MS = 720_000;
/**
 * If Manus is stuck in an "awaiting user input" state we want to bail
 * early — but ONLY when the assistant's last message clearly looks
 * like a clarification request (not just an intermediate "I'll get
 * back to you" placeholder).
 */
const EARLY_EXTRACT_AFTER_MS = 90_000;

export type ManusTaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

interface ManusOutputContent {
  type?: string;
  text?: string;
}

interface ManusOutputItem {
  id?: string;
  status?: string;
  role?: "user" | "assistant" | "system";
  type?: string;
  content?: ManusOutputContent[];
}

interface ManusCreateResponse {
  task_id: string;
  task_title?: string;
  task_url?: string;
}

interface ManusGetResponse {
  id: string;
  object?: string;
  created_at?: string;
  updated_at?: string;
  status: ManusTaskStatus;
  model?: string;
  metadata?: {
    task_title?: string;
    task_url?: string;
  };
  output?: ManusOutputItem[];
  credit_usage?: number;
}

interface ManusErrorEnvelope {
  code?: number;
  message?: string;
  details?: unknown[];
}

function authHeaders(): Record<string, string> {
  const key = process.env.MANUS_API_KEY;
  if (!key || !key.trim()) {
    throw new Error(
      "MANUS_API_KEY is not set. Add it to .env.local locally and to the Vercel project environment variables (exact name MANUS_API_KEY — case matters).",
    );
  }
  return {
    "Content-Type": "application/json",
    "X-Manus-Api-Key": key,
  };
}

/** Raise an Error from a failed Manus HTTP response. */
async function throwFromResponse(res: Response): Promise<never> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Manus API: non-JSON response (HTTP ${res.status})`);
  }
  const env = body as ManusErrorEnvelope;
  const code = typeof env.code === "number" ? env.code : res.status;
  const message =
    env.message ?? `Manus API error (HTTP ${res.status})`;
  throw new Error(`[http_${code}] ${message}`);
}

/**
 * Default Manus agent profile. Options (per Manus API):
 *  - "manus-1.6"      : full autonomous agent — browses web, runs code,
 *                        multi-step planning. Slow (3–30 min per task).
 *  - "manus-1.6-lite" : FAST LLM-only profile. Skips agentic tool use,
 *                        answers like a normal chat completion. ~15–60s
 *                        per query. THIS IS OUR DEFAULT because most
 *                        legal questions don't actually need the agentic
 *                        capabilities, and 30 min was killing UX.
 *  - "manus-1.6-max"  : Higher-compute autonomous agent. Slowest.
 */
const DEFAULT_AGENT_PROFILE = "manus-1.6-lite";

/** POST /v1/tasks — kick off a new task. */
export async function createTask(
  prompt: string,
  signal?: AbortSignal,
): Promise<{ task_id: string; task_url?: string }> {
  const res = await fetch(`${MANUS_BASE_URL}${CREATE_TASK_PATH}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      prompt,
      agentProfile: DEFAULT_AGENT_PROFILE,
    }),
    signal,
  });
  if (!res.ok) await throwFromResponse(res);
  const data = (await res.json()) as ManusCreateResponse;
  if (!data.task_id) {
    throw new Error("Manus API: response missing task_id");
  }
  return { task_id: data.task_id, task_url: data.task_url };
}

/** GET /v1/tasks/{id} — single status read. */
export async function getTask(
  taskId: string,
  signal?: AbortSignal,
): Promise<ManusGetResponse> {
  const res = await fetch(`${MANUS_BASE_URL}${GET_TASK_PATH(taskId)}`, {
    method: "GET",
    headers: authHeaders(),
    signal,
  });
  if (!res.ok) await throwFromResponse(res);
  return (await res.json()) as ManusGetResponse;
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
 * Poll a task until it reaches a terminal status (completed / failed /
 * cancelled) OR we hit POLL_MAX_MS — whichever comes first.
 *
 * The first poll uses retry-with-backoff because Manus has shown
 * propagation lag: a freshly-created task can return "task not found"
 * (gRPC code 5) on the first read from a different region/datacenter
 * than the one that created it. After ~3-5s the task becomes readable
 * everywhere. Subsequent polls don't retry — by then any "not found"
 * is a real bug.
 */
export async function waitForCompletion(
  taskId: string,
  signal?: AbortSignal,
): Promise<ManusGetResponse> {
  const startedAt = Date.now();
  const deadline = startedAt + POLL_MAX_MS;
  let firstPoll = true;
  while (true) {
    let task: ManusGetResponse;
    try {
      task = await getTask(taskId, signal);
    } catch (err) {
      // Retry the FIRST poll only, with backoff, if Manus returns
      // "task not found" — that's the propagation-lag signature.
      if (firstPoll && isManusNotFoundError(err)) {
        for (const delay of [1500, 3000, 5000]) {
          await sleep(delay, signal);
          try {
            task = await getTask(taskId, signal);
            firstPoll = false;
            break;
          } catch (retryErr) {
            if (!isManusNotFoundError(retryErr)) throw retryErr;
            // else keep retrying with longer delay
            task = undefined as unknown as ManusGetResponse;
          }
        }
        if (!task!) throw err;
      } else {
        throw err;
      }
    }
    firstPoll = false;

    // Terminal state — return immediately.
    if (
      task!.status === "completed" ||
      task!.status === "failed" ||
      task!.status === "cancelled"
    ) {
      return task!;
    }

    // Early-extract: if Manus is stuck waiting for the user to reply to
    // a clarification question (an "awaiting input" state that never
    // reaches `completed` from the API's perspective), bail with what
    // we have. CRITICAL: only triggers when the LAST assistant message
    // actually looks like a clarification request — NOT for intermediate
    // "I'll get back to you" or "please wait" placeholders.
    const elapsed = Date.now() - startedAt;
    if (
      elapsed > EARLY_EXTRACT_AFTER_MS &&
      looksLikeStuckAwaitingInput(task!)
    ) {
      return { ...task!, status: "completed" };
    }

    if (Date.now() > deadline) {
      throw new Error(
        `Manus task timed out after ${Math.round(POLL_MAX_MS / 1000)}s. ` +
          `The prompt may have been ambiguous — Manus is likely waiting ` +
          `for clarification. Inspect the task: ${task!.metadata?.task_url ?? taskId}`,
      );
    }
    await sleep(POLL_INTERVAL_MS, signal);
  }
}

/**
 * Heuristic: does this task's most recent assistant message look like
 * Manus is stuck asking the user for more information?
 *
 * Examples that SHOULD trigger:
 *   • "사건의 내용을 알려주십시오"
 *   • "구체적인 사실관계가 필요합니다. 첨부해 주시기 바랍니다."
 *   • "Could you provide the case details?"
 *
 * Examples that SHOULD NOT trigger (intermediate progress, not stuck):
 *   • "알겠습니다. ... 잠시만 기다려 주십시오." (working on it, please wait)
 *   • "I'll start researching now"
 *   • "Analyzing the case..."
 */
function looksLikeStuckAwaitingInput(task: ManusGetResponse): boolean {
  // Find the most recent assistant message.
  const items = task.output ?? [];
  let lastAssistantText = "";
  for (const item of items) {
    if (item.role !== "assistant") continue;
    for (const c of item.content ?? []) {
      if (typeof c.text === "string" && c.text.trim()) {
        lastAssistantText = c.text;
      }
    }
  }
  const text = lastAssistantText.trim();
  if (text.length < 30) return false;

  // "Working on it / please wait" patterns — do NOT bail.
  const intermediatePatterns = [
    "잠시만 기다",
    "잠시만요",
    "조사하여 정리",
    "분석 중",
    "검색 중",
    "확인 중",
    "i'll start",
    "i will research",
    "analyzing",
    "let me",
    "please wait",
  ];
  const lower = text.toLowerCase();
  if (intermediatePatterns.some((p) => lower.includes(p.toLowerCase()))) {
    return false;
  }

  // "Asking for case info" patterns — DO bail.
  const clarificationPatterns = [
    "사건의 내용",
    "사실관계를 알려",
    "사실관계가 필요",
    "사건 번호를 알려",
    "구체적인 사건",
    "내용이 포함되어 있지 않",
    "정보가 필요합니다",
    "정보를 제공",
    "붙여넣어 주",
    "기재해 주",
    "could you provide",
    "please clarify",
    "what case",
    "more information",
    "additional context",
  ];
  if (clarificationPatterns.some((p) => lower.includes(p.toLowerCase()))) {
    return true;
  }

  // Fallback: if the message ends with "?" or contains both "?" and a
  // request word like "주십시오 / please", it's probably asking.
  return /[?？]\s*$/.test(text) && /주십시오|주세요|please|provide/i.test(text);
}

function isManusNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return m.includes("task not found") || m.includes("[http_5]");
}

/**
 * Pull the final assistant text out of a completed task's output array.
 * Manus returns the agent's response as one or more items with
 * role==='assistant' and content of type 'output_text'.
 */
function extractFinalText(task: ManusGetResponse): string {
  const items = task.output ?? [];
  // The final assistant message tends to be near the end of the array;
  // concatenate ALL assistant text in order to be safe.
  const assistantChunks: string[] = [];
  for (const item of items) {
    if (item.role !== "assistant") continue;
    for (const c of item.content ?? []) {
      if (typeof c.text === "string" && c.text.trim()) {
        assistantChunks.push(c.text);
      }
    }
  }
  return assistantChunks.join("\n\n").trim();
}

/**
 * Convenience: create + await + extract result text in one call.
 * Throws on failure — caller wraps the error in branch-status update.
 */
export async function runManusAgent(
  prompt: string,
  signal?: AbortSignal,
): Promise<{ text: string; taskUrl?: string }> {
  const created = await createTask(prompt, signal);
  const finished = await waitForCompletion(created.task_id, signal);

  if (finished.status === "failed") {
    throw new Error("Manus task failed (no specific error from the API).");
  }
  if (finished.status === "cancelled") {
    throw new DOMException("Aborted", "AbortError");
  }
  const text = extractFinalText(finished);
  if (!text) {
    throw new Error(
      `Manus task completed but returned no text output. View it at ${finished.metadata?.task_url ?? created.task_url ?? "manus.im"}.`,
    );
  }
  return { text, taskUrl: finished.metadata?.task_url ?? created.task_url };
}
