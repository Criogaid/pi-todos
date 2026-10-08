import { type JsonObject, type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createMockCtx, createMockPi, makeTheme } from "../test/helpers/index.js";
import type { Todo } from "./model.js";
import { getTodos, setTodos } from "./store.js";
import { registerTodosCommand, registerTodoTool, renderCallText, renderResultText } from "./tool.js";

// The renderer only uses the formatting functions supplied by this theme double.
const theme = makeTheme() as Theme;
const todos: Todo[] = [
	{ content: "Prepare", status: "completed" },
	{ content: "Run tests", status: "in_progress", activeForm: "Running tests" },
	{ content: "Review", status: "pending" },
];

function setup(guidance = {}) {
	const { pi, captured } = createMockPi();
	registerTodoTool(pi, guidance);
	const tool = captured.tools.get("todo");
	if (!tool) throw new Error("todo tool not registered");
	return { tool, captured };
}

describe("todo tool", () => {
	it("exposes one sequential replacement tool with the list size bound", () => {
		const { tool, captured } = setup();
		expect([...captured.tools.keys()]).toEqual(["todo"]);
		expect(tool.executionMode).toBe("sequential");
		expect(tool.parameters).toMatchObject({
			required: ["todos"],
			properties: { todos: { type: "array", maxItems: 100 } },
		});
	});

	it("replaces and clears the caller's list, returning a complete normalized snapshot", async () => {
		const { tool } = setup();
		const ctx = createMockCtx({ sessionId: "parent" });
		setTodos("parent", [{ content: "Old", status: "pending" }]);
		setTodos("child", [{ content: "Child", status: "pending" }]);
		const result = await tool.execute("call", { todos }, undefined, undefined, ctx);
		expect(result.details).toEqual({ todos });
		expect(getTodos("parent")).toEqual(todos);
		expect(getTodos("child")).toEqual([{ content: "Child", status: "pending" }]);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Todo list updated: 1/3 completed.\n[completed] Prepare\n[in_progress] Run tests (Running tests)\n[pending] Review",
			},
		]);
		const cleared = await tool.execute("clear", { todos: [] }, undefined, undefined, ctx);
		expect(cleared).toMatchObject({
			details: { todos: [] },
			content: [{ type: "text", text: "Todo list cleared." }],
		});
		expect(getTodos("parent")).toEqual([]);
	});

	it("stores normalized fields and returns the same normalized snapshot", async () => {
		const { tool } = setup();
		const params = {
			todos: [
				{ content: "  Work  ", status: "in_progress", activeForm: "  Working  " },
				{ content: "  Review  ", status: "pending", activeForm: "  " },
			],
		};
		const normalized = [
			{ content: "Work", status: "in_progress", activeForm: "Working" },
			{ content: "Review", status: "pending" },
		];
		const result = await tool.execute("call", params, undefined, undefined, createMockCtx());
		expect(result.details).toEqual({ todos: normalized });
		expect(getTodos("test-session")).toEqual(normalized);
		expect(params.todos[0].content).toBe("  Work  ");
	});

	it.each([
		{ todos: "invalid" },
		{ todos: [{ content: " ", status: "pending" }] },
		{
			todos: [
				{ content: "A", status: "in_progress" },
				{ content: "B", status: "in_progress" },
			],
		},
		{ todos: [{ content: "A", status: "unknown" }] },
		{ todos: Array.from({ length: 101 }, () => ({ content: "A", status: "pending" })) },
	])("throws on invalid input without committing a partial replacement", async (params) => {
		const { tool } = setup();
		setTodos("test-session", todos);
		await expect(tool.execute("bad", params, undefined, undefined, createMockCtx())).rejects.toThrow();
		expect(getTodos("test-session")).toEqual(todos);
	});

	it("uses supplied guidance and retains defaults for omitted fields", () => {
		const baseline = setup().tool;
		const guidance = {
			description: "Replace the checklist",
			promptSnippet: "Track work",
			promptGuidelines: ["Send every item"],
		};
		expect(setup(guidance).tool).toMatchObject(guidance);
		const partial = setup({ description: guidance.description }).tool;
		expect(partial.promptSnippet).toBe(baseline.promptSnippet);
		expect(partial.promptGuidelines).toEqual(baseline.promptGuidelines);
	});
});

