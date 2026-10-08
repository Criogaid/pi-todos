import { describe, expect, it } from "vitest";
import type { Todo } from "./model.js";
import {
	clearForeground,
	evictSession,
	getForeground,
	getForegroundTodos,
	getTodos,
	setForeground,
	setTodos,
} from "./store.js";

describe("session store", () => {
	it("keeps replacements, clearing and eviction local to the specified session", () => {
		const parent: Todo[] = [{ content: "Parent", status: "pending" }];
		const child: Todo[] = [{ content: "Child", status: "completed" }];
		expect(getTodos("missing")).toEqual([]);
		setTodos("parent", parent);
		setTodos("child", child);
		setTodos("parent", []);
		expect(getTodos("parent")).toEqual([]);
		expect(getTodos("child")).toEqual(child);
		evictSession("child");
		expect(getTodos("child")).toEqual([]);
	});

	it("renders only the explicitly selected foreground list", () => {
		setTodos("a", [{ content: "A", status: "pending" }]);
		setTodos("b", [{ content: "B", status: "in_progress" }]);
		expect(getForeground()).toBeUndefined();
		expect(getForegroundTodos()).toEqual([]);
		setForeground("a");
		expect(getForegroundTodos()).toEqual(getTodos("a"));
		setForeground("b");
		expect(getForegroundTodos()).toEqual(getTodos("b"));
		clearForeground();
		expect(getForegroundTodos()).toEqual([]);
		expect(getTodos("b")).toHaveLength(1);
	});
});
