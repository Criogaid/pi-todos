/**
 * Pi persists every tool result in the session branch. A successful `todo`
 * result carries the complete list in `details`, so the latest such result is
 * the session's todo list — no separate storage, and branch navigation simply
 * picks a different latest result.
 *
 * `decodeSnapshot` is the only reader of persisted data; replay and the result
 * renderer share it.
 */

import { isRecord, isTodoStatus, type Todo, type TodoList } from "./model.js";

export const TOOL_NAME = "todo";

export interface TodoDetails {
	todos: Todo[];
}

function decodeTodo(value: unknown): Todo | undefined {
	if (!isRecord(value) || typeof value.content !== "string" || !value.content.trim()) return undefined;
	if (!isTodoStatus(value.status)) return undefined;
	if (value.activeForm !== undefined && typeof value.activeForm !== "string") return undefined;
	const todo: Todo = { content: value.content, status: value.status };
	if (value.activeForm) todo.activeForm = value.activeForm;
	return todo;
}

/** Decode a result's `details` into a todo list, or `undefined` when it is not a valid snapshot. */
export function decodeSnapshot(details: unknown): Todo[] | undefined {
	if (!isRecord(details) || !Array.isArray(details.todos)) return undefined;
	const todos: Todo[] = [];
	for (const item of details.todos) {
		const todo = decodeTodo(item);
		if (!todo) return undefined;
		todos.push(todo);
	}
	return todos;
}

/** Restore the list from the last valid successful `todo` result on the branch. */
export function replayFromBranch(branch: Iterable<unknown>): TodoList {
	let result: TodoList = [];
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const msg = entry.message;
		if (!isRecord(msg) || msg.role !== "toolResult" || msg.toolName !== TOOL_NAME || msg.isError) continue;
		const todos = decodeSnapshot(msg.details);
		if (todos) result = todos;
	}
	return result;
}
