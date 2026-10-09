import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Exercise the pinned dev host's actual execution pipeline and bounded recorder.
import {
	NESTED_CALL_LIMITS,
	NestedToolCallRunner,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/nested-tool-calls.js";
import { wrapToolDefinition } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/tool-definition-wrapper.js";
import { runToolCall } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js";
import { createMockCtx, createMockPi, makeToolResult, makeUserMessage } from "../test/helpers/index.js";
import registerExtension from "./index.js";
import { MAX_TODOS, type Todo } from "./model.js";
import { getTodos } from "./store.js";

const assistantMessage: AssistantMessage = {
	role: "assistant",
	content: [],
	api: "openai-completions",
	provider: "openai",
	model: "unused",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
	timestamp: 0,
};
const oldTodos: Todo[] = [{ content: "Old work", status: "pending" }];
const done: Todo[] = [{ content: "Finished", status: "completed" }];
const testDirectories: string[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	for (const directory of testDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setup(persistenceError?: Error) {
	const directory = mkdtempSync(join(tmpdir(), "pi-todos-replay-"));
	testDirectories.push(directory);
	let manager = SessionManager.create(process.cwd(), directory);
	manager.appendMessage(makeUserMessage("Track work"));
	const initialId = manager.appendMessage(makeToolResult({ toolName: "todo", details: { todos: oldTodos } }));
	const ctx = () => ({ ...createMockCtx(), sessionManager: manager });
	const register = () => {
		const registration = createMockPi({
			appendEntry: (customType, data) => {
				if (persistenceError) throw persistenceError;
				manager.appendCustomEntry(customType, data);
			},
		});
		registerExtension(registration.pi);
		return registration;
	};
	let registration = register();
	async function emit(name: string, event: unknown) {
		for (const handler of registration.captured.events.get(name) ?? []) await handler(event, ctx());
	}
	await emit("session_start", {});

	let nextDirect = 0;
	async function executeDirect(todos: Todo[]) {
		const definition = registration.captured.tools.get("todo");
		if (!definition) throw new Error("todo tool not registered");
		const toolCallId = `direct-${++nextDirect}`;
		const result = await definition.execute(toolCallId, { todos }, undefined, undefined, ctx());
		await emit("tool_execution_end", { toolCallId, toolName: "todo", result, isError: false });
		manager.appendMessage(makeToolResult({ toolCallId, toolName: "todo", details: result.details }));
	}

	let nextWrapper = 0;
	async function executeWrapper(inputs: readonly unknown[], wrapperError = false) {
		const wrapperId = `wrapper-${++nextWrapper}`;
		manager.appendMessage(assistantMessage);
		const definition = registration.captured.tools.get("todo");
		if (!definition) throw new Error("todo tool not registered");
		const wrapped = wrapToolDefinition(definition, ctx);
		const runner = new NestedToolCallRunner({
			getTools: () => [wrapped],
			isSequential: () => false,
			emit: async (event) => {
				await emit(event.type, event);
			},
			runToolCall: (call, _parent, signal, onUpdate) =>
				runToolCall(call, {
					tools: [wrapped],
					assistantMessage,
					context: { messages: [], tools: [wrapped] },
					signal,
					onUpdate,
				}),
		});
		const outcomes = [];
		for (const input of inputs) outcomes.push(await runner.execute(wrapperId, "todo", input));
		const nestedCalls = runner.takeRecord(wrapperId)?.calls;
		manager.appendMessage(
			makeToolResult({ toolName: "codemode", toolCallId: wrapperId, isError: wrapperError, nestedCalls }),
		);
		return { outcomes, nestedCalls };
	}
	async function reload() {
		const file = manager.getSessionFile();
		if (!file) throw new Error("session was not persisted");
		await emit("session_shutdown", {});
		manager = SessionManager.open(file, directory);
		registration = register();
		await emit("session_start", {});
		return getTodos(manager.getSessionId());
	}
	function expectLive(expected: readonly Todo[]) {
		expect(getTodos(manager.getSessionId())).toEqual(expected);
	}
	return {
		executeWrapper,
		executeDirect,
		reload,
		expectLive,
		initialId,
		branch: (id: string) => manager.branch(id),
		emit,
	};
}

interface InputCase {
	name: string;
	input: unknown;
	expected: Todo[];
}
const inputCases: InputCase[] = [
	{ name: "normal strings", input: { todos: done }, expected: done },
	{
		name: "numeric content",
		input: { todos: [{ content: 42, status: "completed" }] },
		expected: [{ content: "42", status: "completed" }],
	},
	{
		name: "boolean content",
		input: { todos: [{ content: false, status: "completed" }] },
		expected: [{ content: "false", status: "completed" }],
	},
	{
		name: "numeric activeForm",
		input: { todos: [{ content: "Task", status: "in_progress", activeForm: 2 }] },
		expected: [{ content: "Task", status: "in_progress", activeForm: "2" }],
	},
	{
		name: "object container",
		input: { todos: { content: "Task", status: "completed" } },
		expected: [{ content: "Task", status: "completed" }],
	},
	{
		name: "trimmed fields",
		input: { todos: [{ content: " Task ", status: "in_progress", activeForm: " Working " }] },
		expected: [{ content: "Task", status: "in_progress", activeForm: "Working" }],
	},
	{
		name: "blank activeForm",
		input: { todos: [{ content: "Task", status: "completed", activeForm: "   " }] },
		expected: [{ content: "Task", status: "completed" }],
	},
];

describe("nested todo persistence through the Pi host", () => {
	it.each(inputCases)("restores the executed snapshot after disk reload: $name", async ({ input, expected }) => {
		const harness = await setup();
		const { outcomes } = await harness.executeWrapper([input]);
		expect(outcomes[0].isError).toBe(false);
		harness.expectLive(expected);
		expect(await harness.reload()).toEqual(expected);
	});

	it("restores a valid list when the host omits oversized arguments", async () => {
		const harness = await setup();
		const contentBytes = Math.ceil(NESTED_CALL_LIMITS.maxArgumentBytesPerCall / MAX_TODOS);
		const todos: Todo[] = Array.from({ length: MAX_TODOS }, (_, index) => ({
			content: `Task ${index}: ${"x".repeat(contentBytes)}`,
			status: "completed",
		}));
		const { outcomes, nestedCalls } = await harness.executeWrapper([{ todos }]);
		expect(outcomes[0].isError).toBe(false);
		expect(nestedCalls?.calls[0]?.arguments).toBeUndefined();
		harness.expectLive(todos);
		const restored = await harness.reload();
		expect(restored).toHaveLength(todos.length);
		expect(restored).toEqual(todos);
	});

	it("restores the final update when earlier calls exhaust the total argument budget", async () => {
		const harness = await setup();
		const contentBytes = Math.floor(NESTED_CALL_LIMITS.maxArgumentBytesPerCall / 2);
		const repeats = Math.ceil(NESTED_CALL_LIMITS.maxArgumentBytesTotal / contentBytes);
		const input = { todos: [{ content: "x".repeat(contentBytes), status: "pending" }] };
		const finalTodos: Todo[] = [{ content: "x".repeat(contentBytes), status: "completed" }];
		const { outcomes, nestedCalls } = await harness.executeWrapper([
			...Array.from({ length: repeats }, () => input),
			{ todos: finalTodos },
		]);
		expect(outcomes.every((outcome) => !outcome.isError)).toBe(true);
		expect(nestedCalls?.calls.at(-1)?.arguments).toBeUndefined();
		harness.expectLive(finalTodos);
		expect((await harness.reload()).map((todo) => todo.status)).toEqual(["completed"]);
	});

	it("restores the final update when the host drops calls beyond its count limit", async () => {
		const harness = await setup();
		const inputs = [
			...Array.from({ length: NESTED_CALL_LIMITS.maxCalls }, () => ({ todos: oldTodos })),
			{ todos: done },
		];
		const { outcomes, nestedCalls } = await harness.executeWrapper(inputs);
		expect(outcomes.every((outcome) => !outcome.isError)).toBe(true);
		expect(nestedCalls?.calls.length).toBeLessThan(outcomes.length);
		harness.expectLive(done);
		expect(await harness.reload()).toEqual(done);
	});

	it("keeps a successful nested update when its wrapper later fails", async () => {
		const harness = await setup();
		await harness.executeWrapper([{ todos: done }], true);
		harness.expectLive(done);
		expect(await harness.reload()).toEqual(done);
	});

	it("does not persist a rejected replacement over a successful update", async () => {
		const harness = await setup();
		const { outcomes } = await harness.executeWrapper([
			{ todos: done },
			{ todos: [{ content: " ", status: "pending" }] },
		]);
		expect(outcomes.map((outcome) => outcome.isError)).toEqual([false, true]);
		harness.expectLive(done);
		expect(await harness.reload()).toEqual(done);
	});

	it("restores only the selected branch during navigation and compaction", async () => {
		const harness = await setup();
		const completedId = await harness.executeWrapper([{ todos: done }]);
		expect(completedId.outcomes[0].isError).toBe(false);
		harness.branch(harness.initialId);
		await harness.emit("session_tree", {});
		harness.expectLive(oldTodos);
		await harness.executeWrapper([{ todos: [] }]);
		await harness.emit("session_compact", {});
		harness.expectLive([]);
		expect(await harness.reload()).toEqual([]);
	});
});

describe("snapshot write boundaries", () => {
	it("leaves the live and saved list untouched when persistence fails", async () => {
		const harness = await setup(new Error("Session storage unavailable"));
		const { outcomes } = await harness.executeWrapper([{ todos: done }]);
		expect(outcomes[0].isError).toBe(true);
		harness.expectLive(oldTodos);
		expect(await harness.reload()).toEqual(oldTodos);
	});

	it("restores a direct update after a nested update", async () => {
		const harness = await setup();
		await harness.executeWrapper([{ todos: done }]);
		await harness.executeDirect(oldTodos);
		harness.expectLive(oldTodos);
		expect(await harness.reload()).toEqual(oldTodos);
	});

	it("restores a nested clear after a direct update", async () => {
		const harness = await setup();
		await harness.executeDirect(done);
		await harness.executeWrapper([{ todos: [] }]);
		harness.expectLive([]);
		expect(await harness.reload()).toEqual([]);
	});

	it("keeps persisted snapshots isolated between sessions", async () => {
		const first = await setup();
		const second = await setup();
		await first.executeWrapper([{ todos: done }]);
		await second.executeWrapper([{ todos: [] }]);
		first.expectLive(done);
		second.expectLive([]);
		expect(await first.reload()).toEqual(done);
		second.expectLive([]);
		expect(await second.reload()).toEqual([]);
		first.expectLive(done);
	});
});
