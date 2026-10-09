import { EMPTY_STATE, type TaskState } from "./model.js";

/**
 * Live task lists keyed by session id, so a detached or child session in the
 * same process can never read or overwrite another session's list.
 */
const sessions = new Map<string, TaskState>();

/**
 * The session whose list the UI shows. Renderers have no session context, so
 * the first UI-bearing session claims the foreground and later ones render
 * nothing of their own.
 */
let foreground: string | undefined;

export function getTaskState(sessionId: string): TaskState {
	return sessions.get(sessionId) ?? EMPTY_STATE;
}

export function setTaskState(sessionId: string, state: TaskState): void {
	sessions.set(sessionId, state);
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

export function getForegroundState(): TaskState {
	return foreground === undefined ? EMPTY_STATE : getTaskState(foreground);
}

/** Drop all module state. The store is process-global, so test isolation needs this. */
export function __resetState(): void {
	sessions.clear();
	foreground = undefined;
}
