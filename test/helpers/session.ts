import type { Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export function makeUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

export interface ToolResultInput {
	toolCallId?: string;
	toolName: string;
	text?: string;
	details?: unknown;
	isError?: boolean;
	nestedCalls?: unknown;
}

export function makeToolResult(input: ToolResultInput): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: input.toolCallId ?? `call-${input.toolName}-${Date.now()}`,
		toolName: input.toolName,
		content: input.text ? [{ type: "text", text: input.text }] : [],
		details: input.details,
		nestedCalls: input.nestedCalls,
		isError: input.isError ?? false,
		timestamp: Date.now(),
	} as unknown as ToolResultMessage;
}

export function makeMessageEntry(message: Message): SessionEntry {
	return { type: "message", message } as unknown as SessionEntry;
}

export function buildSessionEntries(messages: Message[]): SessionEntry[] {
	return messages.map(makeMessageEntry);
}
