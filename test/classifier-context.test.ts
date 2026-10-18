import assert from "node:assert/strict";
import { test } from "node:test";

import { buildClassifierContext } from "../src/classifier-context.ts";
import type { Message } from "@earendil-works/pi-ai";

function message(role: string, content: unknown, extra: Record<string, unknown> = {}): Message {
	return { role, content, ...extra } as unknown as Message;
}

const options = { budget: 1000, window: 3 };

test("empty and malformed sessions return a stable non-empty sentinel", () => {
	assert.equal(buildClassifierContext([], options), "[new session]");
	assert.equal(buildClassifierContext(null as unknown as readonly Message[], options), "[new session]");
	assert.equal(buildClassifierContext([null as unknown as Message], options), "[new session]");
	assert.equal(buildClassifierContext([message("unrecognized", "ignored")], options), "[new session]");
});

test("short sessions include session scalars and role-tagged user and assistant text", () => {
	const context = buildClassifierContext([
		message("user", "Please review this function."),
		message("assistant", [{ type: "text", text: "I will inspect it." }]),
	], options);

	assert.match(context, /^\[session: 1 turns, ~\d+ chars \(~\d+ tokens\)\]/);
	assert.ok(context.includes("[assistant]\nI will inspect it."));
	assert.ok(context.endsWith("[user]\nPlease review this function."));
});

test("tight budgets drop oldest assistant turns first and preserve the latest user", () => {
	const context = buildClassifierContext([
		message("assistant", "oldest assistant turn"),
		message("assistant", "newer assistant turn"),
		message("user", "latest request stays"),
		message("assistant", "most recent assistant turn"),
	], { budget: 85, window: 3 });

	assert.ok(context.length <= 85);
	assert.ok(context.includes("most recent assistant turn"));
	assert.ok(context.endsWith("[user]\nlatest request stays"));
	assert.ok(!context.includes("oldest assistant turn"));
});

test("a latest user message larger than budget is returned truncated to the budget", () => {
	const latest = "0123456789abcdefghijklmnopqrstuvwxyz";
	const context = buildClassifierContext([
		message("assistant", "history that must be dropped"),
		message("user", latest),
	], { budget: 12, window: 3 });

	assert.equal(context, latest.slice(0, 12));
	assert.equal(context.length, 12);
});

test("mixed content includes text only and applies the default per-assistant cap", () => {
	const longAssistantText = "a".repeat(1600);
	const context = buildClassifierContext([
		message("user", [
			{ type: "text", text: "Read this" },
			{ type: "image", data: "private-image-data", mimeType: "image/png" },
			{ type: "text", text: "and explain it." },
		]),
		message("assistant", [
			{ type: "thinking", thinking: "internal thought" },
			{ type: "text", text: longAssistantText },
			{ type: "image", data: "binary-image-data", mimeType: "image/png" },
		]),
	], { ...options, budget: 2200 });

	assert.ok(context.includes("[assistant]\n" + "a".repeat(1500)));
	assert.ok(context.endsWith("[user]\nRead this\nand explain it."));
	assert.ok(!context.includes("private-image-data"));
	assert.ok(!context.includes("binary-image-data"));
	assert.ok(!context.includes("internal thought"));
});

test("tool-heavy sessions digest mutating calls without rendering tool-result prose", () => {
	const context = buildClassifierContext([
		message("assistant", [
			{ type: "toolCall", id: "1", name: "edit", arguments: {} },
			{ type: "toolCall", id: "2", name: "bash", arguments: {} },
		]),
		message("toolResult", [{ type: "text", text: "file updated" }, { type: "image", data: "result-bytes", mimeType: "image/png" }], { toolName: "edit" }),
		message("toolResult", [{ type: "text", text: "command finished" }], { toolName: "bash" }),
		message("toolResult", [{ type: "text", text: "saved" }], { toolName: "write" }),
		message("user", "Did it work?"),
	], options);

	assert.ok(context.includes("[tools: edit=1 write=1 bash=1]"));
	assert.ok(!context.includes("file updated"), "tool results contribute to metadata, not prose turns");
	assert.ok(!context.includes("result-bytes"));
});

test("context formatting and truncation are deterministic", () => {
	const messages = [
		message("user", "First request"),
		message("assistant", [{ type: "text", text: "A".repeat(70) }]),
		message("user", "Follow-up"),
	];
	const settings = { budget: 60, window: 2 };
	assert.equal(buildClassifierContext(messages, settings), buildClassifierContext(messages, settings));
});
