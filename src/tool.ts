/**
 * The task tools — TaskCreate, TaskGet, TaskList, TaskUpdate — and the
 * `/tasks` command. Schemas, descriptions and model-facing results follow
 * Claude Code's task tools.
 *
 * Every successful write saves a snapshot of the whole list on the session
 * branch, then replaces the live list. Results also carry `structuredContent`,
 * so `codemode` scripts receive data such as a new task's id.
 */

import { type JsonValue, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { Guidance, GuidanceFields } from "./config.js";
import {
	formatCommandLine,
	formatCountsHeader,
	formatCreated,
	formatSummaryLine,
	formatTaskDetail,
	formatTaskList,
	formatUpdated,
	STATUS_COLOR,
	STATUS_GLYPH,
} from "./format.js";
import { sessionIdOf } from "./host.js";
import {
	createTask,
	findTask,
	isRecord,
	openBlockers,
	summarizeTasks,
	TASK_NOT_FOUND,
	TASK_STATUSES,
	TASK_UPDATE_STATUSES,
	type TaskState,
	type TaskStatus,
	updateTask,
	visibleTasks,
} from "./model.js";
import { TASK_CREATE, TASK_GET, TASK_LIST, TASK_UPDATE, type TaskToolName } from "./names.js";
import { snapshotOf, TASKS_SNAPSHOT_TYPE } from "./persistence.js";
import { sanitizeTerminalText } from "./sanitize.js";
import { getTaskState, setTaskState } from "./store.js";

export const COMMAND_NAME = "tasks";

// Parameters. Field names and descriptions follow Claude Code's schemas.

const MetadataSchema = Type.Record(Type.String(), Type.Unknown());
const ActiveFormSchema = Type.String({
	description: 'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
});

export const TaskCreateParams = Type.Object({
	subject: Type.String({ description: "A brief title for the task" }),
	description: Type.String({ description: "What needs to be done" }),
	activeForm: Type.Optional(ActiveFormSchema),
	metadata: Type.Optional({ ...MetadataSchema, description: "Arbitrary metadata to attach to the task" }),
});

export const TaskGetParams = Type.Object({
	taskId: Type.String({ description: "The ID of the task to retrieve" }),
});

export const TaskListParams = Type.Object({});

export const TaskUpdateParams = Type.Object({
	taskId: Type.String({ description: "The ID of the task to update" }),
	subject: Type.Optional(Type.String({ description: "New subject for the task" })),
	description: Type.Optional(Type.String({ description: "New description for the task" })),
	activeForm: Type.Optional(ActiveFormSchema),
	status: Type.Optional(StringEnum(TASK_UPDATE_STATUSES, { description: "New status for the task" })),
	addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
	addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
	owner: Type.Optional(Type.String({ description: "New owner for the task" })),
	metadata: Type.Optional({
		...MetadataSchema,
		description: "Metadata keys to merge into the task. Set a key to null to delete it.",
	}),
});

// Structured results, as Claude Code's tools report them.

const StatusSchema = StringEnum(TASK_STATUSES);
const IdsSchema = Type.Array(Type.String());

export const TaskCreateOutput = Type.Object({
	task: Type.Object({ id: Type.String(), subject: Type.String() }),
});

export const TaskGetOutput = Type.Object({
	task: Type.Union([
		Type.Object({
			id: Type.String(),
			subject: Type.String(),
			description: Type.String(),
			status: StatusSchema,
			blocks: IdsSchema,
			blockedBy: IdsSchema,
		}),
		Type.Null(),
	]),
});

export const TaskListOutput = Type.Object({
	tasks: Type.Array(
		Type.Object({
			id: Type.String(),
			subject: Type.String(),
			status: StatusSchema,
			owner: Type.Optional(Type.String()),
			blockedBy: IdsSchema,
		}),
	),
});

export const TaskUpdateOutput = Type.Object({
	success: Type.Boolean(),
	taskId: Type.String(),
	updatedFields: Type.Array(Type.String()),
	error: Type.Optional(Type.String()),
	statusChange: Type.Optional(Type.Object({ from: Type.String(), to: Type.String() })),
});

type TaskCreateResult = Static<typeof TaskCreateOutput>;
type TaskGetResult = Static<typeof TaskGetOutput>;
type TaskListResult = Static<typeof TaskListOutput>;
type TaskUpdateResult = Static<typeof TaskUpdateOutput>;

// Model-facing copy. Descriptions are Claude Code's, without the teammate sections.

export const TASK_CREATE_DESCRIPTION = `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: What needs to be done
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
- Check TaskList first to avoid creating duplicate tasks`;

export const TASK_GET_DESCRIPTION = `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its blockedBy list is empty before beginning work.
- Use TaskList to see all tasks in summary form.`;

export const TASK_LIST_DESCRIPTION = `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task
- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones

## Output

Returns a summary of each task:
- **id**: Task identifier (use with TaskGet, TaskUpdate)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Agent ID if assigned, empty if available
- **blockedBy**: List of open task IDs that must be resolved first (tasks with blockedBy cannot be claimed until dependencies resolve)

Use TaskGet with a specific task ID to view full details including description and comments.`;

export const TASK_UPDATE_DESCRIPTION = `Use this tool to update a task in the task list.

## When to Use This Tool

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

## Staleness

Make sure to read a task's latest state using \`TaskGet\` before updating it.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\``;

/** Built-in description, snippet and guidelines for each tool; `guidance` in the config overrides them per field. */
export const DEFAULT_GUIDANCE: Record<TaskToolName, Required<GuidanceFields>> = {
	[TASK_CREATE]: {
		description: TASK_CREATE_DESCRIPTION,
		promptSnippet: "Create a task in the session task list to plan and track multi-step work",
		promptGuidelines: [
			"Break down and manage your work with the TaskCreate and TaskUpdate tools. Mark each task as completed as soon as you are done with the task. Do not batch up multiple tasks before marking them as completed.",
		],
	},
	[TASK_GET]: {
		description: TASK_GET_DESCRIPTION,
		promptSnippet: "Read one task's full details and dependencies",
		promptGuidelines: [],
	},
	[TASK_LIST]: {
		description: TASK_LIST_DESCRIPTION,
		promptSnippet: "List tasks with their status, owner and open blockers",
		promptGuidelines: [],
	},
	[TASK_UPDATE]: {
		description: TASK_UPDATE_DESCRIPTION,
		promptSnippet: "Change a task's status, details or dependencies, or delete it",
		promptGuidelines: [],
	},
};

function guidanceFor(name: TaskToolName, guidance: Guidance): Required<GuidanceFields> {
	return { ...DEFAULT_GUIDANCE[name], ...guidance[name] };
}

/** Accept `3`, `"#3"` and `" 3 "` for task id `"3"`. */
function repairId(value: unknown): unknown {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return typeof value === "string" ? value.trim().replace(/^#/, "") : value;
}

/**
 * Repair close-but-wrong argument names before validation, as Claude Code
 * does: `id` or `task_id` for `taskId`, `active_form` for `activeForm`.
 */
export function repairTaskArguments(args: unknown): unknown {
	if (!isRecord(args)) return args;
	const repaired: Record<string, unknown> = { ...args };
	const rename = (from: string, to: string) => {
		if (repaired[to] === undefined && repaired[from] !== undefined) repaired[to] = repaired[from];
		delete repaired[from];
	};
	rename("id", "taskId");
	rename("task_id", "taskId");
	rename("active_form", "activeForm");
	if (repaired.taskId !== undefined) repaired.taskId = repairId(repaired.taskId);
	for (const key of ["addBlocks", "addBlockedBy"]) {
		const ids = repaired[key];
		if (Array.isArray(ids)) repaired[key] = ids.map(repairId);
	}
	return repaired;
}

/** The same output goes to the renderer (`details`) and to codemode scripts (`structuredContent`). */
function textResult<T extends object>(text: string, output: T) {
	// Outputs are built from strings, booleans and arrays, so they are JSON by construction.
	return { content: [{ type: "text" as const, text }], details: output, structuredContent: output as JsonValue };
}

export function registerTaskTools(pi: ExtensionAPI, guidance: Guidance = {}): void {
	/** Persist before changing live state; wrapper diagnostics may omit the call or its arguments. */
	function commit(sessionId: string, state: TaskState, toolCallId: string): void {
		pi.appendEntry(TASKS_SNAPSHOT_TYPE, snapshotOf(state, toolCallId));
		setTaskState(sessionId, state);
	}

	pi.registerTool<typeof TaskCreateParams, TaskCreateResult>({
		name: TASK_CREATE,
		label: TASK_CREATE,
		...guidanceFor(TASK_CREATE, guidance),
		parameters: TaskCreateParams,
		outputSchema: TaskCreateOutput,
		executionMode: "sequential",
		prepareArguments: (args) => repairTaskArguments(args) as Static<typeof TaskCreateParams>,

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionId = sessionIdOf(ctx);
			const { state, task } = createTask(getTaskState(sessionId), params);
			commit(sessionId, state, toolCallId);
			const output: TaskCreateResult = { task: { id: task.id, subject: task.subject } };
			return textResult(formatCreated(task), output);
		},

		renderCall(args, theme) {
			const subject =
				typeof args?.subject === "string" ? ` ${theme.fg("muted", sanitizeTerminalText(args.subject))}` : "";
			return new Text(`${title(TASK_CREATE, theme)}${subject}`, 0, 0);
		},

		renderResult(result, _options, theme, context) {
			if (context.isError) return errorText(result, theme);
			const task = result.details?.task;
			return new Text(task ? theme.fg("success", `✓ #${task.id} created`) : theme.fg("success", "✓"), 0, 0);
		},
	});

	pi.registerTool<typeof TaskGetParams, TaskGetResult>({
		name: TASK_GET,
		label: TASK_GET,
		...guidanceFor(TASK_GET, guidance),
		parameters: TaskGetParams,
		outputSchema: TaskGetOutput,
		executionMode: "sequential",
		prepareArguments: (args) => repairTaskArguments(args) as Static<typeof TaskGetParams>,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = findTask(getTaskState(sessionIdOf(ctx)), params.taskId);
			if (!task) return textResult(TASK_NOT_FOUND, { task: null });
			const output: TaskGetResult = {
				task: {
					id: task.id,
					subject: task.subject,
					description: task.description,
					status: task.status,
					blocks: [...task.blocks],
					blockedBy: [...task.blockedBy],
				},
			};
			return textResult(formatTaskDetail(task), output);
		},

		renderCall(args, theme) {
			return new Text(`${title(TASK_GET, theme)}${taskIdLabel(args?.taskId, theme)}`, 0, 0);
		},

		renderResult(result, options, theme, context) {
			if (context.isError) return errorText(result, theme);
			const task = result.details?.task;
			if (!task) return new Text(theme.fg("warning", TASK_NOT_FOUND), 0, 0);
			const heading = `${statusGlyph(task.status, theme)} #${task.id} ${sanitizeTerminalText(task.subject)}`;
			if (!options.expanded) return new Text(heading, 0, 0);
			const body = sanitizeTerminalText(task.description);
			return new Text(body ? `${heading}\n${theme.fg("muted", body)}` : heading, 0, 0);
		},
	});

	pi.registerTool<typeof TaskListParams, TaskListResult>({
		name: TASK_LIST,
		label: TASK_LIST,
		...guidanceFor(TASK_LIST, guidance),
		parameters: TaskListParams,
		outputSchema: TaskListOutput,
		executionMode: "sequential",

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const tasks = summarizeTasks(getTaskState(sessionIdOf(ctx)));
			return textResult(formatTaskList(tasks), { tasks });
		},

		renderCall(_args, theme) {
			return new Text(title(TASK_LIST, theme), 0, 0);
		},

		renderResult(result, options, theme, context) {
			if (context.isError) return errorText(result, theme);
			const tasks = result.details?.tasks ?? [];
			if (tasks.length === 0) return new Text(theme.fg("muted", "No tasks"), 0, 0);
			const completed = tasks.filter((task) => task.status === "completed").length;
			const heading = theme.fg("success", `✓ ${completed}/${tasks.length} completed`);
			if (!options.expanded) return new Text(heading, 0, 0);
			const rows = tasks.map(
				(task) => `${statusGlyph(task.status, theme)} ${sanitizeTerminalText(formatSummaryLine(task))}`,
			);
			return new Text([heading, ...rows].join("\n"), 0, 0);
		},
	});

	pi.registerTool<typeof TaskUpdateParams, TaskUpdateResult>({
		name: TASK_UPDATE,
		label: TASK_UPDATE,
		...guidanceFor(TASK_UPDATE, guidance),
		parameters: TaskUpdateParams,
		outputSchema: TaskUpdateOutput,
		executionMode: "sequential",
		prepareArguments: (args) => repairTaskArguments(args) as Static<typeof TaskUpdateParams>,

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionId = sessionIdOf(ctx);
			const { state, outcome } = updateTask(getTaskState(sessionId), params);
			if (outcome.success) commit(sessionId, state, toolCallId);
			return textResult(formatUpdated(outcome), outcome);
		},

		renderCall(args, theme) {
			const status = typeof args?.status === "string" ? ` ${theme.fg("muted", args.status)}` : "";
			return new Text(`${title(TASK_UPDATE, theme)}${taskIdLabel(args?.taskId, theme)}${status}`, 0, 0);
		},

		renderResult(result, _options, theme, context) {
			if (context.isError) return errorText(result, theme);
			const outcome = result.details;
			if (!outcome?.success) return new Text(theme.fg("warning", outcome?.error ?? TASK_NOT_FOUND), 0, 0);
			const change = outcome.statusChange
				? `${outcome.statusChange.from} → ${outcome.statusChange.to}`
				: outcome.updatedFields.join(", ") || "no change";
			return new Text(theme.fg("success", `✓ #${outcome.taskId} ${change}`), 0, 0);
		},
	});
}

