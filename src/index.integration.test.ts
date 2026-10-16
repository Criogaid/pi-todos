import type { ContextEvent, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMockCtx,
	createMockPi,
	makeAssistantMessage,
	makeSnapshotEntry,
	makeState,
	makeTask,
	makeToolResult,
	makeUserMessage,
} from "../test/helpers/index.js";
import * as config from "./config.js";
import { buildTaskContext, TASK_CONTEXT_TYPE } from "./context.js";
import registerExtension, { PREWARM_DELAY_MS } from "./index.js";
import { isRecord, type TaskState } from "./model.js";
import * as overlayModule from "./overlay.js";
import { getForeground, getForegroundState, getTaskState, setTaskState } from "./store.js";

const pending = () => makeState([makeTask("1", { status: "in_progress", progress: "Next: run tests" })]);
const branch = (state: TaskState) => [makeSnapshotEntry(state)];
function setup(importer = vi.fn(async () => overlayModule)) {
	const { pi, captured } = createMockPi();
	registerExtension(pi, importer);
	async function emit(name: string, event: unknown, ctx: ExtensionToolContext) {
		const results = [];
		for (const handler of captured.events.get(name) ?? []) results.push(await handler(event, ctx));
		return results;
	}
	async function context(
		ctx: ExtensionToolContext,
		original: ContextEvent["messages"] = [makeUserMessage("Continue")],
	) {
		const [result] = await emit("context", { messages: original }, ctx);
		if (result === undefined) return [];
		if (!isRecord(result) || !Array.isArray(result.messages)) throw new Error("invalid context result");
		expect(
			result.messages.filter((message) => !isRecord(message) || message.customType !== TASK_CONTEXT_TYPE),
		).toEqual(original);
		return result.messages.filter((message) => isRecord(message) && message.customType === TASK_CONTEXT_TYPE);
	}
	async function write(ctx: ExtensionToolContext, input: unknown) {
		const tool = captured.tools.get("TaskWrite");
		if (!tool?.prepareArguments) throw new Error("missing tool");
		const result = await tool.execute("write", tool.prepareArguments(input), undefined, undefined, ctx);
		await emit("tool_execution_end", { toolName: "TaskWrite", result, isError: result.isError }, ctx);
		return result;
	}
	return { pi, captured, importer, emit, context, write };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});
