import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Task, TaskState } from "../../src/model.js";
import { snapshotOf, TASKS_SNAPSHOT_TYPE } from "../../src/persistence.js";

export function makeTask(id = "1", overrides: Partial<Omit<Task, "id">> = {}): Task {
	return {
		id,
		subject: `Task ${id}`,
		description: `Details ${id}`,
		status: "pending",
		blocks: [],
		blockedBy: [],
		...overrides,
	};
}

export function makeState(
	tasks: readonly Task[] = [],
	highWaterMark = Math.max(0, ...tasks.map((task) => Number(task.id))),
): TaskState {
	return { tasks, highWaterMark };
}

export function makeSnapshotEntry(state: TaskState, toolCallId?: string): SessionEntry {
	return {
		type: "custom",
		id: `snapshot-${state.highWaterMark}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType: TASKS_SNAPSHOT_TYPE,
		data: snapshotOf(state, toolCallId),
	};
}

export function makeAssistantMessage(toolNames: readonly string[] = []): AssistantMessage {
	return {
		role: "assistant",
		content: toolNames.map((name, index) => ({ type: "toolCall", id: `call-${index}`, name, arguments: {} })),
		api: "openai-completions",
		provider: "openai",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: toolNames.length ? "toolUse" : "stop",
		timestamp: 0,
	};
}
