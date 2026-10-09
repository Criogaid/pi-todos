/**
 * The `todo` tool and the `/todos` command.
 *
 * Every call saves a normalized snapshot on the session branch, then replaces
 * the live list. Result `details` carries the same list so historical calls
 * render their own state.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { GuidanceFields } from "./config.js";
import { formatCommandLine, formatCountsHeader, formatThemedLine, formatToolResponse } from "./format.js";
import { sessionIdOf } from "./host.js";
import { countTodos, currentTodo, isRecord, MAX_TODOS, normalizeTodos, TODO_STATUSES, type TodoList } from "./model.js";
import {
	decodeSnapshot,
	TODO_SNAPSHOT_TYPE,
	TODO_SNAPSHOT_VERSION,
	TOOL_NAME,
	type TodoDetails,
	type TodoSnapshot,
} from "./persistence.js";
import { sanitizeTerminalText } from "./sanitize.js";
import { getTodos, setTodos } from "./store.js";

export { TOOL_NAME };
export const COMMAND_NAME = "todos";

export const TodoParamsSchema = Type.Object({
	todos: Type.Array(
		Type.Object({
			content: Type.String({ minLength: 1, description: "Imperative description, e.g. 'Run the test suite'" }),
			status: StringEnum(TODO_STATUSES),
			activeForm: Type.Optional(
				Type.String({
					description: "Present-continuous label shown while in_progress, e.g. 'Running the test suite'",
				}),
			),
		}),
		{
			maxItems: MAX_TODOS,
			description: "The complete updated list. It replaces the previous list; include completed items.",
		},
	),
});

export const TOOL_DESCRIPTION =
	"Write the todo list for the current task. Each call replaces the whole list with `todos`, so always send every item, including completed ones. Statuses: pending, in_progress (at most one), completed. An empty array clears the list.";

export const DEFAULT_PROMPT_SNIPPET = "Track multi-step work with a todo list";

export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Use `todo` for work with 3 or more distinct steps, or when the user gives you a list of tasks. Skip it for single trivial tasks and conversational requests.",
	"Every `todo` call sends the complete list and replaces the previous one. Keep finished items as completed; remove an item only when it is no longer relevant.",
	"Mark an item in_progress before starting it and completed as soon as it is done. Keep at most one item in_progress.",
	"Mark an item completed only when it is fully done. If tests fail or you are blocked, keep it in_progress and add an item for the blocker.",
	"Write content in imperative form ('Run tests') and activeForm in present continuous ('Running tests').",
];

const MSG_NO_TODOS = "No todos yet. Ask the agent to add some!";
const ERR_REQUIRES_INTERACTIVE = "/todos requires interactive mode";

export function registerTodoTool(pi: ExtensionAPI, guidance: GuidanceFields = {}): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Todo",
		description: guidance.description ?? TOOL_DESCRIPTION,
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,
		executionMode: "sequential",

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const todos = normalizeTodos(params.todos);
			const sessionId = sessionIdOf(ctx);
			const details: TodoDetails = { todos };
			const result = { content: [{ type: "text" as const, text: formatToolResponse(todos) }], details };
			const snapshot: TodoSnapshot = { version: TODO_SNAPSHOT_VERSION, toolCallId, todos };
			// Persist before changing live state; wrapper diagnostics may omit the call or its arguments.
			pi.appendEntry(TODO_SNAPSHOT_TYPE, snapshot);
			setTodos(sessionId, todos);
			return result;
		},

		renderCall(args, theme) {
			return new Text(renderCallText(args, theme), 0, 0);
		},

		renderResult(result, options, theme, context) {
			return new Text(renderResultText(result, options.expanded, context.isError, theme), 0, 0);
		},
	});
}

/** Call arguments may still be partial while the model streams them. */
export function renderCallText(args: unknown, theme: Theme): string {
	const title = theme.fg("toolTitle", theme.bold("todo"));
	return isRecord(args) && Array.isArray(args.todos)
		? `${title} ${theme.fg("muted", `${args.todos.length} items`)}`
		: title;
}

export function renderResultText(
	result: { content?: unknown; details?: unknown },
	expanded: boolean,
	isError: boolean,
	theme: Theme,
): string {
	if (isError) return theme.fg("error", `✗ ${sanitizeTerminalText(firstText(result.content) ?? "todo failed")}`);
	const todos = decodeSnapshot(result.details);
	if (!todos) return theme.fg("success", "✓");
	if (!expanded || todos.length === 0) return summary(todos, theme);
	return todos.map((todo) => formatThemedLine(todo, theme)).join("\n");
}

function summary(todos: TodoList, theme: Theme): string {
	if (todos.length === 0) return theme.fg("muted", "✓ cleared");
	const { completed, total } = countTodos(todos);
	const current = currentTodo(todos);
	const progress = theme.fg("success", `✓ ${completed}/${total}`);
	return current ? `${progress} ${theme.fg("accent", `◐ ${sanitizeTerminalText(current.content)}`)}` : progress;
}

function firstText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const part = content.find((item) => isRecord(item) && item.type === "text" && typeof item.text === "string");
	return part ? (part.text as string) : undefined;
}

export function registerTodosCommand(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Show the current todo list, grouped by status",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(ERR_REQUIRES_INTERACTIVE, "error");
				return;
			}
			const todos = getTodos(sessionIdOf(ctx));
			if (todos.length === 0) {
				ctx.ui.notify(MSG_NO_TODOS, "info");
				return;
			}
			const lines = [formatCountsHeader(todos)];
			const sections = [
				["pending", "── Pending ──"],
				["in_progress", "── In Progress ──"],
				["completed", "── Completed ──"],
			] as const;
			for (const [status, heading] of sections) {
				const group = todos.filter((todo) => todo.status === status);
				if (group.length === 0) continue;
				lines.push(heading);
				for (const todo of group) lines.push(formatCommandLine(todo));
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
