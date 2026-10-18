import type { Message } from "@earendil-works/pi-ai";

export interface ClassifierContextOptions {
	budget: number;
	window: number;
	assistantCap?: number;
}

const DEFAULT_ASSISTANT_CAP = 1500;
const NEW_SESSION = "[new session]";
const MUTATING_TOOLS = ["edit", "write", "bash"] as const;
type MutatingTool = typeof MUTATING_TOOLS[number];

/** Build a bounded, text-only classifier signal from a conversation. */
export function buildClassifierContext(
	messages: readonly Message[],
	options: ClassifierContextOptions,
): string {
	try {
		if (!Array.isArray(messages) || messages.length === 0 || !options || typeof options !== "object") {
			return NEW_SESSION;
		}

		const budget = Math.max(1, nonNegativeInteger(options.budget, 8000));
		const window = nonNegativeInteger(options.window, 0);
		const assistantCap = nonNegativeInteger(options.assistantCap, DEFAULT_ASSISTANT_CAP);
		const stats = collectStats(messages);
		if (!stats.hasMessages) return NEW_SESSION;
		let latestUserIndex = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]?.role === "user") {
				latestUserIndex = i;
				break;
			}
		}

		const latestUserText = latestUserIndex === -1 ? "" : textContent(messages[latestUserIndex]?.content, budget);
		// The user message alone owns the entire budget; omit formatting rather than lose user text.
		if (latestUserIndex !== -1 && textLength(messages[latestUserIndex]?.content) > budget) {
			return latestUserText.slice(0, budget);
		}

		let userBlock = "";
		if (latestUserIndex !== -1) {
			const taggedUser = `[user]\n${latestUserText}`;
			userBlock = taggedUser.length <= budget ? taggedUser : latestUserText;
		}

		let remaining = budget - userBlock.length;
		const newestAssistantBlocks: string[] = [];
		const separatorBeforeUser = userBlock ? "\n\n" : "";
		let assistantTurns = 0;
		for (let i = messages.length - 1; i >= 0 && assistantTurns < window; i--) {
			const message = messages[i];
			if (message?.role !== "assistant") continue;
			assistantTurns++;
			const prefix = "\n\n[assistant]\n";
			const separatorCost = newestAssistantBlocks.length === 0 ? separatorBeforeUser.length : 0;
			if (remaining < prefix.length + separatorCost) break;

			const contentBudget = remaining - prefix.length - separatorCost;
			const cappedContentLength = Math.min(textLength(message.content), assistantCap);
			if (newestAssistantBlocks.length > 0 && cappedContentLength > contentBudget) break;
			const content = textContent(message.content, Math.min(assistantCap, contentBudget));
			const block = `${prefix}${content}`;
			newestAssistantBlocks.push(block);
			remaining -= block.length + separatorCost;
			if (cappedContentLength > contentBudget) break;
		}

		const assistantBlocks = newestAssistantBlocks.reverse();
		let context = `${assistantBlocks.join("")}${assistantBlocks.length ? separatorBeforeUser : ""}${userBlock}`;
		const toolLine = `[tools: ${MUTATING_TOOLS.map((tool) => `${tool}=${stats.tools[tool]}`).join(" ")}]`;
		const sessionLine = `[session: ${stats.turns} turns, ~${stats.characters} chars (~${Math.ceil(stats.characters / 4)} tokens)]`;
		for (const line of [toolLine, sessionLine]) {
			const addition = context ? `${line}\n${context}` : line;
			if (addition.length > budget) break;
			context = addition;
		}

		if (context.length > 0) return context;
		return NEW_SESSION.slice(0, Math.max(1, budget));
	} catch {
		// Runtime callers can supply malformed or partially constructed message data.
		return NEW_SESSION;
	}
}

function nonNegativeInteger(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}

function collectStats(messages: readonly Message[]): {
	hasMessages: boolean;
	turns: number;
	characters: number;
	tools: Record<MutatingTool, number>;
} {
	let hasMessages = false;
	let turns = 0;
	let characters = 0;
	const calls: Record<MutatingTool, number> = { edit: 0, write: 0, bash: 0 };
	const results: Record<MutatingTool, number> = { edit: 0, write: 0, bash: 0 };

	for (const value of messages as readonly unknown[]) {
		if (!value || typeof value !== "object") continue;
		const message = value as Record<string, unknown>;
		if (message.role === "system" || message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
			hasMessages = true;
		}
		if (message.role === "user") turns++;
		characters = addSaturated(characters, textLength(message.content));

		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!block || typeof block !== "object") continue;
				const call = block as Record<string, unknown>;
				if (call.type === "toolCall") increment(calls, call.name);
			}
		}
		if (message.role === "toolResult") increment(results, message.toolName);
	}

	const tools = { ...calls };
	for (const tool of MUTATING_TOOLS) {
		if (tools[tool] === 0) tools[tool] = results[tool];
	}
	return { hasMessages, turns, characters, tools };
}

function increment(counts: Record<MutatingTool, number>, name: unknown): void {
	if (typeof name !== "string" || !Object.hasOwn(counts, name)) return;
	const tool = name as MutatingTool;
	counts[tool] = addSaturated(counts[tool], 1);
}

function addSaturated(left: number, right: number): number {
	return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

/** Count text without joining message blocks into an unbounded intermediate string. */
function textLength(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let length = 0;
	let foundText = false;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const candidate = block as Record<string, unknown>;
		if (candidate.type === "text" && typeof candidate.text === "string" && candidate.text.length > 0) {
			if (foundText) length = addSaturated(length, 1);
			length = addSaturated(length, candidate.text.length);
			foundText = true;
		}
	}
	return length;
}

/** Extract at most `limit` text characters, ignoring images and all other content blocks. */
function textContent(content: unknown, limit: number): string {
	if (limit <= 0) return "";
	if (typeof content === "string") return content.slice(0, limit);
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	let length = 0;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const candidate = block as Record<string, unknown>;
		if (candidate.type !== "text" || typeof candidate.text !== "string" || candidate.text.length === 0) continue;
		const separatorLength = parts.length > 0 ? 1 : 0;
		const available = limit - length - separatorLength;
		if (available <= 0) break;
		if (separatorLength) {
			parts.push("\n");
			length++;
		}
		const text = candidate.text.slice(0, available);
		parts.push(text);
		length += text.length;
		if (text.length < candidate.text.length) break;
	}
	return parts.join("");
}
