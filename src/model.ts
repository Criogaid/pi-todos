/**
 * The todo list domain: one ordered list, replaced as a whole by every `todo`
 * call. There are no ids, tombstones or dependency edges — the model always
 * sends the complete list, so there is a single write path and a single place
 * where invariants are checked.
 */

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface Todo {
	content: string;
	status: TodoStatus;
	/** Present-continuous label shown while the item is in_progress. */
	activeForm?: string;
}

export type TodoList = readonly Todo[];

export const EMPTY_TODOS: TodoList = Object.freeze([]);

/** Upper bound for one list; a longer checklist is not a useful progress view. */
export const MAX_TODOS = 100;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isTodoStatus(value: unknown): value is TodoStatus {
	return (TODO_STATUSES as readonly unknown[]).includes(value);
}

/**
 * Validate and normalize a list submitted by the model. Throws with a
 * model-facing message; Pi turns a thrown error into a failed tool result.
 */
export function normalizeTodos(input: unknown): Todo[] {
	if (!Array.isArray(input)) throw new Error("todos must be an array");
	if (input.length > MAX_TODOS) throw new Error(`todos must have at most ${MAX_TODOS} items`);
	const todos = input.map((raw, index): Todo => {
		if (!isRecord(raw)) throw new Error(`todos[${index}] must be an object`);
		const content = typeof raw.content === "string" ? raw.content.trim() : "";
		if (!content) throw new Error(`todos[${index}].content must be a non-blank string`);
		if (!isTodoStatus(raw.status)) {
			throw new Error(`todos[${index}].status must be one of ${TODO_STATUSES.join(", ")}`);
		}
		const todo: Todo = { content, status: raw.status };
		const activeForm = typeof raw.activeForm === "string" ? raw.activeForm.trim() : "";
		if (activeForm) todo.activeForm = activeForm;
		return todo;
	});
	if (todos.filter((todo) => todo.status === "in_progress").length > 1) {
		throw new Error("at most one todo can be in_progress");
	}
	return todos;
}

export interface TodoCounts {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
}

export function countTodos(todos: TodoList): TodoCounts {
	const counts: TodoCounts = { total: todos.length, pending: 0, inProgress: 0, completed: 0 };
	for (const todo of todos) {
		if (todo.status === "pending") counts.pending++;
		else if (todo.status === "in_progress") counts.inProgress++;
		else counts.completed++;
	}
	return counts;
}

export function currentTodo(todos: TodoList): Todo | undefined {
	return todos.find((todo) => todo.status === "in_progress");
}

/** A non-empty list whose items are all completed. */
export function isFinished(todos: TodoList): boolean {
	return todos.length > 0 && todos.every((todo) => todo.status === "completed");
}
