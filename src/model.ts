/**
 * The task list domain, modeled on Claude Code's task tools: tasks with
 * sequential string ids, partial updates, two-way dependency edges and
 * deletion through a `deleted` status. Operations never mutate their input
 * state; they return a new one, so a snapshot can be saved before live state
 * changes.
 */

export const TASK_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Status value that removes a task instead of storing it. */
export const DELETED_STATUS = "deleted";
export const TASK_UPDATE_STATUSES = [...TASK_STATUSES, DELETED_STATUS] as const;
export type TaskUpdateStatus = (typeof TASK_UPDATE_STATUSES)[number];

export interface Task {
	id: string;
	subject: string;
	description: string;
	/** Present-continuous label shown while the task is in_progress. */
	activeForm?: string;
	owner?: string;
	status: TaskStatus;
	/** Ids of tasks that cannot start until this one completes. */
	blocks: string[];
	/** Ids of tasks that must complete before this one can start. */
	blockedBy: string[];
	metadata?: Record<string, unknown>;
}

export interface TaskState {
	/** Tasks in creation order, which is also id order. */
	readonly tasks: readonly Task[];
	/** Highest id ever assigned. Ids are never reused, even after deletion or a reset. */
	readonly highWaterMark: number;
}

export const EMPTY_STATE: TaskState = Object.freeze({ tasks: Object.freeze([]) as readonly Task[], highWaterMark: 0 });

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
	return (TASK_STATUSES as readonly unknown[]).includes(value);
}

/** Tasks with `metadata._internal: true` are bookkeeping: hidden from TaskList, the overlay and counts. */
export function isVisible(task: Task): boolean {
	return task.metadata?._internal !== true;
}

export function visibleTasks(state: TaskState): Task[] {
	return state.tasks.filter(isVisible);
}

export function findTask(state: TaskState, id: string): Task | undefined {
	return state.tasks.find((task) => task.id === id);
}

/** The task's blockers that still exist and are not completed. */
export function openBlockers(state: TaskState, task: Task): string[] {
	return task.blockedBy.filter((id) => {
		const blocker = findTask(state, id);
		return blocker !== undefined && blocker.status !== "completed";
	});
}

/** One TaskList row: a visible task with only its open blockers. */
export interface TaskSummary {
	id: string;
	subject: string;
	status: TaskStatus;
	owner?: string;
	blockedBy: string[];
}

export function summarizeTasks(state: TaskState): TaskSummary[] {
	return visibleTasks(state).map((task) => {
		const summary: TaskSummary = {
			id: task.id,
			subject: task.subject,
			status: task.status,
			blockedBy: openBlockers(state, task),
		};
		if (task.owner !== undefined) summary.owner = task.owner;
		return summary;
	});
}

/** Shallow-merge `patch` into `base`; a `null` value removes that key. An empty result is `undefined`. */
function mergeMetadata(
	base: Record<string, unknown> | undefined,
	patch: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete merged[key];
		else merged[key] = value;
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}

function copyTask(task: Task): Task {
	return { ...task, blocks: [...task.blocks], blockedBy: [...task.blockedBy] };
}

export interface CreateTaskInput {
	subject: string;
	description: string;
	activeForm?: string;
	metadata?: Record<string, unknown>;
}

/** Append a pending task with the next id. */
export function createTask(state: TaskState, input: CreateTaskInput): { state: TaskState; task: Task } {
	const highWaterMark = state.highWaterMark + 1;
	if (!Number.isSafeInteger(highWaterMark)) throw new Error("task id space exhausted");
	const task: Task = {
		id: String(highWaterMark),
		subject: input.subject,
		description: input.description,
		status: "pending",
		blocks: [],
		blockedBy: [],
	};
	if (input.activeForm !== undefined) task.activeForm = input.activeForm;
	const metadata = input.metadata && mergeMetadata(undefined, input.metadata);
	if (metadata) task.metadata = metadata;
	return { state: { tasks: [...state.tasks, task], highWaterMark }, task };
}

export interface UpdateTaskInput {
	taskId: string;
	subject?: string;
	description?: string;
	activeForm?: string;
	owner?: string;
	status?: TaskUpdateStatus;
	addBlocks?: string[];
	addBlockedBy?: string[];
	metadata?: Record<string, unknown>;
}

/** Field names reported by an update. The order is the order Claude Code reports them in. */
export type UpdatedField =
	| "subject"
	| "description"
	| "activeForm"
	| "owner"
	| "metadata"
	| "status"
	| "blocks"
	| "blockedBy"
	| typeof DELETED_STATUS;

export interface UpdateOutcome {
	success: boolean;
	taskId: string;
	updatedFields: UpdatedField[];
	error?: string;
	statusChange?: { from: TaskStatus; to: TaskUpdateStatus };
}

