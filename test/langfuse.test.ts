/**
 * Tests for the minimal LangFuse HTTP client (#88).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { LangFuseClient } from "../src/langfuse.ts";

function startMockLangFuseServer(): Promise<{ url: string; server: ReturnType<typeof createServer>; requests: unknown[] }> {
	const requests: unknown[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined });
			if (req.url === "/api/public/health") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ status: "ok" }));
			} else if (req.url === "/api/public/traces" || req.url === "/api/public/scores") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ id: "trace-1" }));
			} else {
				res.writeHead(404);
				res.end("not found");
			}
		});
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve({ url: `http://127.0.0.1:${port}`, server, requests });
		});
	});
}

describe("LangFuseClient", () => {
	it("sends a routing trace", async () => {
		const { url, server, requests } = await startMockLangFuseServer();
		try {
			const client = new LangFuseClient({
				enabled: true,
				provider: "langfuse",
				baseUrl: url,
				publicKey: "pk-test",
				secretKey: "sk-test",
			});

			await client.trace({
				traceId: "session-1-123",
				name: "pi-cuttle routing decision",
				prompt: "list files",
				tier: "local",
				modelId: "lmstudio/meta/muse-glimmer",
				flavor: "auto",
				thinkingLevel: "off",
				score: 0.15,
				reason: "complexity bar 0.5 (local keyword)",
				source: "heuristic",
				isSubagent: false,
			});

			assert.equal(requests.length, 1);
			const req = requests[0] as { method: string; url: string; headers: Record<string, string>; body: Record<string, unknown> };
			assert.equal(req.method, "POST");
			assert.equal(req.url, "/api/public/traces");
			assert.ok(req.headers.authorization?.startsWith("Basic "), "authorization header should be Basic");
			assert.equal(req.body.name, "pi-cuttle routing decision");
			assert.equal((req.body.metadata as Record<string, unknown>).tier, "local");
			assert.equal((req.body.metadata as Record<string, unknown>).modelId, "lmstudio/meta/muse-glimmer");
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});

	it("records a child bypass as not routed (#130)", async () => {
		const { url, server, requests } = await startMockLangFuseServer();
		try {
			const client = new LangFuseClient({
				enabled: true,
				provider: "langfuse",
				baseUrl: url,
				publicKey: "pk-test",
				secretKey: "sk-test",
			});

			await client.bypass({
				traceId: "session-1-bypass-123",
				modelId: "opencode-go/gpt-6-luna",
				kind: "subagent",
				reason: "subagent child launched on a non-cuttle model, so it never entered the router",
			});

			assert.equal(requests.length, 1);
			const req = requests[0] as { url: string; body: Record<string, unknown> };
			assert.equal(req.url, "/api/public/traces");
			assert.equal(req.body.name, "pi-cuttle child bypass");
			const metadata = req.body.metadata as Record<string, unknown>;
			assert.equal(metadata.routed, false, "a bypass must never look routed");
			assert.equal(metadata.kind, "subagent");
			assert.equal(metadata.isSubagent, true);
			assert.equal(metadata.modelId, "opencode-go/gpt-6-luna");
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});

	it("checks health", async () => {
		const { url, server } = await startMockLangFuseServer();
		try {
			const client = new LangFuseClient({
				enabled: true,
				provider: "langfuse",
				baseUrl: url,
				publicKey: "pk-test",
				secretKey: "sk-test",
			});
			const ok = await client.health();
			assert.equal(ok, true);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});

	it("reports unhealthy when server is down", async () => {
		const client = new LangFuseClient({
			enabled: true,
			provider: "langfuse",
			baseUrl: "http://127.0.0.1:1",
			publicKey: "pk-test",
			secretKey: "sk-test",
		});
		const ok = await client.health();
		assert.equal(ok, false);
	});

	it("ingests a score by trace id via POST /api/public/scores", async () => {
		const { url, server, requests } = await startMockLangFuseServer();
		try {
			const client = new LangFuseClient({
				enabled: true,
				provider: "langfuse",
				baseUrl: url,
				publicKey: "pk-test",
				secretKey: "sk-test",
			});
			await client.score({
				traceId: "trace-1",
				name: "flavor_compliance",
				value: false,
				dataType: "BOOLEAN",
			});

			assert.equal(requests.length, 1);
			const req = requests[0] as { method: string; url: string; headers: Record<string, string>; body: Record<string, unknown> };
			assert.equal(req.method, "POST");
			assert.equal(req.url, "/api/public/scores");
			assert.equal(req.body.traceId, "trace-1");
			assert.equal(req.body.name, "flavor_compliance");
			assert.equal(req.body.value, false);
			assert.equal(req.body.dataType, "BOOLEAN");
			assert.equal(req.headers.authorization, `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});
});
