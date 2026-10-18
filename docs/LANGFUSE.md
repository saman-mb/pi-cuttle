# LangFuse Deployment Guide

LangFuse is an open-source LLM engineering platform for monitoring, debugging, and analyzing
LLM applications. This guide covers deploying LangFuse locally via Docker Compose for use with
pi-cuttle's routing telemetry.

## Quick Start

### 1. Set up environment variables

```bash
cp .env.example .env
```

Generate secure random strings for the required secrets:

```bash
# Generate NEXTAUTH_SECRET (32 bytes)
openssl rand -base64 32

# Generate ENCRYPTION_KEY (32 bytes)
openssl rand -base64 32

# Generate SALT (16 bytes)
openssl rand -base64 16
```

Update `.env` with these values. **Never commit real secrets to version control.**

### 2. Start LangFuse

```bash
npm run langfuse:up
```

This starts:
- PostgreSQL database (persistent storage)
- LangFuse application (web UI + API on port 3000)

**Optional:** Include Redis for improved performance:

```bash
docker compose -f docker-compose.langfuse.yml --profile redis up -d
```

### 3. Access the LangFuse UI

Open http://localhost:3000 in your browser.

On first launch, you'll be prompted to create an admin account. After setup, you can:
- View traces and generations from your LLM calls
- Monitor costs and token usage
- Debug prompt templates
- Analyze model performance

### 4. Stop LangFuse

```bash
npm run langfuse:down
```

To view logs while running:

```bash
npm run langfuse:logs
```

## Environment Variables

| Variable | Required | Description | Default |
|---|---|---|---|
| `NEXTAUTH_SECRET` | Yes | Secret for NextAuth.js session encryption | - |
| `ENCRYPTION_KEY` | Yes | Key for encrypting sensitive data in the database | - |
| `SALT` | Yes | Salt for password hashing | - |
| `LANGFUSE_DATABASE_USER` | No | PostgreSQL username | `postgres` |
| `LANGFUSE_DATABASE_PASSWORD` | No | PostgreSQL password | `postgres` |
| `LANGFUSE_DATABASE_NAME` | No | PostgreSQL database name | `langfuse` |
| `LANGFUSE_PORT` | No | Port for the LangFuse web UI | `3000` |
| `REDIS_HOST` | No | Redis hostname (when using Redis profile) | `langfuse-redis` |
| `REDIS_PORT` | No | Redis port | `6379` |
| `REDIS_AUTH` | No | Redis authentication password | - |

## Data Persistence

PostgreSQL data is stored in a Docker volume (`langfuse-postgres-data`). Your traces,
generations, and configuration persist across container restarts. To remove all data:

```bash
docker compose -f docker-compose.langfuse.yml down -v
```

## Integration with pi-cuttle

LangFuse integration with pi-cuttle's routing decisions is handled separately (see issue #88).
Once integrated, you will be able to:
- Trace each routing decision made by the classifier
- Monitor which models are selected per turn
- Analyze cost savings from local vs cloud routing
- Debug classifier failures and fallback behavior

## Troubleshooting

### Container won't start

Check logs for errors:

```bash
docker compose -f docker-compose.langfuse.yml logs
```

Common issues:
- Missing or invalid environment variables
- Port 3000 already in use (change `LANGFUSE_PORT` in `.env`)
- Insufficient disk space for PostgreSQL data

### Cannot access the UI

- Verify containers are running: `docker compose -f docker-compose.langfuse.yml ps`
- Check if port 3000 is accessible: `curl http://localhost:3000`
- Ensure firewall isn't blocking the port

### Database connection errors

- Wait for PostgreSQL to finish initializing (check health status)
- Verify database credentials match in `.env`
- Restart the stack: `npm run langfuse:down && npm run langfuse:up`
