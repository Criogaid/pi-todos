import { type JsonObject, type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { createMockCtx, createMockPi, makeState, makeTask, makeTheme } from "../test/helpers/index.js";
import type { Guidance } from "./config.js";
import { TASK_TOOL_NAMES } from "./names.js";
import { decodeSnapshot, TASKS_SNAPSHOT_TYPE } from "./persistence.js";
import { getTaskState, setTaskState } from "./store.js";
import { DEFAULT_GUIDANCE, registerTasksCommand, registerTaskTools, repairTaskArguments } from "./tool.js";

const theme = makeTheme() as Theme;
const renderContext: Parameters<NonNullable<ToolDefinition["renderCall"]>>[2] = {
	args: {},
	toolCallId: "render",
	invalidate: () => {},
	lastComponent: undefined,
	state: undefined,
	cwd: process.cwd(),
	executionStarted: true,
	argsComplete: true,
	isPartial: false,
	expanded: false,
	showImages: false,
	isError: false,
};

function setup(guidance: Guidance = {}) {
	const { pi, captured } = createMockPi();
	registerTaskTools(pi, guidance);
	const tool = (name: string) => {
		const definition = captured.tools.get(name);
		if (!definition) throw new Error(`missing ${name}`);
		return definition;
	};
	const execute = (name: string, args: unknown = {}, sessionId = "test-session") =>
		tool(name).execute(`call-${name}`, args, undefined, undefined, createMockCtx({ sessionId }));
	return { pi, captured, tool, execute };
}
function callText(tool: ToolDefinition, args: unknown) {
	if (!tool.renderCall) throw new Error("missing call renderer");
	// Text pads rendered terminal rows to the requested width.
	return tool
		.renderCall(args, theme, renderContext)
		.render(1000)
		.map((line) => line.trimEnd())
		.join("\n");
}
function resultText(
	tool: ToolDefinition,
	result: Parameters<NonNullable<ToolDefinition["renderResult"]>>[0],
	expanded = false,
	isError = false,
) {
	if (!tool.renderResult) throw new Error("missing result renderer");
	return tool
		.renderResult(result, { expanded, isPartial: false }, theme, { ...renderContext, expanded, isError })
		.render(1000)
		.map((line) => line.trimEnd())
		.join("\n");
}

describe("registered task tools", () => {
	it("registers the four sequential tools with valid structured outputs", async () => {
		const { captured, tool, execute } = setup();
		expect([...captured.tools.keys()]).toEqual(["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"]);
		for (const name of TASK_TOOL_NAMES) {
			const definition = tool(name);
			expect(definition.executionMode).toBe("sequential");
			const args =
				name === "TaskCreate"
					? { subject: "Task", description: "Details" }
					: name === "TaskList"
						? {}
						: { taskId: "1" };
			const result = await execute(name, args);
			expect(result.structuredContent).toEqual(result.details);
			if (!definition.outputSchema) throw new Error("missing output schema");
			expect(Value.Check(definition.outputSchema, result.structuredContent)).toBe(true);
		}
	});

	it("creates pending tasks and persists the state before making it live", async () => {
		const { execute, pi } = setup();
		setTaskState("child", makeState([makeTask("5")]));
		const result = await execute("TaskCreate", {
			subject: "Write tests",
			description: "Full details",
			activeForm: "Writing tests",
			metadata: { keep: 1, remove: null },
		});
		expect(result).toEqual({
			content: [{ type: "text", text: "Task #1 created successfully: Write tests" }],
			details: { task: { id: "1", subject: "Write tests" } },
			structuredContent: { task: { id: "1", subject: "Write tests" } },
		});
		const state = getTaskState("test-session");
		expect(state.tasks[0]).toMatchObject({
			subject: "Write tests",
			description: "Full details",
			activeForm: "Writing tests",
			metadata: { keep: 1 },
			status: "pending",
		});
		const [type, data] = vi.mocked(pi.appendEntry).mock.calls[0];
		expect(type).toBe(TASKS_SNAPSHOT_TYPE);
		expect(decodeSnapshot(data)).toEqual(state);
		expect(data).toMatchObject({ toolCallId: "call-TaskCreate" });
		expect(getTaskState("child").tasks[0].id).toBe("5");
	});

	it("gets full detail and lists visible tasks with open blockers without writing entries", async () => {
		const { execute, pi } = setup();
		const state = makeState([
			makeTask("1", { status: "completed" }),
			makeTask("2", { owner: "agent", blocks: ["3"], blockedBy: ["1"] }),
			makeTask("3", { metadata: { _internal: true }, blockedBy: ["2"] }),
		]);
		setTaskState("test-session", state);
		expect((await execute("TaskGet", { taskId: "2" })).details).toEqual({
			task: {
				id: "2",
				subject: "Task 2",
				description: "Details 2",
				status: "pending",
				blocks: ["3"],
				blockedBy: ["1"],
			},
		});
		expect((await execute("TaskList")).details).toEqual({
			tasks: [
				{ id: "1", subject: "Task 1", status: "completed", blockedBy: [] },
				{ id: "2", subject: "Task 2", status: "pending", owner: "agent", blockedBy: [] },
			],
		});
		expect((await execute("TaskGet", { taskId: "3" })).details).toMatchObject({ task: { id: "3" } });
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(getTaskState("test-session")).toBe(state);
	});

	it("returns not-found and empty-list results without errors or writes", async () => {
		const { execute, pi } = setup();
		const get = await execute("TaskGet", { taskId: "99" });
		const update = await execute("TaskUpdate", { taskId: "99", status: "completed" });
		const list = await execute("TaskList");
		expect(get.details).toEqual({ task: null });
		expect(update.details).toEqual({ success: false, taskId: "99", updatedFields: [], error: "Task not found" });
		for (const result of [get, update]) {
			expect(result.isError).toBeFalsy();
			expect(result.content).toEqual([{ type: "text", text: "Task not found" }]);
		}
		expect(list).toMatchObject({ details: { tasks: [] }, content: [{ type: "text", text: "No tasks found" }] });
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("writes successful changes, no-ops and deletion, retaining the id counter", async () => {
		const { execute, pi } = setup();
		await execute("TaskCreate", { subject: "Task", description: "Details" });
		const update = await execute("TaskUpdate", { taskId: "1", status: "in_progress", owner: "agent" });
		expect(update.details).toEqual({
			success: true,
			taskId: "1",
			updatedFields: ["owner", "status"],
			statusChange: { from: "pending", to: "in_progress" },
		});
		const noop = await execute("TaskUpdate", { taskId: "1" });
		expect(noop.content).toEqual([{ type: "text", text: "Updated task #1 " }]);
		const deleted = await execute("TaskUpdate", { taskId: "1", status: "deleted" });
		expect(deleted.details).toMatchObject({
			success: true,
			updatedFields: ["deleted"],
			statusChange: { from: "in_progress", to: "deleted" },
		});
		expect(getTaskState("test-session")).toEqual(makeState([], 1));
		expect(pi.appendEntry).toHaveBeenCalledTimes(4);
	});

	it.each(["TaskCreate", "TaskUpdate"])("leaves live state untouched when %s persistence fails", async (name) => {
		const { execute, pi } = setup();
		const state = makeState([makeTask()]);
		setTaskState("test-session", state);
		vi.mocked(pi.appendEntry).mockImplementation(() => {
			throw new Error("Storage unavailable");
		});
		const args = name === "TaskCreate" ? { subject: "New", description: "" } : { taskId: "1", status: "completed" };
		await expect(execute(name, args)).rejects.toThrow("Storage unavailable");
		expect(getTaskState("test-session")).toBe(state);
	});

	it("overrides guidance per tool and per field", () => {
		const { tool } = setup({
			TaskCreate: { description: "Create override" },
			TaskGet: { promptSnippet: "Read override" },
			TaskUpdate: { promptGuidelines: ["Update rule"] },
		});
		expect(tool("TaskCreate").description).toBe("Create override");
		expect(tool("TaskCreate").promptSnippet).toBe(DEFAULT_GUIDANCE.TaskCreate.promptSnippet);
		expect(tool("TaskGet").promptSnippet).toBe("Read override");
		expect(tool("TaskGet").description).toBe(DEFAULT_GUIDANCE.TaskGet.description);
		expect(tool("TaskUpdate").promptGuidelines).toEqual(["Update rule"]);
		expect(tool("TaskList").description).toBe(DEFAULT_GUIDANCE.TaskList.description);
	});
});

describe("argument repair before host validation", () => {
	it("repairs aliases and id arrays without mutating the submitted object", () => {
		const input = { id: 3, task_id: "4", active_form: "Working", addBlocks: [1, " #2 ", "3"], addBlockedBy: ["#4"] };
		const before = structuredClone(input);
		expect(repairTaskArguments(input)).toEqual({
			taskId: "3",
			activeForm: "Working",
			addBlocks: ["1", "2", "3"],
			addBlockedBy: ["4"],
		});
		expect(input).toEqual(before);
		expect(
			repairTaskArguments({ taskId: " #5 ", id: 1, task_id: 2, activeForm: "Current", active_form: "Alias" }),
		).toEqual({ taskId: "5", activeForm: "Current" });
		expect(repairTaskArguments({ task_id: " #7 " })).toEqual({ taskId: "7" });
	});

	it("normalizes finite ids and leaves unsupported values for host validation", () => {
		expect(
			repairTaskArguments({
				taskId: Infinity,
				addBlocks: [NaN, -Infinity, 2, " ##3 "],
				addBlockedBy: [false, null],
			}),
		).toEqual({ taskId: Infinity, addBlocks: [NaN, -Infinity, "2", "#3"], addBlockedBy: [false, null] });
	});

	it.each([null, undefined, [], "text", 3])("leaves non-object input unchanged: %j", (input) => {
		expect(repairTaskArguments(input)).toBe(input);
	});

	it("repairs registered arguments before schema validation and executes the repaired id", async () => {
		const { tool } = setup();
		const definition = tool("TaskUpdate");
		if (!definition.prepareArguments) throw new Error("missing argument repair");
		const prepared = definition.prepareArguments({
			task_id: " #1 ",
			active_form: "Working",
			status: "in_progress",
			addBlocks: [2],
		});
		const validated = validateToolArguments(definition as Tool, {
			type: "toolCall",
			id: "repair",
			name: definition.name,
			arguments: prepared as JsonObject,
		});
		setTaskState("test-session", makeState([makeTask("1"), makeTask("2")]));
		const result = await definition.execute("repair", validated, undefined, undefined, createMockCtx());
		expect(result.details).toMatchObject({
			success: true,
			taskId: "1",
			updatedFields: ["activeForm", "status", "blocks"],
		});
		expect(getTaskState("test-session").tasks[1].blockedBy).toEqual(["1"]);
	});
});

describe("task tool rendering", () => {
	it("renders call arguments and incomplete streamed calls", () => {
		const { tool } = setup();
		expect(callText(tool("TaskCreate"), { subject: "Write tests" })).toBe("TaskCreate Write tests");
		expect(callText(tool("TaskGet"), { taskId: "2" })).toBe("TaskGet #2");
		expect(callText(tool("TaskUpdate"), { taskId: "2", status: "completed" })).toBe("TaskUpdate #2 completed");
		expect(callText(tool("TaskList"), {})).toBe("TaskList");
		for (const name of TASK_TOOL_NAMES) expect(callText(tool(name), {})).toBe(name);
	});

	it("renders historical creation and details independently of live state", () => {
		const { tool } = setup();
		setTaskState("test-session", makeState([makeTask("9")]));
		expect(resultText(tool("TaskCreate"), { content: [], details: { task: { id: "1", subject: "Saved" } } })).toBe(
			"✓ #1 created",
		);
		const result = {
			content: [],
			details: { task: makeTask("2", { subject: "Saved", status: "in_progress", description: "Original details" }) },
		};
		expect(resultText(tool("TaskGet"), result)).toBe("◐ #2 Saved");
		expect(resultText(tool("TaskGet"), result, true)).toBe("◐ #2 Saved\nOriginal details");
		expect(resultText(tool("TaskGet"), { content: [], details: { task: null } })).toBe("Task not found");
	});

	it("renders list summaries and expanded rows", () => {
		const { tool } = setup();
		const result = {
			content: [],
			details: {
				tasks: [
					{ id: "1", subject: "Finished", status: "completed", blockedBy: [] },
					{ id: "2", subject: "Next", status: "pending", owner: "agent", blockedBy: ["3"] },
				],
			},
		};
		expect(resultText(tool("TaskList"), result)).toBe("✓ 1/2 completed");
		expect(resultText(tool("TaskList"), result, true)).toContain("○ #2 [pending] Next (agent) [blocked by #3]");
		expect(resultText(tool("TaskList"), { content: [], details: { tasks: [] } })).toBe("No tasks");
	});

	it("renders update transitions, field changes, no-ops and not-found outcomes", () => {
		const { tool } = setup();
		const update = tool("TaskUpdate");
		expect(
			resultText(update, {
				content: [],
				details: {
					success: true,
					taskId: "1",
					updatedFields: ["status"],
					statusChange: { from: "pending", to: "completed" },
				},
			}),
		).toBe("✓ #1 pending → completed");
		expect(
			resultText(update, {
				content: [],
				details: { success: true, taskId: "1", updatedFields: ["subject", "owner"] },
			}),
		).toBe("✓ #1 subject, owner");
		expect(resultText(update, { content: [], details: { success: true, taskId: "1", updatedFields: [] } })).toBe(
			"✓ #1 no change",
		);
		expect(
			resultText(update, {
				content: [],
				details: { success: false, taskId: "99", updatedFields: [], error: "Task not found" },
			}),
		).toBe("Task not found");
	});

	it.each(TASK_TOOL_NAMES)("renders %s errors with terminal controls removed", (name) => {
		const { tool } = setup();
		expect(
			resultText(
				tool(name),
				{ content: [{ type: "text", text: "bad\u001b[31m input\nretry" }], details: undefined },
				false,
				true,
			),
		).toBe("✗ bad input retry");
	});
});

describe("/tasks", () => {
	async function run(hasUI = true, sessionId = "test-session") {
		const { pi, captured } = createMockPi();
		registerTasksCommand(pi);
		const command = captured.commands.get("tasks");
		if (!command) throw new Error("tasks command not registered");
		const ctx = createMockCtx({ hasUI, sessionId });
		// The command reads only the ExtensionContext portion of the command context.
		await command.handler("", ctx as unknown as Parameters<typeof command.handler>[1]);
		return vi.mocked(ctx.ui.notify);
	}
	it("groups visible tasks with counts, activeForm, owner and open blockers", async () => {
		setTaskState(
			"test-session",
			makeState([
				makeTask("1", { status: "completed" }),
				makeTask("2", { subject: "Current", status: "in_progress", activeForm: "Working", owner: "agent" }),
				makeTask("3", { blockedBy: ["1", "2"] }),
				makeTask("4", { metadata: { _internal: true } }),
			]),
		);
		setTaskState("other", makeState([makeTask("9")]));
		expect(await run()).toHaveBeenCalledWith(
			"1/3 completed · 1 in progress · 1 pending\n── Pending ──\n  ○ #3 Task 3 › blocked by #2\n── In Progress ──\n  ◐ #2 Current (Working) @agent\n── Completed ──\n  ✓ #1 Task 1",
			"info",
		);
	});
	it("omits empty sections and reports empty or non-interactive sessions", async () => {
		expect(await run()).toHaveBeenCalledWith("No tasks yet. Ask the agent to add some!", "info");
		expect(await run(false)).toHaveBeenCalledWith("/tasks requires interactive mode", "error");
		setTaskState("test-session", makeState([makeTask()]));
		expect(await run()).toHaveBeenCalledWith("1 pending\n── Pending ──\n  ○ #1 Task 1", "info");
		setTaskState("test-session", makeState([makeTask("1", { metadata: { _internal: true } })]));
		expect(await run()).toHaveBeenCalledWith("No tasks yet. Ask the agent to add some!", "info");
	});
});
