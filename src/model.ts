/** Pure task transitions and selectors. Only final candidate states can be committed. */
import { isDeepStrictEqual } from "node:util";
import type { Static } from "typebox";
import { TASK_READ } from "./names.js";
import {
	DEFAULT_TASK_STATUS,
	type DetailPageSchema,
	LIMITS,
	type ReadInput,
	type SummaryPageSchema,
	type SummarySchema,
	type Task,
	TaskError,
	type TaskOperation,
	type TaskPatch,
	type WriteResultSchema,
} from "./schema.js";

export type { Task, TaskStatus } from "./schema.js";

export interface TaskState {
	readonly tasks: readonly Task[];
	readonly highWaterMark: number;
}
export const EMPTY_STATE: TaskState = { tasks: [], highWaterMark: 0 };
export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function findTask(state: TaskState, id: string): Task | undefined {
	return state.tasks.find((task) => task.id === id);
}
export function activeTasks(state: TaskState): Task[] {
	return state.tasks.filter((task) => task.status !== "completed");
}
export function panelTasks(state: TaskState): readonly Task[] {
	return activeTasks(state).length ? state.tasks : [];
}
export function openBlockers(state: TaskState, task: Task): string[] {
	return task.dependsOn.filter((id) => findTask(state, id)?.status !== "completed");
}
export type TaskSummary = Readonly<Static<typeof SummarySchema>>;
export function summarizeTask(state: TaskState, task: Task): TaskSummary {
	return {
		id: task.id,
		subject: task.subject,
		status: task.status,
		...(task.owner !== undefined && { owner: task.owner }),
		blockedBy: openBlockers(state, task),
	};
}
export type SummaryPage = Readonly<Static<typeof SummaryPageSchema>>;
export type DetailPage = Readonly<Static<typeof DetailPageSchema>>;
export type ReadResult = SummaryPage | DetailPage;
export function readTasks(state: TaskState, input: ReadInput): ReadResult {
	if (input.view === "details" && input.ids) {
		const selected = input.ids.map((id) => {
			const task = findTask(state, id);
			if (!task)
				throw new TaskError("not_found", "ids", `task does not exist; use ${TASK_READ} summary`, undefined, id);
			return { ...structuredClone(task), blockedBy: openBlockers(state, task) };
		});
		const tasks: DetailPage["tasks"][number][] = [];
		for (const task of selected) {
			const candidate = {
				ok: true,
				view: "details",
				tasks: [...tasks, task],
				nextIds: input.ids.slice(tasks.length + 1),
			};
			if (JSON.stringify(candidate).length > LIMITS.outputChars) break;
			tasks.push(task);
		}
		return { ok: true, view: "details", tasks, nextIds: input.ids.slice(tasks.length) };
	}
	return summarizeTasks(state, input);
}
export function summarizeTasks(state: TaskState, input: Pick<ReadInput, "scope" | "afterId"> = {}): SummaryPage {
	const scope = input.scope ?? "active";
	const selected = scope === "all" ? state.tasks : activeTasks(state);
	const remaining = selected.filter((task) => input.afterId === undefined || Number(task.id) > Number(input.afterId));
	const tasks: TaskSummary[] = [];
	const page = (): SummaryPage => ({
		ok: true,
		view: "summary",
		scope,
		tasks,
		total: selected.length,
		omitted: remaining.length - tasks.length,
		...(tasks.length < remaining.length && tasks.length > 0 && { nextAfterId: tasks[tasks.length - 1].id }),
	});
	for (const task of remaining.slice(0, LIMITS.summaryItems)) {
		tasks.push(summarizeTask(state, task));
		if (JSON.stringify(page()).length > LIMITS.summaryChars) {
			tasks.pop();
			break;
		}
	}
	return page();
}

export type WriteResult = Readonly<Static<typeof WriteResultSchema>>;
type OperationOutcome = WriteResult["outcomes"][number];
function patchTask(task: Task, patch: TaskPatch): Task {
	const result = { ...task, ...structuredClone(patch) };
	return {
		id: result.id,
		subject: result.subject,
		description: result.description,
		status: result.status,
		dependsOn: result.dependsOn,
		...(result.progress != null && { progress: result.progress }),
		...(result.activeForm != null && { activeForm: result.activeForm }),
		...(result.owner != null && { owner: result.owner }),
		...(result.metadata != null && { metadata: result.metadata }),
	};
}
export function validateTaskSize(task: Task, operationIndex?: number): void {
	if (JSON.stringify(task).length > LIMITS.taskJsonChars)
		throw new TaskError(
			"invalid_input",
			"task",
			`serialized task must fit ${LIMITS.taskJsonChars} characters`,
			operationIndex,
			task.id,
		);
}