describe("session lifecycle", () => {
	it("isolates foreground, child, and headless task states", async () => {
		const h = setup();
		const parent = createMockCtx({ sessionId: "parent", hasUI: true, branch: branch(pending()) });
		const child = createMockCtx({ sessionId: "child", branch: branch(makeState([makeTask("5")])) });
		await h.emit("session_start", {}, child);
		expect(getForeground()).toBeUndefined();
		await h.emit("session_start", {}, parent);
		await h.write(child, { operations: [{ action: "update", id: "5", set: { progress: "Child only" } }] });
		expect(getForegroundState()).toEqual(pending());
		expect(JSON.stringify(await h.context(parent))).not.toContain("Child only");
		expect(child.ui.setWidget).not.toHaveBeenCalled();
		await h.emit("session_shutdown", {}, child);
		expect(getForeground()).toBe("parent");
		await h.emit("session_shutdown", {}, parent);
		expect(getForeground()).toBeUndefined();
	});
	it("restores on compaction and tree navigation and blocks old snapshots", async () => {
		const h = setup();
		const ctx = createMockCtx({ branch: branch(pending()) });
		await h.emit("session_start", {}, ctx);
		const next = makeState([makeTask("5")], 9);
		vi.mocked(ctx.sessionManager.getBranch).mockReturnValue(branch(next));
		await h.emit("session_compact", {}, ctx);
		expect(getTaskState("test-session")).toEqual(next);
		const old = { ...makeSnapshotEntry(next), data: { version: 1 } };
		vi.mocked(ctx.sessionManager.getBranch).mockReturnValue([old]);
		await expect(h.emit("session_tree", {}, ctx)).rejects.toThrow();
		const result = await h.write(ctx, { operations: [{ action: "delete", id: "5" }] });
		expect(result.isError).toBe(true);
		expect(h.pi.appendEntry).not.toHaveBeenCalled();
		vi.mocked(ctx.sessionManager.getBranch).mockReturnValue(branch(next));
		await h.emit("session_tree", {}, ctx);
		expect(getTaskState("test-session")).toEqual(next);
	});
	it("retains completed work on run start and reopens it", async () => {
		const h = setup();
		const done = makeState([makeTask("1", { status: "completed" })]);
		const ctx = createMockCtx({ hasUI: true, branch: branch(done) });
		await h.emit("session_start", {}, ctx);
		await h.emit("agent_start", {}, ctx);
		expect(getTaskState("test-session")).toEqual(done);
		expect(ctx.ui.setWidget).not.toHaveBeenCalled();
		await h.write(ctx, { operations: [{ action: "update", id: "1", set: { status: "in_progress" } }] });
		expect(ctx.ui.setWidget).toHaveBeenCalled();
	});
});
describe("carried-over task context", () => {
	const summary = { role: "compactionSummary" as const, summary: "Earlier work", tokensBefore: 1000, timestamp: 0 };
	function view(state: TaskState, timestamp = Date.parse("2026-01-01T00:00:00.000Z")) {
		return {
			role: "custom",
			customType: TASK_CONTEXT_TYPE,
			display: false,
			content: buildTaskContext(state),
			timestamp,
		};
	}
	it("returns undefined while the snapshot's TaskWrite result is visible", async () => {
		const h = setup();
		const ctx = createMockCtx({ branch: [makeSnapshotEntry(pending(), "write")] });
		await h.emit("session_start", {}, ctx);
		const messages = [makeUserMessage("Continue"), makeToolResult({ toolName: "TaskWrite", toolCallId: "write" })];
		expect(await h.emit("context", { messages }, ctx)).toEqual([undefined]);
	});
	it.each([false, true])(
		"does not inject nested writes while their outer results are visible, including failures: %s",
		async (isError) => {
			const h = setup();
			const first = makeSnapshotEntry(pending(), "wrapper/1");
			const ctx = createMockCtx({ branch: [first] });
			await h.emit("session_start", {}, ctx);
			const messages = [makeToolResult({ toolName: "codemode", toolCallId: "wrapper", isError })];
			expect(await h.emit("context", { messages }, ctx)).toEqual([undefined]);
			vi.mocked(ctx.sessionManager.getBranch).mockReturnValue([
				first,
				makeSnapshotEntry(makeState([makeTask("1", { progress: "Updated" })]), "next-wrapper/1/2"),
			]);
			messages.push(makeToolResult({ toolName: "wrapper", toolCallId: "next-wrapper", isError }));
			expect(await h.emit("context", { messages }, ctx)).toEqual([undefined]);
		},
	);
	it("keeps the compacted baseline fixed through nested writes and restores them after another compaction", async () => {
		const h = setup();
		const hidden = makeSnapshotEntry(pending(), "old-wrapper/1");
		const ctx = createMockCtx({ branch: [hidden] });
		await h.emit("session_start", {}, ctx);
		const messages: ContextEvent["messages"] = [summary, makeUserMessage("Continue")];
		expect(await h.emit("context", { messages }, ctx)).toEqual([
			{ messages: [summary, view(pending()), messages[1]] },
		]);
		const updated = makeState([makeTask("1", { status: "in_progress", progress: "Nested checkpoint" })]);
		vi.mocked(ctx.sessionManager.getBranch).mockReturnValue([hidden, makeSnapshotEntry(updated, "wrapper/1")]);
		messages.push(
			makeToolResult({ toolName: "codemode", toolCallId: "wrapper", nestedCalls: { calls: [], complete: false } }),
		);
		expect(await h.emit("context", { messages }, ctx)).toEqual([
			{ messages: [summary, view(pending()), ...messages.slice(1)] },
		]);
		await h.emit("session_compact", {}, ctx);
		expect(await h.context(ctx, [summary, makeUserMessage("Continue again")])).toEqual([view(updated)]);
	});
	it("inserts the hidden snapshot immediately after the compaction summary and survives a non-task round trip", async () => {
		const h = setup();
		const snapshot = makeSnapshotEntry(pending(), "hidden-write");
		const ctx = createMockCtx({ branch: [snapshot] });
		await h.emit("session_start", {}, ctx);
		await h.emit("session_compact", {}, ctx);
		const messages: ContextEvent["messages"] = [summary, makeUserMessage("Continue")];
		expect(await h.emit("context", { messages }, ctx)).toEqual([
			{ messages: [summary, view(pending()), messages[1]] },
		]);
		await h.emit("message_end", { message: makeAssistantMessage(["read"]) }, ctx);
		await h.emit("tool_execution_end", { toolName: "read", isError: false }, ctx);
		const next = [...messages, makeAssistantMessage(["read"]), makeToolResult({ toolName: "read" })];
		expect(await h.emit("context", { messages: next }, ctx)).toEqual([
			{ messages: [summary, view(pending()), ...next.slice(1)] },
		]);
		expect(h.pi.appendEntry).not.toHaveBeenCalled();
	});
	it("keeps the injected prefix identical as visible assistant and TaskWrite results are appended", async () => {
		const h = setup();
		const nextState = makeState([makeTask("1", { status: "in_progress", progress: "Tests passed" })]);
		const ctx = createMockCtx({
			branch: [makeSnapshotEntry(pending(), "hidden"), makeSnapshotEntry(nextState, "visible")],
		});
		await h.emit("session_start", {}, ctx);
		const messages: ContextEvent["messages"] = [
			summary,
			makeUserMessage("Continue"),
			makeToolResult({ toolName: "TaskWrite", toolCallId: "visible" }),
		];
		const [first] = await h.emit("context", { messages }, ctx);
		expect(first).toEqual({ messages: [summary, view(pending()), ...messages.slice(1)] });
		messages.push(makeAssistantMessage(["TaskWrite"]));
		const [second] = await h.emit("context", { messages }, ctx);
		expect(second).toEqual({ messages: [summary, view(pending()), ...messages.slice(1)] });
		messages.push(makeToolResult({ toolName: "TaskWrite", toolCallId: "new-visible" }));
		const [third] = await h.emit("context", { messages }, ctx);
		expect(third).toEqual({ messages: [summary, view(pending()), ...messages.slice(1)] });
	});
	it("uses only the hidden state before the first visible snapshot even after later writes", async () => {
		const h = setup();
		const hidden = makeSnapshotEntry(pending(), "hidden");
		const ctx = createMockCtx({ branch: [hidden] });
		await h.emit("session_start", {}, ctx);
		await h.write(ctx, { operations: [{ action: "update", id: "1", set: { progress: "Tests passed" } }] });
		const updated = getTaskState("test-session");
		vi.mocked(ctx.sessionManager.getBranch).mockReturnValue([hidden, makeSnapshotEntry(updated, "write")]);
		const messages = [makeToolResult({ toolName: "TaskWrite", toolCallId: "write" })];
		expect(await h.context(ctx, messages)).toEqual([view(pending())]);
		await h.write(ctx, { operations: [{ action: "update", id: "1", set: { status: "completed" } }] });
		vi.mocked(ctx.sessionManager.getBranch).mockReturnValue([
			hidden,
			makeSnapshotEntry(updated, "write"),
			makeSnapshotEntry(getTaskState("test-session"), "finished"),
		]);
		expect(await h.context(ctx, messages)).toEqual([view(pending())]);
	});
	it.each([makeState(), makeState([makeTask("1", { status: "completed" })])])(
		"returns undefined when the hidden snapshot has no unfinished tasks: %j",
		async (state) => {
			const h = setup();
			const ctx = createMockCtx({ branch: [makeSnapshotEntry(state, "hidden")] });
			await h.emit("session_start", {}, ctx);
			expect(await h.emit("context", { messages: [summary, makeUserMessage("Continue")] }, ctx)).toEqual([
				undefined,
			]);
		},
	);
	it("returns undefined when there are no snapshots", async () => {
		const h = setup();
		const ctx = createMockCtx();
		await h.emit("session_start", {}, ctx);
		expect(await h.emit("context", { messages: [makeUserMessage("Continue")] }, ctx)).toEqual([undefined]);
	});
	it.each([true, false])("filters a returned old view when hidden unfinished work exists: %s", async (unfinished) => {
		const h = setup();
		const state = unfinished ? pending() : makeState();
		const ctx = createMockCtx({ branch: branch(state) });
		await h.emit("session_start", {}, ctx);
		const user = makeUserMessage("Continue");
		const messages = [summary, user, { ...view(pending()), role: "custom" as const, content: "old view" }];
		expect(await h.emit("context", { messages }, ctx)).toEqual([
			{ messages: unfinished ? [summary, view(state), user] : [summary, user] },
		]);
	});
	it("inserts at zero without a compaction summary and uses the hidden snapshot timestamp", async () => {
		const h = setup();
		const timestamp = "2026-02-03T04:05:06.000Z";
		const ctx = createMockCtx({ branch: [{ ...makeSnapshotEntry(pending()), timestamp }] });
		await h.emit("session_start", {}, ctx);
		const user = makeUserMessage("Continue");
		expect(await h.emit("context", { messages: [user] }, ctx)).toEqual([
			{ messages: [view(pending(), Date.parse(timestamp)), user] },
		]);
	});
	it("propagates a failed session restoration from the context hook", async () => {
		const h = setup();
		const ctx = createMockCtx({ branch: [{ ...makeSnapshotEntry(pending()), data: { version: 1 } }] });
		await expect(h.emit("session_start", {}, ctx)).rejects.toThrow();
		await expect(h.emit("context", { messages: [makeUserMessage("Continue")] }, ctx)).rejects.toThrow();
	});
	it("returns undefined when task context is disabled", async () => {
		vi.spyOn(config, "loadSettings").mockReturnValue({ ...config.loadSettings(), taskContext: false });
		const h = setup();
		const ctx = createMockCtx({ branch: branch(pending()) });
		await h.emit("session_start", {}, ctx);
		expect(await h.emit("context", { messages: [makeUserMessage("Continue")] }, ctx)).toEqual([undefined]);
	});
});
describe("overlay lifecycle", () => {
	it("does not start resources at factory time or for headless sessions", async () => {
		const h = setup();
		await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
		await h.emit("session_start", {}, createMockCtx());
		await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
		expect(h.importer).not.toHaveBeenCalled();
		const ctx = createMockCtx({ hasUI: true });
		await h.emit("session_start", {}, ctx);
		await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
		expect(h.importer).toHaveBeenCalledTimes(1);
		expect(ctx.ui.setWidget).not.toHaveBeenCalled();
	});
	it("refreshes successful writes only", async () => {
		const h = setup();
		const ctx = createMockCtx({ hasUI: true, branch: branch(pending()) });
		const updates = vi.spyOn(overlayModule.TodoOverlay.prototype, "update");
		await h.emit("session_start", {}, ctx);
		const initial = updates.mock.calls.length;
		await h.emit("tool_execution_end", { toolName: "TaskRead", isError: false }, ctx);
		await h.emit("tool_execution_end", { toolName: "TaskWrite", isError: true }, ctx);
		expect(updates).toHaveBeenCalledTimes(initial);
		await h.emit("tool_execution_end", { toolName: "TaskWrite", isError: false }, ctx);
		expect(updates).toHaveBeenCalledTimes(initial + 1);
	});
	it("ignores a delayed import after its session shuts down", async () => {
		let resolve: (module: typeof overlayModule) => void = () => {
			throw new Error("not started");
		};
		const h = setup(
			vi.fn(
				() =>
					new Promise<typeof overlayModule>((accept) => {
						resolve = accept;
					}),
			),
		);
		const old = createMockCtx({ sessionId: "old", hasUI: true });
		await h.emit("session_start", {}, old);
		setTaskState("old", pending());
		const refresh = h.emit("tool_execution_end", { toolName: "TaskWrite", isError: false }, old);
		await h.emit("session_shutdown", {}, old);
		const next = createMockCtx({ sessionId: "next", hasUI: true, branch: branch(pending()) });
		const start = h.emit("session_start", {}, next);
		resolve(overlayModule);
		await Promise.all([refresh, start]);
		expect(old.ui.setWidget).not.toHaveBeenCalled();
		expect(getForeground()).toBe("next");
	});
});

it("does not remove the foreground panel when a child restoration fails", async () => {
	const h = setup();
	const parent = createMockCtx({ sessionId: "parent", hasUI: true, branch: branch(pending()) });
	await h.emit("session_start", {}, parent);
	const child = createMockCtx({
		sessionId: "child",
		branch: [{ ...makeSnapshotEntry(pending()), data: { version: 1 } }],
	});
	await expect(h.emit("session_start", {}, child)).rejects.toThrow();
	expect(parent.ui.setWidget).not.toHaveBeenCalledWith("pi-todos", undefined);
	expect(getForegroundState()).toEqual(pending());
});
