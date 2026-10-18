# LangFuse Deployment Guide

LangFuse is an open-source LLM engineering platform for monitoring, debugging, and analyzing
LLM applications. This guide covers deploying LangFuse v3 locally via Docker Compose for use
with pi-cuttle's routing telemetry.

## Architecture

LangFuse v3+ requires four backing services:

- **PostgreSQL** — metadata, users, projects, API keys
- **ClickHouse** — trace and observation analytics
- **Redis** — async job queue (BullMQ)
- **MinIO** — S3-compatible object storage for event/media uploads

The compose file in this repo wires all of them together and auto-provisions a project
and API keys so pi-cuttle can send traces without manual UI setup.

## Quick Start

### 1. Set up environment variables

```bash
cp .env.example .env
```

Generate secure random strings for the required secrets:

```bash
# Generate all required secrets in one go
openssl rand -hex 32   # NEXTAUTH_SECRET
openssl rand -hex 32   # ENCRYPTION_KEY
openssl rand -hex 16   # SALT
openssl rand -base64 24 # REDIS_AUTH
openssl rand -hex 16   # LANGFUSE_PUBLIC_KEY prefix
openssl rand -hex 32   # LANGFUSE_SECRET_KEY
```

Update `.env` with these values. **Never commit real secrets to version control.**

### 2. Start LangFuse

```bash
npm run langfuse:up
```

This starts PostgreSQL, ClickHouse, Redis, MinIO, LangFuse web, and LangFuse worker.

### 3. Access the LangFuse UI

Open http://localhost:3000 in your browser.

Default credentials (set in `.env`):
- Email: `admin@example.com`
- Password: `password` (change this before exposing to a network)

API keys are auto-provisioned from `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` in `.env`.

### 4. Stop LangFuse

```bash
npm run langfuse:down
```

To view logs while running:

```bash
npm run langfuse:logs
```

To remove all data (volumes):

```bash
docker compose -f docker-compose.langfuse.yml down -v
```

## Environment Variables

| Variable | Required | Description | Default |
|---|---|---|---|
| `NEXTAUTH_SECRET` | Yes | NextAuth.js session encryption | - |
| `ENCRYPTION_KEY` | Yes | Encrypts sensitive data in the database | - |
| `SALT` | Yes | Salt for password hashing | - |
| `REDIS_AUTH` | Yes | Redis authentication password | - |
| `POSTGRES_USER` | No | PostgreSQL username | `postgres` |
| `POSTGRES_PASSWORD` | No | PostgreSQL password | `postgres` |
| `POSTGRES_DB` | No | PostgreSQL database name | `postgres` |
| `CLICKHOUSE_USER` | No | ClickHouse username | `clickhouse` |
| `CLICKHOUSE_PASSWORD` | No | ClickHouse password | `clickhouse` |
| `MINIO_ROOT_USER` | No | MinIO root user | `minio` |
| `MINIO_ROOT_PASSWORD` | No | MinIO root password | `miniosecret` |
| `LANGFUSE_S3_BUCKET` | No | S3 bucket name used by LangFuse | `langfuse` |
| `LANGFUSE_PORT` | No | Port for the LangFuse web UI | `3000` |
| `LANGFUSE_PUBLIC_KEY` | Yes | Auto-provisioned project public key | - |
| `LANGFUSE_SECRET_KEY` | Yes | Auto-provisioned project secret key | - |
| `LANGFUSE_INIT_USER_EMAIL` | No | Initial admin email | `admin@example.com` |
| `LANGFUSE_INIT_USER_PASSWORD` | No | Initial admin password | `password` |

## Full pi session tracing (official LangFuse plugin)

For complete pi observability — prompts, responses, tool calls, and model
generations — install the official LangFuse pi extension:

```bash
pi install npm:@langfuse/pi-observability-plugin
```

Create `~/.pi/agent/langfuse.json`:

```json
{
  "publicKey": "pk-pi-cuttle-...",
  "secretKey": "sk-pi-cuttle-...",
  "baseUrl": "http://localhost:3000",
  "userId": "your-name",
  "environment": "local"
}
```

The plugin reads this file automatically. It creates one trace per user prompt
and nests model generations, tool calls, and subagents under it.

To disable tracing for a single run:

```bash
LANGFUSE_TRACING_ENABLED=false pi
```

## Integration with pi-cuttle

Add the auto-provisioned keys to your pi-cuttle config (`~/.pi/agent/pi-cuttle.json`):

```json
{
  "observability": {
    "enabled": true,
    "provider": "langfuse",
    "baseUrl": "http://localhost:3000",
    "publicKey": "pk-pi-cuttle-...",
    "secretKey": "sk-pi-cuttle-..."
  }
}
```

Each routing decision then creates a LangFuse trace containing tier, model, flavor,
complexity score, thinking level, and subagent policy state. Annotate misroutes with
the `misroute` tag in the LangFuse UI and export them via `npm run eval:export-misroutes`.

The two integrations coexist: the official plugin captures the full pi session,
while pi-cuttle emits focused routing-decision traces.

### Routing scores

Every routing decision is also scored. Scores are computed in code from data already in the
trace and ingested by `POST /api/public/scores` against the trace id — no SDK, and no model call.
They are **observational, not a gate**: a score can never fail a turn or block a change.

| Score | Type | Rule |
| --- | --- | --- |
| `flavor_compliance` | boolean | Emitted for `local`, `fast-local` and `big-local`. `false` when the serving model is not in `catalog.local`. The tripwire for a local-only flavor served by a cloud model. |
| `routed` | boolean | Emitted on the child-bypass path with value `false`: a child session that inherited a non-router model and so never entered the router. |

A `flavor_compliance` of `false` is picked up by `npm run eval:export-misroutes` and appended to
`eval/misroutes.jsonl` as a fixture, the same way a trace tagged `misroute` is. That closes the
loop: a leak seen in production becomes a regression test without anyone tagging it by hand.

## Troubleshooting

### Container won't start

Check logs:

```bash
docker compose -f docker-compose.langfuse.yml logs
```

Common issues:
- `Invalid environment variables` — usually a malformed email or too-short secret. Use hex values for `NEXTAUTH_SECRET`, `ENCRYPTION_KEY`, and `SALT`.
- Port 3000 already in use — change `LANGFUSE_PORT` in `.env`.
- `CLICKHOUSE_URL is not configured` — you are using a v2-era compose file; use the v3 file from this repo.

### Cannot access the UI

- Verify containers are running: `docker compose -f docker-compose.langfuse.yml ps`
- Check health: `curl http://localhost:3000/api/public/health`
- Ensure Docker Desktop has enough resources (LangFuse + ClickHouse need ~2 GB RAM).

## References

- [LangFuse Docker Compose self-hosting](https://langfuse.com/self-hosting/docker-compose)
- [LangFuse v2 to v3 migration](https://langfuse.com/self-hosting/upgrade-guides/upgrade-v2-to-v3)
