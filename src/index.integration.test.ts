import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildSessionEntries,
	createMockCtx,
	createMockPi,
	makeTodoToolResult,
	makeUserMessage,
} from "../test/helpers/index.js";
import * as config from "./config.js";
import registerExtension, { PREWARM_DELAY_MS } from "./index.js";
import { isRecord, type Todo } from "./model.js";
import * as overlayModule from "./overlay.js";
import { getForeground, getForegroundTodos, getTodos, setTodos } from "./store.js";

const pending = (content: string): Todo => ({ content, status: "pending" });
const completed = (content: string): Todo => ({ content, status: "completed" });
function branch(todos: Todo[]) {
	return buildSessionEntries([makeTodoToolResult({ todos })]);
}

function setup(importer = vi.fn(async () => overlayModule)) {
	const { pi, captured } = createMockPi();
	registerExtension(pi, importer);
	const tool = captured.tools.get("todo");
	if (!tool) throw new Error("todo tool not registered");
	async function emit(name: string, event: unknown, ctx: ExtensionToolContext) {
		const handlers = captured.events.get(name);
		if (!handlers?.length) throw new Error(`missing event handler: ${name}`);
		const results: unknown[] = [];
		for (const handler of handlers) results.push(await handler(event, ctx));
		return results;
	}
	async function context(ctx: ExtensionToolContext) {
		const original = [makeUserMessage("Continue")];
		const [result] = await emit("context", { messages: original }, ctx);
		if (result === undefined) return [];
		if (!isRecord(result) || !Array.isArray(result.messages)) throw new Error("invalid context result");
		expect(result.messages[0]).toEqual(original[0]);
		return result.messages.filter((message) => isRecord(message) && message.customType === "pi-todos-resume");
	}
	const write = async (todos: Todo[], ctx: ExtensionToolContext) => {
		const result = await tool.execute("call", { todos }, undefined, undefined, ctx);
		await emit("tool_execution_end", { toolName: "todo", result, isError: false }, ctx);
	};
	return { captured, importer, emit, context, write };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("session lifecycle and foreground ownership", () => {
	it("keeps child and headless sessions isolated from the first UI session", async () => {
		const lifecycle = setup();
		const headless = createMockCtx({ sessionId: "headless", branch: branch([pending("Headless")]) });
		const parent = createMockCtx({ sessionId: "parent", hasUI: true, branch: branch([pending("Parent")]) });
		const child = createMockCtx({ sessionId: "child", hasUI: true, branch: branch([pending("Child")]) });
		await lifecycle.emit("session_start", {}, headless);
		expect(getForeground()).toBeUndefined();
		await lifecycle.emit("session_start", {}, parent);
		await lifecycle.emit("session_start", {}, child);
		expect(getForeground()).toBe("parent");
		expect(getForegroundTodos()).toEqual([pending("Parent")]);
		expect(child.ui.setWidget).not.toHaveBeenCalled();
		await lifecycle.write([pending("Child changed")], child);
		expect(getTodos("child")).toEqual([pending("Child changed")]);
		expect(getForegroundTodos()).toEqual([pending("Parent")]);
		await lifecycle.emit("session_shutdown", {}, child);
		expect(getTodos("child")).toEqual([]);
		expect(getForeground()).toBe("parent");
		expect(parent.ui.setWidget).toHaveBeenCalledTimes(1);
		await lifecycle.emit("session_shutdown", {}, parent);
		expect(getForeground()).toBeUndefined();
		expect(getTodos("parent")).toEqual([]);
		expect(parent.ui.setWidget).toHaveBeenLastCalledWith("pi-todos", undefined);
	});

	it("replays branch changes during compaction and tree navigation", async () => {
		const lifecycle = setup();
		const ctx = createMockCtx({ sessionId: "main", hasUI: true, branch: branch([pending("Initial")]) });
		await lifecycle.emit("session_start", {}, ctx);
		vi.mocked(ctx.sessionManager.getBranch).mockReturnValue(branch([pending("Compacted")]));
		await lifecycle.emit("session_compact", {}, ctx);
		expect(getTodos("main")).toEqual([pending("Compacted")]);
		vi.mocked(ctx.sessionManager.getBranch).mockReturnValue(branch([]));
		await lifecycle.emit("session_tree", {}, ctx);
		expect(getTodos("main")).toEqual([]);
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-todos", undefined);
	});

	it("dismisses finished foreground work on agent_start and shows a different list", async () => {
		const lifecycle = setup();
		const ctx = createMockCtx({ sessionId: "main", hasUI: true, branch: branch([completed("Done")]) });
		await lifecycle.emit("session_start", {}, ctx);
		await lifecycle.emit("agent_start", {}, createMockCtx({ sessionId: "child" }));
		expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);
		await lifecycle.emit("agent_start", {}, ctx);
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-todos", undefined);
		await lifecycle.write([completed("Done")], ctx);
		expect(ctx.ui.setWidget).toHaveBeenCalledTimes(2);
		await lifecycle.write([pending("New")], ctx);
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-todos", expect.any(Function), { placement: "aboveEditor" });
	});

	it("binds the configured collapse shortcut and skips registration when disabled", () => {
		const defaults = config.loadSettings();
		vi.spyOn(config, "loadSettings").mockReturnValue({ ...defaults, collapseKey: "alt+o" });
		expect([...setup().captured.shortcuts.keys()]).toEqual(["alt+o"]);
		vi.mocked(config.loadSettings).mockReturnValue({ ...defaults, collapseKey: "off" });
		expect(setup().captured.shortcuts.size).toBe(0);
	});

	it("disposes the foreground when shutdown arrives through a stale context", async () => {
		const lifecycle = setup();
		const ctx = createMockCtx({ sessionId: "main", hasUI: true, branch: branch([pending("Work")]) });
		await lifecycle.emit("session_start", {}, ctx);
		const stale = createMockCtx();
		vi.mocked(stale.sessionManager.getSessionId).mockImplementation(() => {
			throw new Error("context stale after session replacement");
		});
		await lifecycle.emit("session_shutdown", {}, stale);
		expect(getForeground()).toBeUndefined();
		expect(getTodos("main")).toEqual([]);
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-todos", undefined);
	});
});

