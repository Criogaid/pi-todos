import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// These integration tests exercise the actual pinned host pipeline, not just execute().
import {
	NESTED_CALL_LIMITS,
	NestedToolCallRunner,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/nested-tool-calls.js";
import { wrapToolDefinition } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/tool-definition-wrapper.js";
import { runToolCall } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js";
import {
	createMockCtx,
	createMockPi,
	makeAssistantMessage,
	makeToolResult,
	makeUserMessage,
} from "../test/helpers/index.js";
import registerExtension from "./index.js";
import { isRecord } from "./model.js";
import { TASKS_SNAPSHOT_TYPE } from "./persistence.js";
import { getTaskState } from "./store.js";

const directories: string[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setup() {
	const directory = mkdtempSync(join(tmpdir(), "pi-task-replay-"));
	directories.push(directory);
	let manager = SessionManager.create(process.cwd(), directory);
	manager.appendMessage(makeUserMessage("Track work"));
	const ctx = () => ({ ...createMockCtx(), sessionManager: manager });
	function register() {
		const registration = createMockPi({
			appendEntry: (type, data) => {
				manager.appendCustomEntry(type, data);
			},
		});
		registerExtension(registration.pi);
		return registration;
	}
	let registration = register();
	async function emit(name: string, event: unknown) {
		for (const handler of registration.captured.events.get(name) ?? []) await handler(event, ctx());
	}
	await emit("session_start", {});
	const tools = () =>
		Array.from(registration.captured.tools.values(), (definition) => wrapToolDefinition(definition, ctx));
	function run(
		call: Parameters<typeof runToolCall>[0],
		signal?: AbortSignal,
		onUpdate?: Parameters<typeof runToolCall>[1]["onUpdate"],
	) {
		const available = tools();
		return runToolCall(call, {
			tools: available,
			assistantMessage: makeAssistantMessage(),
			context: { messages: [], tools: available },
			signal,
			onUpdate,
		});
	}
	let nextCall = 0;
	async function call(name: string, args: JsonObject = {}) {
		const id = `direct-${++nextCall}`;
		manager.appendMessage(makeAssistantMessage([name]));
		const outcome = await run({ type: "toolCall", id, name, arguments: args });
		await emit("tool_execution_end", {
			toolName: name,
			toolCallId: id,
			result: outcome.result,
			isError: outcome.isError,
		});
		manager.appendMessage(
			makeToolResult({ toolName: name, toolCallId: id, isError: outcome.isError, details: outcome.result.details }),
		);
		return outcome;
	}
	async function nested(calls: readonly { name: string; args: unknown }[], concurrent = false, wrapperError = false) {
		const id = `wrapper-${++nextCall}`;
		manager.appendMessage(makeAssistantMessage(["codemode"]));
		const runner = new NestedToolCallRunner({
			getTools: tools,
			isSequential: () => false,
			emit: async (event) => {
				await emit(event.type, event);
			},
			runToolCall: (toolCall, _parent, signal, onUpdate) => run(toolCall, signal, onUpdate),
		});
		const outcomes = [];
		if (concurrent)
			outcomes.push(...(await Promise.all(calls.map(({ name, args }) => runner.execute(id, name, args)))));
		else for (const { name, args } of calls) outcomes.push(await runner.execute(id, name, args));
		const nestedCalls = runner.takeRecord(id)?.calls;
		manager.appendMessage(
			makeToolResult({ toolName: "codemode", toolCallId: id, isError: wrapperError, nestedCalls }),
		);
		return { outcomes, nestedCalls };
	}
	async function reload() {
		const file = manager.getSessionFile();
		if (!file) throw new Error("session not persisted");
		await emit("session_shutdown", {});
		manager = SessionManager.open(file, directory);
		registration = register();
		await emit("session_start", {});
		return state();
	}
	const state = () => getTaskState(manager.getSessionId());
	return {
		call,
		nested,
		reload,
		state,
		emit,
		manager: () => manager,
		snapshotCount: () =>
			manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === TASKS_SNAPSHOT_TYPE)
				.length,
	};
}
function createdId(outcome: Awaited<ReturnType<typeof runToolCall>>): string {
	expect(outcome.isError).toBe(false);
	const output = outcome.result.structuredContent;
	if (!isRecord(output) || !isRecord(output.task) || typeof output.task.id !== "string")
		throw new Error("missing structured task id");
	return output.task.id;
}

describe("task persistence through the real Pi host", () => {
	it("creates, repairs and updates direct calls before restoring tasks from disk", async () => {
		const harness = await setup();
		const id = createdId(
			await harness.call("TaskCreate", {
				subject: "  Build  ",
				description: "Details",
				active_form: "Building",
				metadata: { keep: true, removed: null },
			}),
		);
		const update = await harness.call("TaskUpdate", { task_id: ` #${id} `, status: "in_progress", owner: "agent" });
		expect(update.isError).toBe(false);
		expect(update.result.structuredContent).toMatchObject({
			success: true,
			taskId: id,
			updatedFields: ["owner", "status"],
		});
		const get = await harness.call("TaskGet", { id: Number(id) });
		expect(get.isError).toBe(false);
		expect(get.result.structuredContent).toMatchObject({ task: { id, subject: "  Build  ", status: "in_progress" } });
		const before = structuredClone(harness.state());
		expect(before.tasks[0]).toMatchObject({ activeForm: "Building", metadata: { keep: true }, owner: "agent" });
		expect(await harness.reload()).toEqual(before);
	});

	it("runs TaskCreate and TaskUpdate as codemode subcalls with structured results", async () => {
		const harness = await setup();
		const create = await harness.nested([
			{ name: "TaskCreate", args: { subject: "Nested task", description: "Details" } },
		]);
		const id = createdId(create.outcomes[0]);
		const update = await harness.nested([
			{ name: "TaskUpdate", args: { id: Number(id), status: "completed" } },
			{ name: "TaskGet", args: { taskId: `#${id}` } },
			{ name: "TaskList", args: {} },
		]);
		expect(update.outcomes.every((outcome) => !outcome.isError)).toBe(true);
		expect(update.outcomes[0].result.structuredContent).toMatchObject({
			success: true,
			taskId: id,
			statusChange: { from: "pending", to: "completed" },
		});
		expect(harness.snapshotCount()).toBe(2);
		const before = structuredClone(harness.state());
		expect(await harness.reload()).toEqual(before);
	});

	it("preserves tasks when the host omits oversized nested arguments", async () => {
		const harness = await setup();
		const description = "x".repeat(NESTED_CALL_LIMITS.maxArgumentBytesPerCall + 1);
		const { outcomes, nestedCalls } = await harness.nested([
			{ name: "TaskCreate", args: { subject: "Large description", description } },
			{ name: "TaskUpdate", args: { taskId: "1", status: "completed" } },
		]);
		expect(outcomes.every((outcome) => !outcome.isError)).toBe(true);
		expect(nestedCalls?.calls[0]?.arguments).toBeUndefined();
		const restored = await harness.reload();
		expect(restored.highWaterMark).toBe(1);
		expect(restored.tasks[0]).toMatchObject({ description, status: "completed" });
	});

	it("preserves updates dropped from the host's nested-call record", async () => {
		const harness = await setup();
		const calls = Array.from({ length: NESTED_CALL_LIMITS.maxCalls + 1 }, (_, index) => ({
			name: "TaskCreate",
			args: { subject: `Task ${index}`, description: "" },
		}));
		const { outcomes, nestedCalls } = await harness.nested(calls);
		expect(outcomes.every((outcome) => !outcome.isError)).toBe(true);
		expect(nestedCalls?.calls.length).toBeLessThan(outcomes.length);
		const restored = await harness.reload();
		expect(restored.tasks).toHaveLength(calls.length);
		expect(restored.highWaterMark).toBe(calls.length);
	});

	it("allocates unique ids for concurrent nested creates", async () => {
		const harness = await setup();
		const { outcomes } = await harness.nested(
			["First", "Second", "Third", "Fourth"].map((subject) => ({
				name: "TaskCreate",
				args: { subject, description: "" },
			})),
			true,
		);
		const ids = outcomes.map(createdId);
		expect(new Set(ids).size).toBe(4);
		expect(harness.state().highWaterMark).toBe(4);
		expect((await harness.reload()).tasks.map((task) => task.id)).toEqual(ids);
	});

	it("does not write snapshots for reads, missing updates or invalid arguments", async () => {
		const harness = await setup();
		await harness.call("TaskCreate", { subject: "Task", description: "" });
		const before = structuredClone(harness.state());
		await harness.call("TaskGet", { taskId: "1" });
		await harness.call("TaskList");
		const missing = await harness.call("TaskUpdate", { taskId: "99", status: "completed" });
		expect(missing.isError).toBe(false);
		expect(missing.result.structuredContent).toMatchObject({ success: false, error: "Task not found" });
		const invalid = await harness.call("TaskUpdate", { taskId: "1", status: "invalid" });
		expect(invalid.isError).toBe(true);
		expect(harness.snapshotCount()).toBe(1);
		expect(await harness.reload()).toEqual(before);
	});

	it("keeps a successful nested write if the wrapper subsequently fails", async () => {
		const harness = await setup();
		const { outcomes } = await harness.nested(
			[{ name: "TaskCreate", args: { subject: "Saved", description: "" } }],
			false,
			true,
		);
		createdId(outcomes[0]);
		expect((await harness.reload()).tasks[0].subject).toBe("Saved");
	});

	it("restores deletion cleanup and retains the high-water mark after reload", async () => {
		const harness = await setup();
		await harness.call("TaskCreate", { subject: "First", description: "" });
		await harness.call("TaskCreate", { subject: "Second", description: "" });
		await harness.call("TaskUpdate", { taskId: "1", addBlocks: [2] });
		await harness.call("TaskUpdate", { taskId: "1", status: "deleted" });
		const restored = await harness.reload();
		expect(restored.tasks.map((task) => task.id)).toEqual(["2"]);
		expect(restored.tasks[0].blockedBy).toEqual([]);
		expect(restored.highWaterMark).toBe(2);
		expect(createdId(await harness.call("TaskCreate", { subject: "Third", description: "" }))).toBe("3");
	});

	it("persists automatic clearing without reusing completed task ids", async () => {
		const harness = await setup();
		await harness.call("TaskCreate", { subject: "First", description: "" });
		await harness.call("TaskUpdate", { taskId: "1", status: "completed" });
		await harness.emit("agent_start", {});
		const cleared = await harness.reload();
		expect(cleared.tasks).toEqual([]);
		expect(cleared.highWaterMark).toBe(1);
		expect(createdId(await harness.call("TaskCreate", { subject: "Next", description: "" }))).toBe("2");
	});

	it("restores the selected branch and survives a real compaction entry", async () => {
		const harness = await setup();
		await harness.call("TaskCreate", { subject: "First", description: "" });
		const firstLeaf = harness.manager().getLeafId();
		if (!firstLeaf) throw new Error("missing branch point");
		await harness.call("TaskCreate", { subject: "Abandoned", description: "" });
		harness.manager().branch(firstLeaf);
		await harness.emit("session_tree", {});
		expect(harness.state().tasks.map((task) => task.subject)).toEqual(["First"]);
		expect(harness.state().highWaterMark).toBe(1);
		await harness.call("TaskCreate", { subject: "New branch", description: "" });
		const before = structuredClone(harness.state());
		harness.manager().appendCompaction("Summary", harness.manager().getLeafId(), 100);
		await harness.emit("session_compact", {});
		expect(harness.state()).toEqual(before);
		expect(await harness.reload()).toEqual(before);
	});

	it("keeps disk snapshots isolated across two sessions", async () => {
		const first = await setup();
		const second = await setup();
		await first.call("TaskCreate", { subject: "First session", description: "" });
		await second.call("TaskCreate", { subject: "Second session", description: "" });
		expect((await first.reload()).tasks[0].subject).toBe("First session");
		expect((await second.reload()).tasks[0].subject).toBe("Second session");
		expect(first.state().tasks[0].subject).toBe("First session");
	});
});
