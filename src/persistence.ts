/**
 * Every todo write saves a versioned custom entry on the session branch before
 * updating live state. The entry holds the normalized list and its tool-call id;
 * later tool results and wrapper records for that id cannot overwrite it.
 * Direct results and nested arguments remain a fallback for older sessions.
 *
 * `decodeSnapshot` reads the shared list shape for replay and result rendering.
 */

import { isRecord, isTodoStatus, type Todo, type TodoList } from "./model.js";

export const TOOL_NAME = "todo";
export const TODO_SNAPSHOT_TYPE = "pi-todos-snapshot";
export const TODO_SNAPSHOT_VERSION = 1;

export interface TodoDetails {
	todos: Todo[];
}

export interface TodoSnapshot extends TodoDetails {
	version: typeof TODO_SNAPSHOT_VERSION;
	toolCallId: string;
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

function decodeArguments(value: unknown): unknown {
	if (typeof value === "string") {
		try {
			return JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	return value;
}

/** Restore the latest write on the branch, preferring saved snapshots over duplicate call records. */
export function replayFromBranch(branch: Iterable<unknown>): TodoList {
	let result: TodoList = [];
	const savedCalls = new Set<string>();
	for (const entry of branch) {
		if (!isRecord(entry)) continue;
		if (entry.type === "custom" && entry.customType === TODO_SNAPSHOT_TYPE) {
			const data = entry.data;
			if (
				isRecord(data) &&
				data.version === TODO_SNAPSHOT_VERSION &&
				typeof data.toolCallId === "string" &&
				data.toolCallId.trim()
			) {
				const todos = decodeSnapshot(data);
				if (todos) {
					result = todos;
					savedCalls.add(data.toolCallId);
				}
			}
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!isRecord(msg) || msg.role !== "toolResult") continue;

		if (
			msg.toolName === TOOL_NAME &&
			!msg.isError &&
			!(typeof msg.toolCallId === "string" && savedCalls.has(msg.toolCallId))
		) {
			const todos = decodeSnapshot(msg.details);
			if (todos) result = todos;
		}

		if (isRecord(msg.nestedCalls) && Array.isArray(msg.nestedCalls.calls)) {
			for (const call of msg.nestedCalls.calls) {
				if (
					isRecord(call) &&
					call.name === TOOL_NAME &&
					call.status === "ok" &&
					!(typeof call.id === "string" && savedCalls.has(call.id))
				) {
					const todos = decodeSnapshot(decodeArguments(call.arguments));
					if (todos) result = todos;
				}
			}
		}
	}
	return result;
}