function title(name: string, theme: Theme): string {
	return theme.fg("toolTitle", theme.bold(name));
}

/** Call arguments may still be partial while the model streams them. */
function taskIdLabel(taskId: unknown, theme: Theme): string {
	return typeof taskId === "string" && taskId ? ` ${theme.fg("accent", `#${sanitizeTerminalText(taskId)}`)}` : "";
}

function statusGlyph(status: TaskStatus, theme: Theme): string {
	return theme.fg(STATUS_COLOR[status], STATUS_GLYPH[status]);
}

function errorText(result: { content?: unknown }, theme: Theme): Text {
	const content = result.content;
	const part = Array.isArray(content)
		? content.find((item) => isRecord(item) && item.type === "text" && typeof item.text === "string")
		: undefined;
	const message = part ? (part.text as string) : "task tool failed";
	return new Text(theme.fg("error", `✗ ${sanitizeTerminalText(message)}`), 0, 0);
}

const MSG_NO_TASKS = "No tasks yet. Ask the agent to add some!";
const ERR_REQUIRES_INTERACTIVE = "/tasks requires interactive mode";

export function registerTasksCommand(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Show the current task list, grouped by status",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(ERR_REQUIRES_INTERACTIVE, "error");
				return;
			}
			const state = getTaskState(sessionIdOf(ctx));
			const tasks = visibleTasks(state);
			if (tasks.length === 0) {
				ctx.ui.notify(MSG_NO_TASKS, "info");
				return;
			}
			const lines = [formatCountsHeader(tasks)];
			const sections = [
				["pending", "── Pending ──"],
				["in_progress", "── In Progress ──"],
				["completed", "── Completed ──"],
			] as const;
			for (const [status, heading] of sections) {
				const group = tasks.filter((task) => task.status === status);
				if (group.length === 0) continue;
				lines.push(heading);
				for (const task of group) lines.push(formatCommandLine(task, openBlockers(state, task)));
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