describe("Pi argument coercion", () => {
	// Pi converts arguments to the schema's declared types before validating them
	// (validateToolArguments → Value.Convert). These tests pin the documented
	// boundary in docs/tool-schema.md: coercion is host-wide, and the tool's own
	// rules still apply to the converted values.
	it("converts scalars to strings and wraps a non-array todos value", () => {
		const { tool } = setup();
		const validate = (args: unknown) =>
			validateToolArguments(tool as unknown as Tool, {
				type: "toolCall",
				id: "call",
				name: "todo",
				arguments: args as JsonObject,
			});
		expect(validate({ todos: { content: 1, status: "pending", activeForm: 2 } })).toEqual({
			todos: [{ content: "1", status: "pending", activeForm: "2" }],
		});
	});

	it("still rejects values that stay invalid after coercion", () => {
		const { tool } = setup();
		const validate = (args: unknown) =>
			validateToolArguments(tool as unknown as Tool, {
				type: "toolCall",
				id: "call",
				name: "todo",
				arguments: args as JsonObject,
			});
		// Wraps to [5] and ["text"], then fails item validation.
		expect(() => validate({ todos: 5 })).toThrow(/Validation failed/);
		expect(() => validate({ todos: "text" })).toThrow(/Validation failed/);
		// A numeric status becomes "1", which still fails the enum.
		expect(() => validate({ todos: [{ content: "Task", status: 1 }] })).toThrow(/Validation failed/);
	});
});

describe("historical tool rendering", () => {
	it("renders complete, partial, and malformed call arguments", () => {
		expect(renderCallText({ todos }, theme)).toBe("todo 3 items");
		expect(renderCallText({ todos: "incomplete" }, theme)).toBe("todo");
		expect(renderCallText({}, theme)).toBe("todo");
		expect(renderCallText(null, theme)).toBe("todo");
	});

	it("renders the result snapshot even when the live list is different", () => {
		setTodos("test-session", [{ content: "Unrelated live work", status: "pending" }]);
		const result = { details: { todos } };
		expect(renderResultText(result, false, false, theme)).toBe("✓ 1/3 ◐ Run tests");
		expect(renderResultText(result, true, false, theme)).toBe("✓ Prepare\n◐ Run tests (Running tests)\n○ Review");
		expect(renderResultText({ details: { todos: [] } }, false, false, theme)).toBe("✓ cleared");
		expect(renderResultText({ details: {} }, true, false, theme)).toBe("✓");
	});

	it("renders an undecodable snapshot as a success checkmark", () => {
		const result = { details: { todos: [{ content: "Saved", status: "unknown" }] } };
		expect(renderResultText(result, true, false, theme)).toBe("✓");
	});

	it("uses isError for failures and ignores details.error, removing terminal controls", () => {
		expect(
			renderResultText({ content: [{ type: "text", text: "bad\u001b[31m input\nretry" }] }, false, true, theme),
		).toBe("✗ bad input retry");
		expect(renderResultText({ details: { error: "ignored error" } }, false, false, theme)).toBe("✓");
		expect(renderResultText({ details: { todos, error: "ignored error" } }, false, false, theme)).toBe(
			"✓ 1/3 ◐ Run tests",
		);
		expect(renderResultText({}, false, true, theme)).toBe("✗ todo failed");
	});
});

describe("/todos", () => {
	async function run(sessionId = "test-session", hasUI = true) {
		const { pi, captured } = createMockPi();
		registerTodosCommand(pi);
		const command = captured.commands.get("todos");
		if (!command) throw new Error("todos command not registered");
		const ctx = createMockCtx({ sessionId, hasUI });
		// The handler uses only the ExtensionContext portion of a command context.
		await command.handler("", ctx as unknown as Parameters<typeof command.handler>[1]);
		return vi.mocked(ctx.ui.notify);
	}

	it("groups the caller's tasks with counts and activeForm", async () => {
		setTodos("test-session", todos);
		setTodos("other", [{ content: "Other session", status: "pending" }]);
		expect(await run()).toHaveBeenCalledWith(
			"1/3 completed · 1 in progress · 1 pending\n── Pending ──\n  ○ Review\n── In Progress ──\n  ◐ Run tests (Running tests)\n── Completed ──\n  ✓ Prepare",
			"info",
		);
	});

	it("omits zero counts and empty sections", async () => {
		setTodos("test-session", [todos[2]]);
		expect(await run()).toHaveBeenCalledWith("1 pending\n── Pending ──\n  ○ Review", "info");
	});

	it("reports empty and non-interactive sessions", async () => {
		expect(await run()).toHaveBeenCalledWith("No todos yet. Ask the agent to add some!", "info");
		expect(await run("test-session", false)).toHaveBeenCalledWith("/todos requires interactive mode", "error");
	});
});
