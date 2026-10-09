import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMockCtx,
	createMockPi,
	makeAssistantMessage,
	makeMessageEntry,
	makeSnapshotEntry,
	makeState,
	makeTask,
	makeUserMessage,
} from "../test/helpers/index.js";
import * as config from "./config.js";
import registerExtension, { PREWARM_DELAY_MS } from "./index.js";
import { isRecord, type TaskState } from "./model.js";
import * as overlayModule from "./overlay.js";
import { decodeSnapshot } from "./persistence.js";
import { REMINDER_MESSAGE_TYPE, REMINDER_TEXT } from "./reminder.js";
import { getForeground, getForegroundState, getTaskState, setTaskState } from "./store.js";

const pending = () => makeState([makeTask()]);
const branch = (state: TaskState) => [makeSnapshotEntry(state)];
function setup(importer = vi.fn(async () => overlayModule)) {
	const { pi, captured } = createMockPi();
	registerExtension(pi, importer);
	async function emit(name: string, event: unknown, ctx: ExtensionToolContext) {
		const results: unknown[] = [];
		for (const handler of captured.events.get(name) ?? []) results.push(await handler(event, ctx));
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
	async function write(name: string, args: unknown, ctx: ExtensionToolContext) {
		const tool = captured.tools.get(name);
		if (!tool) throw new Error("tool not registered");
		const result = await tool.execute(`call-${name}`, args, undefined, undefined, ctx);
		await emit("tool_execution_end", { toolName: name, result, isError: false }, ctx);
		return result;
	}
	return { pi, captured, importer, emit, context, write };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("session restoration and ownership", () => {
	it("keeps foreground, child and headless task states isolated", async () => {
		const lifecycle = setup();
		const headless = createMockCtx({ sessionId: "headless", branch: branch(pending()) });
		const parent = createMockCtx({ sessionId: "parent", hasUI: true, branch: branch(pending()) });
		const child = createMockCtx({ sessionId: "child", hasUI: true, branch: branch(makeState([makeTask("5")])) });
		await lifecycle.emit("session_start", {}, headless);
		expect(getForeground()).toBeUndefined();
		await lifecycle.emit("session_start", {}, parent);
		await lifecycle.emit("session_start", {}, child);
		expect(getForeground()).toBe("parent");
		expect(getForegroundState()).toEqual(pending());
		expect(child.ui.setWidget).not.toHaveBeenCalled();
		await lifecycle.write("TaskCreate", { subject: "Child work", description: "" }, child);
		expect(getTaskState("child").highWaterMark).toBe(6);
		expect(getForegroundState()).toEqual(pending());
		await lifecycle.emit("session_shutdown", {}, child);
		expect(getTaskState("child").tasks).toEqual([]);
		expect(getForeground()).toBe("parent");
		await lifecycle.emit("session_shutdown", {}, parent);
		expect(getForeground()).toBeUndefined();
		expect(getTaskState("parent").tasks).toEqual([]);
		expect(parent.ui.setWidget).toHaveBeenLastCalledWith("pi-todos", undefined);
	});

	it("replays only the current branch during compaction and tree navigation", async () => {
		const lifecycle = setup();
		const ctx = createMockCtx({ sessionId: "main", hasUI: true, branch: branch(pending()) });
		await lifecycle.emit("session_start", {}, ctx);
		const compacted = makeState([makeTask("5")], 9);
		vi.mocked(ctx.sessionManager.getBranch).mockReturnValue(branch(compacted));
		await lifecycle.emit("session_compact", {}, ctx);
		expect(getTaskState("main")).toEqual(compacted);
		vi.mocked(ctx.sessionManager.getBranch).mockReturnValue(branch(makeState([], 9)));
		await lifecycle.emit("session_tree", {}, ctx);
		expect(getTaskState("main")).toEqual(makeState([], 9));
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-todos", undefined);
	});

	it("restores the same tasks and counter when reloaded", async () => {
		const lifecycle = setup();
		const state = makeState([makeTask("3", { owner: "agent" })], 7);
		const ctx = createMockCtx({ sessionId: "main", branch: branch(state) });
		await lifecycle.emit("session_start", {}, ctx);
		await lifecycle.emit("session_shutdown", {}, ctx);
		const reloaded = setup();
		await reloaded.emit("session_start", {}, ctx);
		expect(getTaskState("main")).toEqual(state);
	});

	it("binds the configured shortcut and skips registration when disabled", () => {
		const defaults = config.loadSettings();
		vi.spyOn(config, "loadSettings").mockReturnValue({ ...defaults, collapseKey: "alt+o" });
		expect([...setup().captured.shortcuts.keys()]).toEqual(["alt+o"]);
		vi.mocked(config.loadSettings).mockReturnValue({ ...defaults, collapseKey: "off" });
		expect(setup().captured.shortcuts.size).toBe(0);
	});

	it("disposes the foreground when shutdown receives a stale context", async () => {
		const lifecycle = setup();
		const ctx = createMockCtx({ hasUI: true, branch: branch(pending()) });
		await lifecycle.emit("session_start", {}, ctx);
		const stale = createMockCtx();
		vi.mocked(stale.sessionManager.getSessionId).mockImplementation(() => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		});
		await lifecycle.emit("session_shutdown", {}, stale);
		expect(getForeground()).toBeUndefined();
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-todos", undefined);
	});
});

describe("finished-list clearing", () => {
	it("saves a clear without a tool-call marker, removes the widget and retains the counter", async () => {
		const lifecycle = setup();
		const finished = makeState(
			[makeTask("1", { status: "completed" }), makeTask("2", { metadata: { _internal: true } })],
			8,
		);
		const ctx = createMockCtx({ hasUI: true, branch: branch(finished) });
		await lifecycle.emit("session_start", {}, ctx);
		await lifecycle.emit("agent_start", {}, ctx);
		expect(getTaskState("test-session")).toEqual(makeState([], 8));
		const data = vi.mocked(lifecycle.pi.appendEntry).mock.calls[0][1];
		expect(decodeSnapshot(data)).toEqual(makeState([], 8));
		expect(data).not.toHaveProperty("toolCallId");
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-todos", undefined);
		const created = await lifecycle.write("TaskCreate", { subject: "New work", description: "" }, ctx);
		expect(created.details).toMatchObject({ task: { id: "9" } });
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-todos", expect.any(Function), { placement: "aboveEditor" });
	});

	it.each([makeState(), pending(), makeState([makeTask("1", { metadata: { _internal: true } })])])(
		"does not clear unfinished, empty or internal-only state: %j",
		async (state) => {
			const lifecycle = setup();
			const ctx = createMockCtx({ branch: branch(state) });
			await lifecycle.emit("session_start", {}, ctx);
			await lifecycle.emit("agent_start", {}, ctx);
			expect(lifecycle.pi.appendEntry).not.toHaveBeenCalled();
			expect(getTaskState("test-session")).toEqual(state);
		},
	);

	it("clears a finished child without replacing foreground state", async () => {
		const lifecycle = setup();
		const parent = createMockCtx({ sessionId: "parent", hasUI: true, branch: branch(pending()) });
		const child = createMockCtx({
			sessionId: "child",
			branch: branch(makeState([makeTask("5", { status: "completed" })])),
		});
		await lifecycle.emit("session_start", {}, parent);
		await lifecycle.emit("session_start", {}, child);
		await lifecycle.emit("agent_start", {}, child);
		expect(getTaskState("child")).toEqual(makeState([], 5));
		expect(getForegroundState()).toEqual(pending());
	});
});

describe("resume injection", () => {
	it.each(["error", "aborted"])(
		"retries after %s and acknowledges only a successful assistant",
		async (stopReason) => {
			const lifecycle = setup();
			const ctx = createMockCtx({ branch: branch(pending()) });
			await lifecycle.emit("session_start", {}, ctx);
			expect(await lifecycle.context(ctx)).toEqual([
				expect.objectContaining({
					customType: "pi-todos-resume",
					display: false,
					content: expect.stringContaining("Task 1"),
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

	it("does not let an old response acknowledge a newer restoration", async () => {
		const lifecycle = setup();
		const ctx = createMockCtx({ branch: branch(pending()) });
		await lifecycle.emit("session_start", {}, ctx);
		await lifecycle.context(ctx);
		await lifecycle.emit("session_compact", {}, ctx);
		await lifecycle.emit("message_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
		expect(await lifecycle.context(ctx)).toHaveLength(1);
		await lifecycle.emit("message_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
		expect(await lifecycle.context(ctx)).toEqual([]);
	});

	it("tracks acknowledgements per session and marks tree navigation pending again", async () => {
		const lifecycle = setup();
		const first = createMockCtx({ sessionId: "first", branch: branch(pending()) });
		const second = createMockCtx({ sessionId: "second", branch: branch(pending()) });
		await lifecycle.emit("session_start", {}, first);
		await lifecycle.emit("session_start", {}, second);
		await lifecycle.context(second);
		await lifecycle.emit("message_end", { message: { role: "assistant", stopReason: "toolUse" } }, second);
		expect(await lifecycle.context(first)).toHaveLength(1);
		expect(await lifecycle.context(second)).toEqual([]);
		await lifecycle.emit("session_tree", {}, second);
		expect(await lifecycle.context(second)).toHaveLength(1);
	});

	it("omits completed summaries and honors the disabled setting", async () => {
		const lifecycle = setup();
		const completed = createMockCtx({ branch: branch(makeState([makeTask("1", { status: "completed" })])) });
		await lifecycle.emit("session_start", {}, completed);
		expect(await lifecycle.context(completed)).toEqual([]);
		vi.spyOn(config, "loadSettings").mockReturnValue({ ...config.loadSettings(), resumeContext: false });
		const disabled = setup();
		const ctx = createMockCtx({ branch: branch(pending()) });
		await disabled.emit("session_start", {}, ctx);
		expect(await disabled.context(ctx)).toEqual([]);
	});
});

describe("turn-end task reminder", () => {
	const dueBranch = () => Array.from({ length: 10 }, () => makeMessageEntry(makeAssistantMessage()));
	it("preserves earlier drafts and adds a hidden reminder when all gates hold", async () => {
		const lifecycle = setup();
		const ctx = createMockCtx({ branch: dueBranch() });
		const draft = { type: "custom", customType: "earlier", data: { saved: true } };
		const entries = [draft];
		const [result] = await lifecycle.emit("turn_end", { outcome: "completed", entries }, ctx);
		expect(result).toEqual({
			entries: [
				draft,
				{ type: "custom_message", customType: REMINDER_MESSAGE_TYPE, content: REMINDER_TEXT, display: false },
			],
		});
		expect(entries).toEqual([draft]);
		if (!isRecord(result) || !Array.isArray(result.entries)) throw new Error("missing drafts");
		expect(result.entries[0]).toBe(draft);
	});

	it.each(["disabled", "aborted", "error", "inactive", "not-due", "stale"])(
		"does not remind when %s",
		async (gate) => {
			if (gate === "disabled")
				vi.spyOn(config, "loadSettings").mockReturnValue({ ...config.loadSettings(), taskReminder: false });
			const lifecycle = setup();
			const ctx = createMockCtx({ branch: dueBranch() });
			if (gate === "inactive") lifecycle.captured.activeTools = ["TaskGet", "TaskList", "TaskUpdate"];
			if (gate === "not-due") vi.mocked(ctx.sessionManager.getBranch).mockReturnValue(dueBranch().slice(0, 9));
			if (gate === "stale")
				vi.mocked(ctx.sessionManager.getBranch).mockImplementation(() => {
					throw new Error("This extension ctx is stale after session replacement or reload.");
				});
			expect(
				await lifecycle.emit(
					"turn_end",
					{ outcome: gate === "aborted" || gate === "error" ? gate : "completed", entries: [] },
					ctx,
				),
			).toEqual([undefined]);
		},
	);
});

describe("lazy overlay lifecycle", () => {
	it("prewarms without registering an empty widget", async () => {
		const lifecycle = setup();
		const ctx = createMockCtx({ hasUI: true });
		await lifecycle.emit("session_start", {}, ctx);
		expect(lifecycle.importer).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(PREWARM_DELAY_MS);
		expect(lifecycle.importer).toHaveBeenCalledTimes(1);
		expect(ctx.ui.setWidget).not.toHaveBeenCalled();
	});

	it("refreshes only successful write tools", async () => {
		const lifecycle = setup();
		const ctx = createMockCtx({ hasUI: true, branch: branch(pending()) });
		const updates = vi.spyOn(overlayModule.TodoOverlay.prototype, "update");
		await lifecycle.emit("session_start", {}, ctx);
		const initial = updates.mock.calls.length;
		for (const toolName of ["TaskGet", "TaskList", "other"])
			await lifecycle.emit("tool_execution_end", { toolName, isError: false }, ctx);
		await lifecycle.emit("tool_execution_end", { toolName: "TaskUpdate", isError: true }, ctx);
		expect(updates).toHaveBeenCalledTimes(initial);
		for (const toolName of ["TaskCreate", "TaskUpdate"])
			await lifecycle.emit("tool_execution_end", { toolName, isError: false }, ctx);
		expect(updates).toHaveBeenCalledTimes(initial + 2);
	});

	it("ignores a delayed import after the original session shuts down", async () => {
		let resolve: (module: typeof overlayModule) => void = () => {
			throw new Error("promise not created");
		};
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
		setTaskState("old", pending());
		const oldRefresh = lifecycle.emit("tool_execution_end", { toolName: "TaskCreate", isError: false }, old);
		await lifecycle.emit("session_shutdown", {}, old);
		const replacement = createMockCtx({ sessionId: "new", hasUI: true, branch: branch(pending()) });
		const replacementStart = lifecycle.emit("session_start", {}, replacement);
		resolve(overlayModule);
		await Promise.all([oldRefresh, replacementStart]);
		expect(old.ui.setWidget).not.toHaveBeenCalled();
		expect(replacement.ui.setWidget).toHaveBeenCalledTimes(1);
		expect(getForeground()).toBe("new");
	});

	it("retries after a transient refresh failure", async () => {
		const importer = vi
			.fn<() => Promise<typeof overlayModule>>()
			.mockRejectedValueOnce(new Error("temporary import failure"))
			.mockResolvedValue(overlayModule);
		const lifecycle = setup(importer);
		const ctx = createMockCtx({ hasUI: true });
		await lifecycle.emit("session_start", {}, ctx);
		setTaskState("test-session", pending());
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await lifecycle.emit("tool_execution_end", { toolName: "TaskCreate", isError: false }, ctx);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("temporary import failure"));
		await lifecycle.emit("tool_execution_end", { toolName: "TaskUpdate", isError: false }, ctx);
		expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);
		expect(importer).toHaveBeenCalledTimes(2);
	});
});
