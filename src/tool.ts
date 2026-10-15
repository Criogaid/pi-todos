/** Two tool boundaries over one session state and one synchronous commit path. */
import type { JsonValue } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Guidance, GuidanceFields } from "./config.js";
import { formatCommandLine, formatCountsHeader } from "./format.js";
import { sessionIdOf } from "./host.js";
import {
	applyOperations,
	openBlockers,
	type ReadResult,
	readTasks,
	summarizeTasks,
	type TaskState,
	type WriteResult,
} from "./model.js";
import { TASK_READ, TASK_WRITE, type TaskToolName } from "./names.js";
import { snapshotOf, TASKS_SNAPSHOT_TYPE } from "./persistence.js";
import { sanitizeTerminalText } from "./sanitize.js";
import {
	DetailPageSchema,
	type Failure,
	FailureSchema,
	parseRead,
	parseWrite,
	ReadSchema,
	SummaryPageSchema,
	TaskError,
	WriteResultSchema,
	WriteSchema,
} from "./schema.js";
import { getTaskState, setTaskState } from "./store.js";

export const COMMAND_NAME = "tasks";
export const DEFAULT_GUIDANCE: Record<TaskToolName, Required<GuidanceFields>> = {
	[TASK_READ]: {
		description:
			"Read session tasks. Summary defaults to unfinished work; details requires ids and forbids scope/afterId. Follow returned continuation fields for omitted tasks.",
		promptSnippet: "Read current task summaries or selected task details",
		promptGuidelines: [
			"Use task reads when required facts are missing; write results already include the current active summary.",
		],
	},
	[TASK_WRITE]: {
		description:
			"Apply an ordered batch of task creates, updates, and deletions atomically. Any invalid operation or final dependency graph rejects the entire batch. Referenced IDs must predate the request.",
		promptSnippet: "Create or revise the session plan in one atomic batch",
		promptGuidelines: [
			"Track commitments when their requirements or progress would otherwise be lost; skip bookkeeping for trivial work.",
			"Submit ready plan changes together in one TaskWrite operations array, including completing work and starting the next task.",
			"Keep requirements in description and replace progress with the latest useful checkpoint. Complete only verified work; delete work that is no longer required.",
			"Supplied fields replace their values; null clears optional fields. Use dependsOn: [] to remove dependencies. Status changes do not enforce scheduling.",
		],
	},
};
function guidanceFor(name: TaskToolName, guidance: Guidance): Required<GuidanceFields> {
	return { ...DEFAULT_GUIDANCE[name], ...guidance[name] };
}
type ToolResult = ReadResult | WriteResult | Failure;
function resultOf(output: ToolResult) {
	// Task metadata is validated as JSON at input; the remaining fields are schema-derived JSON values.
	return {
		content: [{ type: "text" as const, text: JSON.stringify(output) }],
		details: output,
		structuredContent: output as JsonValue,
		isError: !output.ok,
	};
}
function failure(error: unknown, state?: TaskState): ReturnType<typeof resultOf> {
	if (!(error instanceof TaskError)) throw error;
	return resultOf({
		ok: false,
		error: {
			code: error.code,
			field: error.field,
			message: error.message,
			...(error.operationIndex !== undefined && { operationIndex: error.operationIndex }),
			...(error.id !== undefined && { id: error.id }),
		},
		...(state && { active: summarizeTasks(state) }),
	});
}

export function registerTaskTools(pi: ExtensionAPI, guidance: Guidance = {}): void {
	pi.registerTool<typeof WriteSchema, ToolResult>({
		name: TASK_WRITE,
		label: TASK_WRITE,
		...guidanceFor(TASK_WRITE, guidance),
		parameters: WriteSchema,
		outputSchema: Type.Union([WriteResultSchema, FailureSchema]),
		executionMode: "sequential",
		// Validate raw input before the host's coercion; never repair or change it.
		prepareArguments: parseWrite,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			let state: TaskState | undefined;
			try {
				const sessionId = sessionIdOf(ctx);
				state = getTaskState(sessionId);
				if (signal?.aborted) throw new TaskError("unavailable", "request", "was aborted before committing");
				// No await between evaluation, persistence, and publication: nested calls cannot interleave.
				const candidate = applyOperations(state, params.operations);
				if (candidate.result.changed) {
					try {
						pi.appendEntry(TASKS_SNAPSHOT_TYPE, snapshotOf(candidate.state, toolCallId));
					} catch (error) {
						throw new TaskError(
							"storage_error",
							"snapshot",
							"persistence failed; durable outcome may be uncertain, reload before retrying creates",
							undefined,
							undefined,
							{ cause: error },
						);
					}
					setTaskState(sessionId, candidate.state);
				}
				return resultOf(candidate.result);
			} catch (error) {
				return failure(error, state);
			}
		},
		renderCall: (_args, theme) => new Text(theme.fg("toolTitle", theme.bold(TASK_WRITE)), 0, 0),
		renderResult: (result, options, theme, context) => renderResult(result, options.expanded, context.isError, theme),
	});
	pi.registerTool<typeof ReadSchema, ToolResult>({
		name: TASK_READ,
		label: TASK_READ,
		...guidanceFor(TASK_READ, guidance),
		parameters: ReadSchema,
		outputSchema: Type.Union([SummaryPageSchema, DetailPageSchema, FailureSchema]),
		executionMode: "sequential",
		prepareArguments: parseRead,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let state: TaskState | undefined;
			try {
				state = getTaskState(sessionIdOf(ctx));
				return resultOf(readTasks(state, params));
			} catch (error) {
				return failure(error, state);
			}
		},
		renderCall: (_args, theme) => new Text(theme.fg("toolTitle", theme.bold(TASK_READ)), 0, 0),
		renderResult: (result, options, theme, context) => renderResult(result, options.expanded, context.isError, theme),
	});
}
function renderResult(
	result: { content: readonly { type: string; text?: string }[]; details?: ToolResult },
	expanded: boolean,
	isError: boolean,
	theme: Theme,
): Text {
	const output = result.details;
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
	if (isError || !output || !output.ok) return new Text(theme.fg("error", sanitizeTerminalText(text)), 0, 0);
	const heading =
		"outcomes" in output
			? `${output.changed ? "Saved" : "Unchanged"}: ${output.outcomes.length} operations`
			: `${output.tasks.length} tasks returned`;
	return new Text(theme.fg("success", heading) + (expanded ? `\n${sanitizeTerminalText(text)}` : ""), 0, 0);
}
export function registerTasksCommand(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Show all session tasks grouped by status, including completed work",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/tasks requires interactive mode", "error");
				return;
			}
			const state = getTaskState(sessionIdOf(ctx));
			if (!state.tasks.length) {
				ctx.ui.notify("No tasks yet.", "info");
				return;
			}
			const lines = [formatCountsHeader(state.tasks)];
			for (const status of ["in_progress", "pending", "completed"] as const) {
				const group = state.tasks.filter((task) => task.status === status);
				if (group.length)
					lines.push(
						`── ${status} ──`,
						...group.map((task) => formatCommandLine(task, openBlockers(state, task))),
					);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