describe("resume injection", () => {
	it.each(["error", "aborted"])(
		"retries after %s and stops only after a successful assistant response",
		async (stopReason) => {
			const lifecycle = setup();
			const ctx = createMockCtx({ sessionId: "main", branch: branch([pending("Saved")]) });
			await lifecycle.emit("session_start", {}, ctx);
			expect(await lifecycle.context(ctx)).toEqual([
				expect.objectContaining({
					customType: "pi-todos-resume",
					display: false,
					content: expect.stringContaining("Saved"),
				}),
			]);
			await lifecycle.emit("message_end", { message: { role: "assistant", stopReason } }, ctx);
			expect(await lifecycle.context(ctx)).toHaveLength(1);
			await lifecycle.emit("message_end", { message: { role: "user" } }, ctx);
			expect(await lifecycle.context(ctx)).toHaveLength(1);
			await lifecycle.emit("message_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
			expect(await lifecycle.context(ctx)).toEqual([]);
		},
	);

	it("does not let an old response acknowledge a new branch generation", async () => {
		const lifecycle = setup();
		const ctx = createMockCtx({ branch: branch([pending("Saved")]) });
		await lifecycle.emit("session_start", {}, ctx);
		await lifecycle.context(ctx);
		await lifecycle.emit("session_compact", {}, ctx);
		await lifecycle.emit("message_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
		expect(await lifecycle.context(ctx)).toHaveLength(1);
		await lifecycle.emit("message_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
		expect(await lifecycle.context(ctx)).toEqual([]);
	});

	it("acks each session independently and restores context after tree navigation", async () => {
		const lifecycle = setup();
		const a = createMockCtx({ sessionId: "a", branch: branch([pending("A")]) });
		const b = createMockCtx({ sessionId: "b", branch: branch([pending("B")]) });
		await lifecycle.emit("session_start", {}, a);
		await lifecycle.emit("session_start", {}, b);
		await lifecycle.context(a);
		await lifecycle.context(b);
		await lifecycle.emit("message_end", { message: { role: "assistant", stopReason: "toolUse" } }, b);
		expect(await lifecycle.context(b)).toEqual([]);
		expect(await lifecycle.context(a)).toHaveLength(1);
		await lifecycle.emit("session_tree", {}, b);
		expect(await lifecycle.context(b)).toHaveLength(1);
	});

	it("omits summaries for completed lists and when the setting is disabled", async () => {
		const lifecycle = setup();
		const ctx = createMockCtx({ branch: branch([completed("Done")]) });
		await lifecycle.emit("session_start", {}, ctx);
		expect(await lifecycle.context(ctx)).toEqual([]);
		vi.spyOn(config, "loadSettings").mockReturnValue({ ...config.loadSettings(), resumeContext: false });
		const disabled = setup();
		const other = createMockCtx({ sessionId: "other", branch: branch([pending("Work")]) });
		await disabled.emit("session_start", {}, other);
		expect(await disabled.context(other)).toEqual([]);
	});
});

describe("lazy overlay lifecycle", () => {
	it("prewarms after startup without registering an empty widget", async () => {
		const lifecycle = setup();
		const ctx = createMockCtx({ hasUI: true });
		await lifecycle.emit("session_start", {}, ctx);
		expect(lifecycle.importer).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
		expect(lifecycle.importer).toHaveBeenCalledTimes(1);
		expect(ctx.ui.setWidget).not.toHaveBeenCalled();
	});

	it("ignores a delayed import for a session that shut down before it resolved", async () => {
		let resolve!: (module: typeof overlayModule) => void;
		const lifecycle = setup(
			vi.fn(
				() =>
					new Promise<typeof overlayModule>((accept) => {
						resolve = accept;
					}),
			),
		);
		const old = createMockCtx({ sessionId: "old", hasUI: true });
		await lifecycle.emit("session_start", {}, old);
		setTodos("old", [pending("Old")]);
		const oldRefresh = lifecycle.emit("tool_execution_end", { toolName: "todo", isError: false }, old);
		await lifecycle.emit("session_shutdown", {}, old);
		const replacement = createMockCtx({ sessionId: "new", hasUI: true, branch: branch([pending("New")]) });
		const replacementStart = lifecycle.emit("session_start", {}, replacement);
		resolve(overlayModule);
		await Promise.all([oldRefresh, replacementStart]);
		expect(old.ui.setWidget).not.toHaveBeenCalled();
		expect(replacement.ui.setWidget).toHaveBeenCalledTimes(1);
		expect(getForeground()).toBe("new");
	});

	it("retries after a transient refresh failure and ignores failed or foreign tool events", async () => {
		const importer = vi
			.fn<() => Promise<typeof overlayModule>>()
			.mockRejectedValueOnce(new Error("temporary import failure"))
			.mockResolvedValue(overlayModule);
		const lifecycle = setup(importer);
		const ctx = createMockCtx({ hasUI: true });
		await lifecycle.emit("session_start", {}, ctx);
		setTodos("test-session", [pending("Work")]);
		await lifecycle.emit("tool_execution_end", { toolName: "todo", isError: true }, ctx);
		await lifecycle.emit("tool_execution_end", { toolName: "other", isError: false }, ctx);
		expect(importer).not.toHaveBeenCalled();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await lifecycle.emit("tool_execution_end", { toolName: "todo", isError: false }, ctx);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("temporary import failure"));
		await lifecycle.emit("tool_execution_end", { toolName: "todo", isError: false }, ctx);
		expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);
		expect(importer).toHaveBeenCalledTimes(2);
	});
});
