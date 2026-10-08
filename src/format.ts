import type { Theme } from "@earendil-works/pi-coding-agent";
import { countTodos, type Todo, type TodoList, type TodoStatus } from "./model.js";
import { sanitizeTerminalText } from "./sanitize.js";

export const STATUS_GLYPH: Record<TodoStatus, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "✓",
};

export const STATUS_COLOR: Record<TodoStatus, "dim" | "warning" | "success"> = {
	pending: "dim",
	in_progress: "warning",
	completed: "success",
};

function activeFormSuffix(todo: Todo): string {
	return todo.status === "in_progress" && todo.activeForm ? ` (${sanitizeTerminalText(todo.activeForm)})` : "";
}

/** Model-facing response: a progress line followed by the full list. */
export function formatToolResponse(todos: TodoList): string {
	if (todos.length === 0) return "Todo list cleared.";
	const { completed, total } = countTodos(todos);
	const lines = todos.map((todo) => `[${todo.status}] ${sanitizeTerminalText(todo.content)}${activeFormSuffix(todo)}`);
	return [`Todo list updated: ${completed}/${total} completed.`, ...lines].join("\n");
}

/** `/todos` row: indented glyph, plain text. */
export function formatCommandLine(todo: Todo): string {
	return `  ${STATUS_GLYPH[todo.status]} ${sanitizeTerminalText(todo.content)}${activeFormSuffix(todo)}`;
}

/** Themed row shared by the overlay and the expanded tool result. */
export function formatThemedLine(todo: Todo, theme: Theme): string {
	const glyph = theme.fg(STATUS_COLOR[todo.status], STATUS_GLYPH[todo.status]);
	const color = todo.status === "in_progress" ? "accent" : todo.status === "completed" ? "muted" : "text";
	let content = theme.fg(color, sanitizeTerminalText(todo.content));
	if (todo.status === "completed") content = theme.strikethrough(content);
	const form = activeFormSuffix(todo);
	return `${glyph} ${content}${form ? theme.fg("muted", form) : ""}`;
}

/** `done/total completed · N in progress · M pending`, omitting zero counts. */
export function formatCountsHeader(todos: TodoList): string {
	const counts = countTodos(todos);
	const parts: string[] = [];
	if (counts.completed > 0) parts.push(`${counts.completed}/${counts.total} completed`);
	if (counts.inProgress > 0) parts.push(`${counts.inProgress} in progress`);
	if (counts.pending > 0) parts.push(`${counts.pending} pending`);
	return parts.join(" · ");
}