/** Check graph invariants once on the final graph, including after snapshot decoding. */
export function validateGraph(state: TaskState): void {
	const byId = new Map(state.tasks.map((task) => [task.id, task]));
	const pending = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const task of state.tasks) {
		pending.set(task.id, task.dependsOn.length);
		for (const id of task.dependsOn) {
			if (!byId.has(id) || id === task.id)
				throw new TaskError(
					"invalid_graph",
					"dependsOn",
					"prerequisites must exist and differ from the task",
					undefined,
					task.id,
				);
			const rows = dependents.get(id) ?? [];
			rows.push(task.id);
			dependents.set(id, rows);
		}
	}
	const ready = state.tasks.filter((task) => task.dependsOn.length === 0).map((task) => task.id);
	for (let index = 0; index < ready.length; index++) {
		for (const id of dependents.get(ready[index]) ?? []) {
			// Every dependent was inserted into pending while validating the graph.
			const count = pending.get(id)!;
			pending.set(id, count - 1);
			if (count === 1) ready.push(id);
		}
	}
	if (ready.length !== state.tasks.length)
		throw new TaskError("invalid_graph", "dependsOn", "dependencies must not contain a cycle");
}

export function applyOperations(
	state: TaskState,
	operations: readonly TaskOperation[],
): { state: TaskState; result: WriteResult } {
	const originalIds = new Set(state.tasks.map((task) => task.id));
	let tasks = [...state.tasks];
	let highWaterMark = state.highWaterMark;
	const outcomes: OperationOutcome[] = [];
	for (const [operationIndex, operation] of operations.entries()) {
		const patch =
			operation.action === "create" ? operation.task : operation.action === "update" ? operation.set : undefined;
		for (const id of patch?.dependsOn ?? []) {
			if (!originalIds.has(id))
				throw new TaskError("not_found", "dependsOn", "ID must exist before this request", operationIndex, id);
		}
		if (operation.action === "create") {
			if (!Number.isSafeInteger(++highWaterMark))
				throw new TaskError("invalid_input", "id", "task ID space exhausted", operationIndex);
			const task = patchTask(
				{
					id: String(highWaterMark),
					subject: operation.task.subject,
					description: operation.task.description,
					status: DEFAULT_TASK_STATUS,
					dependsOn: [],
				},
				operation.task,
			);
			validateTaskSize(task, operationIndex);
			tasks.push(task);
			outcomes.push({ action: operation.action, id: task.id, changed: true });
			continue;
		}
		const current = tasks.find((task) => task.id === operation.id);
		if (!current || !originalIds.has(operation.id))
			throw new TaskError(
				"not_found",
				"id",
				"ID must exist before this request and not have been deleted",
				operationIndex,
				operation.id,
			);
		if (operation.action === "delete") {
			tasks = tasks
				.filter((task) => task.id !== operation.id)
				.map((task) => ({ ...task, dependsOn: task.dependsOn.filter((id) => id !== operation.id) }));
			outcomes.push({ action: operation.action, id: operation.id, changed: true });
		} else {
			const task = patchTask(current, operation.set);
			validateTaskSize(task, operationIndex);
			tasks = tasks.map((other) => (other.id === task.id ? task : other));
			outcomes.push({ action: operation.action, id: task.id, changed: !isDeepStrictEqual(task, current) });
		}
	}
	const candidate = { tasks, highWaterMark };
	validateGraph(candidate);
	const changed = !isDeepStrictEqual(state, candidate);
	const final = changed ? candidate : state;
	const active = summarizeTasks(final);
	const next = activeTasks(final).find(
		(task) => task.status === "pending" && task.owner === undefined && openBlockers(final, task).length === 0,
	);
	return {
		state: final,
		result: { ok: true, changed, outcomes, active, ...(next && { nextReady: summarizeTask(final, next) }) },
	};
}

export interface TaskCounts {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
}
export function countTasks(tasks: readonly Task[]): TaskCounts {
	const counts = { total: tasks.length, pending: 0, inProgress: 0, completed: 0 };
	for (const task of tasks) {
		if (task.status === "pending") counts.pending++;
		else if (task.status === "in_progress") counts.inProgress++;
		else counts.completed++;
	}
	return counts;
}
