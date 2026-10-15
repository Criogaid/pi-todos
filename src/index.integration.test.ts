import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMockCtx,
	createMockPi,
	makeSnapshotEntry,
	makeState,
	makeTask,
	makeUserMessage,
} from "../test/helpers/index.js";
import * as config from "./config.js";
import { TASK_CONTEXT_TYPE } from "./context.js";
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
	async function context(ctx: ExtensionToolContext) {
		const original = [makeUserMessage("Continue")];
		const [result] = await emit("context", { messages: original }, ctx);
		if (result === undefined) return [];
		if (!isRecord(result) || !Array.isArray(result.messages)) throw new Error("invalid context result");
		expect(result.messages[0]).toEqual(original[0]);
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
describe("current task context", () => {
	it("survives compaction followed by a non-task tool round trip", async () => {
		const h = setup();
		const ctx = createMockCtx({ branch: branch(pending()) });
		await h.emit("session_start", {}, ctx);
		await h.emit("session_compact", {}, ctx);
		const first = await h.context(ctx);
		await h.emit("message_end", { message: { role: "assistant", stopReason: "toolUse" } }, ctx);
		await h.emit("tool_execution_end", { toolName: "read", isError: false }, ctx);
		const second = await h.context(ctx);
		expect(JSON.stringify(first)).toContain("Next: run tests");
		expect(JSON.stringify(second)).toContain("Next: run tests");
		expect(h.pi.appendEntry).not.toHaveBeenCalled();
		expect(h.captured.events.has("turn_end")).toBe(false);
	});
	it("refreshes progress and removes the view when all tasks finish", async () => {
		const h = setup();
		const ctx = createMockCtx({ branch: branch(pending()) });
		await h.emit("session_start", {}, ctx);
		await h.write(ctx, { operations: [{ action: "update", id: "1", set: { progress: "Tests passed" } }] });
		expect(JSON.stringify(await h.context(ctx))).toContain("Tests passed");
		await h.write(ctx, { operations: [{ action: "update", id: "1", set: { status: "completed" } }] });
		expect(await h.context(ctx)).toEqual([]);
	});
	it("honors the single context setting", async () => {
		vi.spyOn(config, "loadSettings").mockReturnValue({ ...config.loadSettings(), taskContext: false });
		const h = setup();
		const ctx = createMockCtx({ branch: branch(pending()) });
		await h.emit("session_start", {}, ctx);
		expect(await h.context(ctx)).toEqual([]);
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
