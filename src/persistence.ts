/** Full branch snapshots are the only durable task state. Unsupported data fails closed. */
import { Type } from "typebox";
import { EMPTY_STATE, isRecord, type TaskState, validateGraph, validateTaskSize } from "./model.js";
import { TaskSchema, validate, validateTaskFields } from "./schema.js";

export const TASKS_SNAPSHOT_TYPE = "pi-todos-tasks";
export const TASKS_SNAPSHOT_VERSION = 2;
const SnapshotSchema = Type.Object(
	{
		version: Type.Literal(TASKS_SNAPSHOT_VERSION),
		tasks: Type.Array(TaskSchema),
		highWaterMark: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		toolCallId: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export function snapshotOf(state: TaskState, toolCallId?: string) {
	return {
		version: TASKS_SNAPSHOT_VERSION,
		tasks: structuredClone(state.tasks),
		highWaterMark: state.highWaterMark,
		...(toolCallId !== undefined && { toolCallId }),
	};
}
export function decodeSnapshot(data: unknown): TaskState {
	const snapshot = validate(SnapshotSchema, data, "snapshot");
	let previous = 0;
	for (const task of snapshot.tasks) {
		const id = Number(task.id);
		if (!Number.isSafeInteger(id) || id <= previous || id > snapshot.highWaterMark)
			throw new Error(
				"snapshot.tasks.id: must be unique, ordered, and within highWaterMark. Task state unavailable.",
			);
		previous = id;
		validateTaskFields(task, "snapshot.task");
		validateTaskSize(task);
	}
	validateGraph(snapshot);
	return { tasks: structuredClone(snapshot.tasks), highWaterMark: snapshot.highWaterMark };
}
export function replayFromBranch(branch: Iterable<unknown>): TaskState {
	let result = EMPTY_STATE;
	for (const entry of branch) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== TASKS_SNAPSHOT_TYPE) continue;
		result = decodeSnapshot(entry.data);
	}
	return result;
}
