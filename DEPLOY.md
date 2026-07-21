# Law Agent — On-Prem Deployment Guide

Deploying Law Agent on the firm's own Linux server with Docker.

Everything runs inside your network. The only outbound traffic is:
- **redacted** text to whichever LLM provider you configure
- case numbers to `law.go.kr` for citation verification

Embeddings and PII redaction run locally and never leave the building.

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| Linux server | Any distro with Docker. Ubuntu 22.04+ / Rocky 9 tested paths. |
| Docker Engine 24+ | `docker --version` |
| Docker Compose v2 | `docker compose version` (note: no hyphen) |
| RAM | 4 GB minimum, 8 GB recommended. Embedding model ≈ 1 GB resident. |
| Disk | ~5 GB for images + model + database |
| Outbound HTTPS | To your LLM provider(s) and `law.go.kr` |

If Docker isn't installed:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # log out and back in
```

---

## 2. Clone and configure

```bash
git clone https://github.com/tripleh-aiteam/law_agent.git
cd law_agent

cp .env.production.example .env
```

Now edit `.env`. **Two values are mandatory:**

```bash
# 1. Database password — generate one:
openssl rand -base64 32

# 2. At least one LLM provider key.
#    GROQ_API_KEY alone is enough and is free.
```

Everything else has a working default. `.env` is gitignored — never commit it.

### Which LLM keys do I need?

| Key | Needed? | Effect |
|---|---|---|
| `GROQ_API_KEY` | **Recommended minimum** | Free. Powers the default model (Open GPT 120B). System fully works with only this. |
| `ANTHROPIC_API_KEY` | Optional, **best quality** | Claude Sonnet — materially better Korean legal reasoning. |
| `OPENAI_API_KEY` | Optional | ChatGPT models. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Optional | Gemini. |
| `MANUS_API_KEY` | Optional | Manus autonomous agent. |
| `LAW_GO_KR_API_KEY` | Strongly recommended | Citation verification. See §6. |

**No embedding key is required.** Embeddings run locally on CPU.

---

## 3. Start the stack

```bash
docker compose up -d --build
```

First build takes 5–15 minutes: it compiles the app and downloads the
embedding model (~280 MB) into the image so the container never needs
huggingface.co at runtime.

Check it came up:

```bash
docker compose ps
curl -s http://localhost:3000/api/health | jq
```

Expect `"status": "degraded"` at this point — the app is healthy but the
corpus isn't loaded yet. That's next.

---

## 4. Load the precedent corpus

One-time. Loads the 409 대법원 cases and embeds them locally.

```bash
docker compose exec app npx tsx scripts/migrate-corpus-to-db.ts
```

Takes a few minutes on CPU. You'll see `Progress: N/409`.

Verify:

```bash
curl -s http://localhost:3000/api/health | jq
# "status": "ok", "corpus": { "total": 409, "embedded": 409 }
```

> **Why re-embed instead of importing the existing vectors?**
> The old `corpus-embeddings.json` holds 1536-dim vectors from the Vercel AI
> Gateway. The local model produces 768-dim. Dimensions can't be mixed —
> pgvector rejects it — so every case is re-embedded with the new model.
> It's free and local.

---

## 5. Open it

```
http://<server-ip>:3000/ko
```

Korean UI at `/ko`, English at `/en`.

Test with a real fact pattern and confirm you get both an analysis **and**
precedent matches. If the analysis appears but precedents don't, re-check §4.

---

## 6. law.go.kr citation verification

This is the single most important correctness feature, and the main technical
reason the app left Vercel.

`law.go.kr` **allowlists by IP address**. It blocked Vercel's US egress IPs
entirely, so verification was permanently degraded in production. From a
Korean server it works.

1. Register the server's public IP at <https://open.law.go.kr> against your OC code
2. Put that OC code in `.env` as `LAW_GO_KR_API_KEY`
3. `docker compose restart app`

Find the server's public IP:

```bash
curl -s https://api.ipify.org
```

---

## 7. TLS / internal hostname (optional but recommended)

To serve over HTTPS on an internal hostname instead of a bare port:

1. Ask IT for an internal DNS name (e.g. `law-agent.firm.local`)
2. Edit `Caddyfile` — replace `law-agent.internal` with that name
3. Restrict the app to localhost in `docker-compose.yml`:
   ```yaml
   ports:
     - "127.0.0.1:3000:3000"
   ```
4. Start with the proxy profile:
   ```bash
   docker compose --profile proxy up -d
   ```

`tls internal` uses Caddy's own CA — browsers warn unless IT installs the root
certificate. If your firm already issues internal certs, use those instead:

```
tls /path/to/cert.pem /path/to/key.pem
```

---

## 8. Day-to-day operations

```bash
docker compose logs -f app        # follow logs
docker compose restart app        # restart after .env changes
docker compose down               # stop (data survives)
docker compose up -d --build      # after a git pull
```

### Backups

All state lives in the `pgdata` volume:

```bash
docker compose exec db pg_dump -U lawagent lawagent | gzip > backup-$(date +%F).sql.gz
```

Restore:

```bash
gunzip -c backup-2026-07-21.sql.gz | docker compose exec -T db psql -U lawagent lawagent
```

### Updating

```bash
git pull
docker compose up -d --build
```

The corpus survives rebuilds — it's in the database volume, not the image.
Only re-run the migration if you change the embedding model or add cases.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `POSTGRES_PASSWORD must be set` | Empty value in `.env` | Set it; compose refuses to start without one |
| Health shows `"database": "unreachable"` | DB still starting | Wait ~20s; `docker compose logs db` |
| Health `"status": "degraded"` | Corpus not migrated | Run §4 |
| Analysis works, no precedents | Corpus not migrated, or migration failed midway | Re-run §4 — it's idempotent |
| `No API key configured for anthropic` | Model selected without its key | Set the key in `.env` and restart, or pick a different model in the UI |
| All models fail | No provider key set | Set at least `GROQ_API_KEY` (free) |
| Citations show unverified | law.go.kr IP not registered | See §6 |
| Build OOM | <4 GB RAM | Add swap, or build on a bigger machine and push the image |

### Reset everything

Destroys the database, including the corpus:

```bash
docker compose down -v
docker compose up -d --build
docker compose exec app npx tsx scripts/migrate-corpus-to-db.ts
```

---

## 10. Known limitations

Be aware of these before the team relies on it:

1. **No authentication yet.** Anyone who can reach the port has full access.
   Keep it on the internal network only. Accounts are Phase 2.
2. **Cases are stored in the browser**, not the server. Each attorney sees
   only their own, and clearing browser data loses them. Phase 3.
3. **No audit log.** Phase 4.
4. **The model can invent case numbers in its prose.** Precedents in the
   결과 panel come from the verified corpus, but citations written inside the
   narrative text are not yet checked. **Verify any case number before
   relying on it.** Phase 5 — the highest-priority remaining fix.

See `docs/superpowers/specs/2026-07-21-law-agent-onprem-enterprise-design.md`
for the full phase plan.
