/**
 * Every change to a task list saves the whole list as a versioned custom
 * entry on the session branch before live state is replaced. Calls made inside
 * wrapper tools such as `codemode` save their own entries too, so replay only
 * needs these entries. Custom entries never enter model context.
 */

import { EMPTY_STATE, isRecord, isTaskStatus, type Task, type TaskState } from "./model.js";

export const TASKS_SNAPSHOT_TYPE = "pi-todos-tasks";
export const TASKS_SNAPSHOT_VERSION = 1;

export interface TaskSnapshot {
	version: typeof TASKS_SNAPSHOT_VERSION;
	tasks: Task[];
	highWaterMark: number;
	/** The tool call that wrote it; absent when the extension cleared a finished list. */
	toolCallId?: string;
}

export function snapshotOf(state: TaskState, toolCallId?: string): TaskSnapshot {
	const snapshot: TaskSnapshot = {
		version: TASKS_SNAPSHOT_VERSION,
		tasks: state.tasks.map((task) => structuredClone(task)),
		highWaterMark: state.highWaterMark,
	};
	if (toolCallId !== undefined) snapshot.toolCallId = toolCallId;
	return snapshot;
}

const TASK_ID = /^[1-9][0-9]*$/;

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function decodeTask(value: unknown, highWaterMark: number): Task | undefined {
	if (!isRecord(value)) return undefined;
	const { id, subject, description, status, activeForm, owner, blocks, blockedBy, metadata } = value;
	if (typeof id !== "string" || !TASK_ID.test(id) || Number(id) > highWaterMark) return undefined;
	if (typeof subject !== "string" || typeof description !== "string" || !isTaskStatus(status)) return undefined;
	if (activeForm !== undefined && typeof activeForm !== "string") return undefined;
	if (owner !== undefined && typeof owner !== "string") return undefined;
	if (!isStringArray(blocks) || !isStringArray(blockedBy)) return undefined;
	if (metadata !== undefined && !isRecord(metadata)) return undefined;
	const task: Task = { id, subject, description, status, blocks: [...blocks], blockedBy: [...blockedBy] };
	if (activeForm !== undefined) task.activeForm = activeForm;
	if (owner !== undefined) task.owner = owner;
	if (metadata !== undefined) task.metadata = structuredClone(metadata);
	return task;
}

/** Decode a snapshot's data, or `undefined` when it is malformed or from another format version. */
export function decodeSnapshot(data: unknown): TaskState | undefined {
	if (!isRecord(data) || data.version !== TASKS_SNAPSHOT_VERSION || !Array.isArray(data.tasks)) return undefined;
	const highWaterMark = data.highWaterMark;
	if (typeof highWaterMark !== "number" || !Number.isSafeInteger(highWaterMark) || highWaterMark < 0) return undefined;
	const tasks: Task[] = [];
	const ids = new Set<string>();
	for (const item of data.tasks) {
		const task = decodeTask(item, highWaterMark);
		if (!task || ids.has(task.id)) return undefined;
		ids.add(task.id);
		tasks.push(task);
	}
	// Drop edges to tasks the snapshot does not contain, so every edge resolves.
	for (const task of tasks) {
		task.blocks = task.blocks.filter((id) => id !== task.id && ids.has(id));
		task.blockedBy = task.blockedBy.filter((id) => id !== task.id && ids.has(id));
	}
	return { tasks, highWaterMark };
}

export function isSnapshotEntry(entry: unknown): entry is { type: "custom"; customType: string; data?: unknown } {
	return isRecord(entry) && entry.type === "custom" && entry.customType === TASKS_SNAPSHOT_TYPE;
}

/** Restore the latest valid snapshot on the branch. Malformed snapshots are skipped. */
export function replayFromBranch(branch: Iterable<unknown>): TaskState {
	let result: TaskState = EMPTY_STATE;
	for (const entry of branch) {
		if (!isSnapshotEntry(entry)) continue;
		const state = decodeSnapshot(entry.data);
		if (state) result = state;
	}
	return result;
}