export const TASK_NOT_FOUND = "Task not found";

/** Remove a task and every edge that points at it. */
function deleteTask(state: TaskState, id: string): TaskState {
	const tasks = state.tasks
		.filter((task) => task.id !== id)
		.map((task) =>
			task.blocks.includes(id) || task.blockedBy.includes(id)
				? {
						...task,
						blocks: task.blocks.filter((other) => other !== id),
						blockedBy: task.blockedBy.filter((other) => other !== id),
					}
				: task,
		);
	return { tasks, highWaterMark: state.highWaterMark };
}

/**
 * Apply a partial update. Only fields that change are reported, except
 * `metadata`, which is reported whenever it is given. Status transitions are
 * not restricted. New edges are recorded on both tasks; ids that do not exist,
 * and the task's own id, are skipped. Setting `deleted` removes the task and
 * ignores the other fields.
 */
export function updateTask(state: TaskState, input: UpdateTaskInput): { state: TaskState; outcome: UpdateOutcome } {
	const current = findTask(state, input.taskId);
	if (!current) {
		return {
			state,
			outcome: { success: false, taskId: input.taskId, updatedFields: [], error: TASK_NOT_FOUND },
		};
	}
	if (input.status === DELETED_STATUS) {
		return {
			state: deleteTask(state, current.id),
			outcome: {
				success: true,
				taskId: current.id,
				updatedFields: [DELETED_STATUS],
				statusChange: { from: current.status, to: DELETED_STATUS },
			},
		};
	}

	const tasks = state.tasks.map(copyTask);
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const task = byId.get(current.id)!;
	const updatedFields: UpdatedField[] = [];
	let statusChange: UpdateOutcome["statusChange"];

	if (input.subject !== undefined && input.subject !== task.subject) {
		task.subject = input.subject;
		updatedFields.push("subject");
	}
	if (input.description !== undefined && input.description !== task.description) {
		task.description = input.description;
		updatedFields.push("description");
	}
	if (input.activeForm !== undefined && input.activeForm !== task.activeForm) {
		task.activeForm = input.activeForm;
		updatedFields.push("activeForm");
	}
	if (input.owner !== undefined && input.owner !== task.owner) {
		task.owner = input.owner;
		updatedFields.push("owner");
	}
	if (input.metadata !== undefined) {
		const metadata = mergeMetadata(task.metadata, input.metadata);
		if (metadata) task.metadata = metadata;
		else delete task.metadata;
		updatedFields.push("metadata");
	}
	if (input.status !== undefined && input.status !== task.status) {
		statusChange = { from: task.status, to: input.status };
		task.status = input.status;
		updatedFields.push("status");
	}

	const link = (blocker: Task, blocked: Task): boolean => {
		const added = !blocker.blocks.includes(blocked.id) || !blocked.blockedBy.includes(blocker.id);
		if (!blocker.blocks.includes(blocked.id)) blocker.blocks.push(blocked.id);
		if (!blocked.blockedBy.includes(blocker.id)) blocked.blockedBy.push(blocker.id);
		return added;
	};
	const others = (ids: string[] | undefined): Task[] =>
		(ids ?? []).flatMap((id) => {
			const other = id === task.id ? undefined : byId.get(id);
			return other ? [other] : [];
		});
	let blocksAdded = false;
	for (const blocked of others(input.addBlocks)) blocksAdded = link(task, blocked) || blocksAdded;
	if (blocksAdded) updatedFields.push("blocks");
	let blockedByAdded = false;
	for (const blocker of others(input.addBlockedBy)) blockedByAdded = link(blocker, task) || blockedByAdded;
	if (blockedByAdded) updatedFields.push("blockedBy");

	const outcome: UpdateOutcome = { success: true, taskId: task.id, updatedFields };
	if (statusChange) outcome.statusChange = statusChange;
	return { state: { tasks, highWaterMark: state.highWaterMark }, outcome };
}

/** Clear every task while keeping the id high-water mark, so later ids stay unique. */
export function resetTasks(state: TaskState): TaskState {
	return { tasks: [], highWaterMark: state.highWaterMark };
}

/** A non-empty visible list whose tasks are all completed. */
export function isFinished(state: TaskState): boolean {
	const visible = visibleTasks(state);
	return visible.length > 0 && visible.every((task) => task.status === "completed");
}

export interface TaskCounts {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
}

export function countTasks(tasks: readonly Task[]): TaskCounts {
	const counts: TaskCounts = { total: tasks.length, pending: 0, inProgress: 0, completed: 0 };
	for (const task of tasks) {
		if (task.status === "pending") counts.pending++;
		else if (task.status === "in_progress") counts.inProgress++;
		else counts.completed++;
	}
	return counts;
}
