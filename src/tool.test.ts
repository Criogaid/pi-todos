import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { createMockCtx, createMockPi, makeState, makeTask, makeTheme } from "../test/helpers/index.js";
import { decodeSnapshot } from "./persistence.js";
import { LIMITS, parseRead, parseWrite } from "./schema.js";
import { failSession, getTaskState, setTaskState } from "./store.js";
import { registerTasksCommand, registerTaskTools } from "./tool.js";

const create = { operations: [{ action: "create", task: { subject: "Build", description: "Keep all requirements" } }] };
function setup() {
	const { pi, captured } = createMockPi();
	registerTaskTools(pi);
	function tool(name: string) {
		const tool = captured.tools.get(name);
		if (!tool) throw new Error(name);
		return tool;
	}
	async function execute(name: string, input: unknown = {}, sessionId = "test-session") {
		const definition = tool(name);
		const params = definition.prepareArguments ? definition.prepareArguments(input) : input;
		const result = await definition.execute("call", params, undefined, undefined, createMockCtx({ sessionId }));
		if (!definition.outputSchema) throw new Error("missing output schema");
		expect(Value.Check(definition.outputSchema, result.structuredContent)).toBe(true);
		expect(result.details).toEqual(result.structuredContent);
		return result;
	}
	return { pi, captured, tool, execute };
}
describe("task tool boundaries", () => {
	it("registers only the two sequential tools and persists once before publication", async () => {
		const { pi, captured, execute } = setup();
		expect([...captured.tools.keys()].sort()).toEqual(["TaskRead", "TaskWrite"]);
		for (const tool of captured.tools.values()) expect(tool.executionMode).toBe("sequential");
		vi.mocked(pi.appendEntry).mockImplementation((_type, data) => {
			expect(getTaskState("test-session").tasks).toEqual([]);
			expect(decodeSnapshot(data).tasks).toHaveLength(2);
		});
		await execute("TaskWrite", { operations: [...create.operations, ...create.operations] });
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(getTaskState("test-session").tasks.map((task) => task.id)).toEqual(["1", "2"]);
	});
	it("returns bounded recovery data and changes nothing on a failed batch", async () => {
		const { execute, pi } = setup();
		const result = await execute("TaskWrite", {
			operations: [...create.operations, { action: "update", id: "99", set: {} }],
		});
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({
			ok: false,
			error: { code: "not_found", operationIndex: 1, id: "99" },
			active: { tasks: [], total: 0 },
		});
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});
	it("saves nothing for reads, failures, and net no-ops", async () => {
		const { execute, pi } = setup();
		await execute("TaskWrite", create);
		await execute("TaskRead");
		await execute("TaskRead", { view: "details", ids: ["1"] });
		await execute("TaskRead", { view: "details", ids: ["99"] });
		const noop = await execute("TaskWrite", { operations: [{ action: "update", id: "1", set: {} }] });
		expect(noop.details).toMatchObject({ changed: false });
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
	});
	it("leaves live state unchanged when persistence fails and reports an uncertain durable outcome", async () => {
		const { execute, pi } = setup();
		const state = makeState([makeTask()]);
		setTaskState("test-session", state);
		vi.mocked(pi.appendEntry).mockImplementation(() => {
			throw new Error("disk full");
		});
		const result = await execute("TaskWrite", create);
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ error: { code: "storage_error" } });
		expect(getTaskState("test-session")).toBe(state);
	});
	it("blocks reads and writes after restoration fails, without reporting an empty plan", async () => {
		const { execute, pi } = setup();
		failSession("test-session", new Error("old snapshot"));
		for (const [name, input] of [
			["TaskWrite", create],
			["TaskRead", {}],
		] as const) {
			const result = await execute(name, input);
			expect(result.details).toMatchObject({ ok: false, error: { code: "unavailable" } });
			expect(result.details).not.toHaveProperty("active");
		}
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});
	it("isolates simultaneous child writes and preserves every allocation", async () => {
		const { execute } = setup();
		await Promise.all([
			execute("TaskWrite", create, "parent"),
			execute("TaskWrite", create, "child"),
			execute("TaskWrite", create, "parent"),
		]);
		expect(getTaskState("parent").tasks.map((task) => task.id)).toEqual(["1", "2"]);
		expect(getTaskState("child").tasks.map((task) => task.id)).toEqual(["1"]);
	});
	it("keeps maximal write feedback within the result budget", async () => {
		const { execute } = setup();
		const result = await execute("TaskWrite", {
			operations: Array.from({ length: LIMITS.operations }, () => ({
				action: "create",
				task: { subject: "x".repeat(LIMITS.subjectChars), description: "Details" },
			})),
		});
		expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(LIMITS.outputChars);
	});
});
describe("strict arguments without coercion", () => {
	it.each([
		{ task: { subject: "x", description: "y" } },
		{ operations: [] },
		{ operations: [{ action: "update", id: 1, set: {} }] },
		{ operations: [{ action: "update", id: " #1 ", set: {} }] },
		{ operations: [{ action: "update", taskId: "1", set: {} }] },
		{ operations: [{ action: "delete", id: "1", set: {} }] },
		{ operations: [{ action: "create", task: { subject: " ", description: "y" } }] },
		{ operations: [{ action: "update", id: "1", set: { status: "deleted" } }] },
		{ operations: [{ action: "update", id: "1", set: { addBlockedBy: ["2"] } }] },
		{ operations: [{ action: "update", id: "1", set: { metadata: { value: NaN } } }] },
	])("rejects invalid write %j", (value) => expect(() => parseWrite(value)).toThrow());
	it.each([
		{ view: "details" },
		{ ids: ["1"] },
		{ view: "details", ids: ["1"], scope: "all" },
		{ view: "summary", afterId: 2 },
		{ taskId: "1" },
	])("rejects invalid read %j", (value) => expect(() => parseRead(value)).toThrow());
	it.each([
		{ name: "sparse array", values: new Array<string>(2) },
		{ name: "array with extra keys", values: Object.assign(["saved"], { extra: "lost" }) },
		{ name: "array hole balanced by an extra key", values: Object.assign(new Array<string>(1), { extra: "lost" }) },
	])("rejects a $name in nested metadata without saving or publishing a batch", async ({ values }) => {
		const { execute, pi } = setup();
		await execute("TaskWrite", create);
		const before = getTaskState("test-session");
		await expect(
			execute("TaskWrite", {
				operations: [
					...create.operations,
					{ action: "update", id: "1", set: { metadata: { nested: { values } } } },
				],
			}),
		).rejects.toMatchObject({ code: "invalid_input" });
		expect(getTaskState("test-session")).toBe(before);
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
	});
	it("preserves dense metadata arrays including empty arrays and explicit nulls across JSON snapshots", async () => {
		const { execute, pi } = setup();
		const metadata = { values: [[], [null, null], ["saved", true, 3, { nested: [] }]] };
		await execute("TaskWrite", {
			operations: [{ action: "create", task: { subject: "Arrays", description: "Keep metadata", metadata } }],
		});
		const snapshot = vi.mocked(pi.appendEntry).mock.calls[0][1];
		expect(decodeSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(getTaskState("test-session"));
		expect(getTaskState("test-session").tasks[0].metadata).toEqual(metadata);
	});
	it("rejects cyclic metadata without recursion failure", () => {
		const value: { nested?: unknown } = {};
		value.nested = value;
		expect(() => parseWrite({ operations: [{ action: "update", id: "1", set: { metadata: value } }] })).toThrow(
			/JSON/,
		);
	});
});
it("sanitizes task result rendering without reading live state", async () => {
	const { execute, tool } = setup();
	const result = await execute("TaskWrite", {
		operations: [{ action: "create", task: { subject: "x\u001b[31m", description: "Details" } }],
	});
	const render = tool("TaskWrite").renderResult;
	if (!render) throw new Error("missing renderer");
	const context = { isError: false } as Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
	const text = render(result, { expanded: true, isPartial: false }, makeTheme() as Theme, context)
		.render(1000)
		.join("\n");
	expect(text).not.toContain("\u001b");
});
it("makes completed tasks discoverable through the human command", async () => {
	const { pi, captured } = createMockPi();
	registerTasksCommand(pi);
	setTaskState("test-session", makeState([makeTask("1", { status: "completed", metadata: { _internal: true } })]));
	const command = captured.commands.get("tasks");
	if (!command) throw new Error("missing command");
	const ctx = createMockCtx({ hasUI: true });
	// The command uses only the shared ExtensionContext fields supplied by this fixture.
	await command.handler("", ctx as unknown as Parameters<typeof command.handler>[1]);
	expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("#1"), "info");
});

it("rejects long combining sequences before they can make summary pagination stall", () => {
	expect(() =>
		parseWrite({
			operations: [
				{ action: "create", task: { subject: `x${"\u0301".repeat(LIMITS.subjectChars)}`, description: "Details" } },
			],
		}),
	).toThrow();
});

it("rejects explicit undefined fields instead of erasing stored requirements", () => {
	expect(() => parseWrite({ operations: [{ action: "update", id: "1", set: { description: undefined } }] })).toThrow();
});
