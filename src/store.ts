import { EMPTY_TODOS, type TodoList } from "./model.js";

/**
 * Live todo lists keyed by session id, so a detached or child session in the
 * same process can never read or overwrite another session's list.
 */
const sessions = new Map<string, TodoList>();

/**
 * The session whose list the UI shows. Renderers have no session context, so
 * the first UI-bearing session claims the foreground and later ones render
 * nothing of their own.
 */
let foreground: string | undefined;

export function getTodos(sessionId: string): TodoList {
	return sessions.get(sessionId) ?? EMPTY_TODOS;
}

export function setTodos(sessionId: string, todos: TodoList): void {
	sessions.set(sessionId, todos);
}

export function evictSession(sessionId: string): void {
	sessions.delete(sessionId);
}

export function getForeground(): string | undefined {
	return foreground;
}

export function setForeground(sessionId: string): void {
	foreground = sessionId;
}

export function clearForeground(): void {
	foreground = undefined;
}

export function getForegroundTodos(): TodoList {
	return foreground === undefined ? EMPTY_TODOS : getTodos(foreground);
}

/** Drop all module state. The store is process-global, so test isolation needs this. */
export function __resetState(): void {
	sessions.clear();
	foreground = undefined;
}
