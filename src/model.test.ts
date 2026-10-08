import { describe, expect, it } from "vitest";
import { countTodos, currentTodo, isFinished, MAX_TODOS, normalizeTodos, type Todo } from "./model.js";

describe("normalizeTodos", () => {
	it("normalizes a detached list without changing the submitted objects", () => {
		const input = [
			{ content: "  Run tests  ", status: "in_progress", activeForm: "  Running tests  " },
			{ content: "Review", status: "pending", activeForm: " \t " },
		];
		const original = structuredClone(input);
		expect(normalizeTodos(input)).toEqual([
			{ content: "Run tests", status: "in_progress", activeForm: "Running tests" },
			{ content: "Review", status: "pending" },
		]);
		expect(input).toEqual(original);
	});

	it.each([undefined, null, "[]", {}, 1])("rejects a non-array input: %j", (input) => {
		expect(() => normalizeTodos(input)).toThrow(/array/);
	});

	it.each([null, [], "task", 42])("rejects a non-object item: %j", (item) => {
		expect(() => normalizeTodos([item])).toThrow(/todos\[0\]/);
	});

	it.each([undefined, null, 1, "", " \n "])("rejects invalid content: %j", (content) => {
		expect(() => normalizeTodos([{ content, status: "pending" }])).toThrow(/content/);
	});

	it.each([undefined, null, "deleted", "done", 0])("rejects invalid status: %j", (status) => {
		expect(() => normalizeTodos([{ content: "Task", status }])).toThrow(/status/);
	});

	it("accepts the maximum list size and rejects an extra item", () => {
		const input = Array.from({ length: MAX_TODOS }, (_, i) => ({ content: `Task ${i}`, status: "pending" }));
		expect(normalizeTodos(input)).toHaveLength(MAX_TODOS);
		expect(() => normalizeTodos([...input, input[0]])).toThrow(/at most/);
	});

	it("allows an empty list and all supported statuses, but only one active item", () => {
		expect(normalizeTodos([])).toEqual([]);
		expect(
			normalizeTodos([
				{ content: "Queued", status: "pending" },
				{ content: "Working", status: "in_progress" },
				{ content: "Done", status: "completed" },
			]),
		).toHaveLength(3);
		expect(() =>
			normalizeTodos([
				{ content: "A", status: "in_progress" },
				{ content: "B", status: "in_progress" },
			]),
		).toThrow(/one.*in_progress/);
	});
});

describe("list progress", () => {
	const todos: Todo[] = [
		{ content: "Done", status: "completed" },
		{ content: "Working", status: "in_progress" },
		{ content: "Queued", status: "pending" },
		{ content: "Later", status: "pending" },
	];

	it("counts every status and finds the current item", () => {
		expect(countTodos(todos)).toEqual({ total: 4, pending: 2, inProgress: 1, completed: 1 });
		expect(currentTodo(todos)).toEqual(todos[1]);
		expect(currentTodo([todos[0]])).toBeUndefined();
	});

	it("considers only non-empty completed lists finished", () => {
		expect(isFinished(todos)).toBe(false);
		expect(isFinished([todos[0]])).toBe(true);
		expect(isFinished([])).toBe(false);
		expect(countTodos([])).toEqual({ total: 0, pending: 0, inProgress: 0, completed: 0 });
	});
});
