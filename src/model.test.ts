import { describe, expect, it } from "vitest";
import { makeState, makeTask } from "../test/helpers/index.js";
import {
	countTasks,
	createTask,
	EMPTY_STATE,
	findTask,
	isFinished,
	isTaskStatus,
	isVisible,
	openBlockers,
	resetTasks,
	summarizeTasks,
	TASK_STATUSES,
	updateTask,
	visibleTasks,
} from "./model.js";

describe("task creation and identity", () => {
	it("appends a pending task without changing existing tasks or the input", () => {
		const original = makeState([makeTask("2")], 5);
		const before = structuredClone(original);
		const input = {
			subject: "Write tests",
			description: "Exercise the public behavior",
			activeForm: "Writing tests",
			metadata: { area: "test", remove: null },
		};
		const result = createTask(original, input);
		expect(result.task).toEqual({
			id: "6",
			subject: input.subject,
			description: input.description,
			activeForm: input.activeForm,
			metadata: { area: "test" },
			status: "pending",
			blocks: [],
			blockedBy: [],
		});
		expect(result.state.tasks).toEqual([...original.tasks, result.task]);
		expect(result.state.highWaterMark).toBe(6);
		expect(original).toEqual(before);
		expect(input.metadata).toEqual({ area: "test", remove: null });
	});

	it.each([undefined, {}, { removed: null }])("omits empty metadata: %j", (metadata) => {
		expect(createTask(EMPTY_STATE, { subject: "Task", description: "Details", metadata }).task).not.toHaveProperty(
			"metadata",
		);
	});

	it("never reuses an id after deletion or reset", () => {
		const first = createTask(EMPTY_STATE, { subject: "First", description: "" });
		const deleted = updateTask(first.state, { taskId: first.task.id, status: "deleted" }).state;
		const second = createTask(deleted, { subject: "Second", description: "" });
		const reset = resetTasks(second.state);
		expect(reset.tasks).toEqual([]);
		expect(reset.highWaterMark).toBe(second.state.highWaterMark);
		const third = createTask(reset, { subject: "Third", description: "" });
		expect([first.task.id, second.task.id, third.task.id]).toEqual(["1", "2", "3"]);
	});

	it("stops before assigning an unsafe numeric id", () => {
		const state = makeState([], Number.MAX_SAFE_INTEGER - 1);
		const last = createTask(state, { subject: "Last", description: "" });
		expect(last.task.id).toBe(String(Number.MAX_SAFE_INTEGER));
		expect(() => createTask(last.state, { subject: "Overflow", description: "" })).toThrow("task id space exhausted");
	});
});

describe("partial task updates", () => {
	it("returns the unchanged state for an unknown id", () => {
		const original = makeState([makeTask()]);
		const result = updateTask(original, { taskId: "99", subject: "Missing" });
		expect(result.state).toBe(original);
		expect(result.outcome).toEqual({ success: false, taskId: "99", updatedFields: [], error: "Task not found" });
	});

	it("reports changed fields in the caller-facing order", () => {
		const original = makeState([makeTask("1"), makeTask("2"), makeTask("3")]);
		const before = structuredClone(original);
		const result = updateTask(original, {
			taskId: "1",
			addBlockedBy: ["3"],
			addBlocks: ["2"],
			status: "in_progress",
			metadata: { priority: 1 },
			owner: "agent",
			activeForm: "Working",
			description: "New details",
			subject: "New subject",
		});
		expect(result.outcome).toEqual({
			success: true,
			taskId: "1",
			updatedFields: ["subject", "description", "activeForm", "owner", "metadata", "status", "blocks", "blockedBy"],
			statusChange: { from: "pending", to: "in_progress" },
		});
		expect(findTask(result.state, "1")).toMatchObject({
			subject: "New subject",
			description: "New details",
			activeForm: "Working",
			owner: "agent",
			metadata: { priority: 1 },
			status: "in_progress",
			blocks: ["2"],
			blockedBy: ["3"],
		});
		expect(original).toEqual(before);
	});

	it("does not report identical fields or ignored dependency ids", () => {
		const task = makeTask("1", { owner: "agent", activeForm: "Working" });
		const original = makeState([task]);
		const result = updateTask(original, {
			taskId: "1",
			subject: task.subject,
			description: task.description,
			activeForm: task.activeForm,
			owner: task.owner,
			status: task.status,
			addBlocks: ["1", "missing"],
			addBlockedBy: [],
		});
		expect(result.outcome).toEqual({ success: true, taskId: "1", updatedFields: [] });
		expect(result.state).toEqual(original);
	});

	it.each(TASK_STATUSES.flatMap((from) => TASK_STATUSES.map((to) => ({ from, to }))))(
		"allows $from to $to",
		({ from, to }) => {
			const result = updateTask(makeState([makeTask("1", { status: from })]), { taskId: "1", status: to });
			expect(result.state.tasks[0].status).toBe(to);
			expect(result.outcome.updatedFields).toEqual(from === to ? [] : ["status"]);
			if (from === to) expect(result.outcome).not.toHaveProperty("statusChange");
			else expect(result.outcome.statusChange).toEqual({ from, to });
		},
	);

	it("shallow-merges metadata, deletes null keys and always reports metadata", () => {
		const original = makeState([makeTask("1", { metadata: { keep: 1, remove: "old", nested: { old: true } } })]);
		const before = structuredClone(original);
		const merged = updateTask(original, { taskId: "1", metadata: { remove: null, nested: { new: true } } });
		expect(merged.state.tasks[0].metadata).toEqual({ keep: 1, nested: { new: true } });
		expect(merged.outcome.updatedFields).toEqual(["metadata"]);
		const unchanged = updateTask(merged.state, { taskId: "1", metadata: {} });
		expect(unchanged.outcome.updatedFields).toEqual(["metadata"]);
		const empty = updateTask(merged.state, { taskId: "1", metadata: { keep: null, nested: null } });
		expect(empty.state.tasks[0]).not.toHaveProperty("metadata");
		expect(original).toEqual(before);
	});

	it.each(["addBlocks", "addBlockedBy"] as const)(
		"deduplicates %s and records both sides without mutating input",
		(field) => {
			const original = makeState([makeTask("1"), makeTask("2")]);
			const before = structuredClone(original);
			const result = updateTask(original, { taskId: "1", [field]: ["2", "2", "1", "missing"] });
			const [first, second] = result.state.tasks;
			if (field === "addBlocks") {
				expect(first.blocks).toEqual(["2"]);
				expect(second.blockedBy).toEqual(["1"]);
			} else {
				expect(first.blockedBy).toEqual(["2"]);
				expect(second.blocks).toEqual(["1"]);
			}
			expect(result.outcome.updatedFields).toEqual([field === "addBlocks" ? "blocks" : "blockedBy"]);
			expect(updateTask(result.state, { taskId: "1", [field]: ["2"] }).outcome.updatedFields).toEqual([]);
			expect(original).toEqual(before);
		},
	);

	it.each(["addBlocks", "addBlockedBy"] as const)("repairs the missing reciprocal side for %s", (field) => {
		const original = makeState([
			makeTask("1", field === "addBlocks" ? { blocks: ["2"] } : { blockedBy: ["2"] }),
			makeTask("2"),
		]);
		const before = structuredClone(original);
		const result = updateTask(original, { taskId: "1", [field]: ["2"] });
		expect(result.outcome.updatedFields).toEqual([field === "addBlocks" ? "blocks" : "blockedBy"]);
		expect(field === "addBlocks" ? result.state.tasks[1].blockedBy : result.state.tasks[1].blocks).toEqual(["1"]);
		expect(original).toEqual(before);
	});

	it.each(TASK_STATUSES)("deletes a %s task, cleans all edges and ignores extra fields", (status) => {
		const original = makeState([
			makeTask("1", { blocks: ["2"] }),
			makeTask("2", { status, blockedBy: ["1"], blocks: ["3"] }),
			makeTask("3", { blockedBy: ["2"] }),
		]);
		const before = structuredClone(original);
		const result = updateTask(original, {
			taskId: "2",
			status: "deleted",
			subject: "Ignored",
			metadata: { ignored: true },
			addBlocks: ["1"],
		});
		expect(result.outcome).toEqual({
			success: true,
			taskId: "2",
			updatedFields: ["deleted"],
			statusChange: { from: status, to: "deleted" },
		});
		expect(result.state.tasks).toEqual([makeTask("1"), makeTask("3")]);
		expect(result.state.highWaterMark).toBe(3);
		expect(original).toEqual(before);
	});
});

describe("task visibility and summaries", () => {
	it("omits internal tasks and completed or missing blockers from summaries", () => {
		const state = makeState([
			makeTask("1", { status: "completed" }),
			makeTask("2", { status: "in_progress" }),
			makeTask("3", { owner: "agent", blockedBy: ["1", "2", "missing"] }),
			makeTask("4", { metadata: { _internal: true } }),
		]);
		expect(visibleTasks(state).map((task) => task.id)).toEqual(["1", "2", "3"]);
		expect(openBlockers(state, state.tasks[2])).toEqual(["2"]);
		expect(summarizeTasks(state)).toEqual([
			{ id: "1", subject: "Task 1", status: "completed", blockedBy: [] },
			{ id: "2", subject: "Task 2", status: "in_progress", blockedBy: [] },
			{ id: "3", subject: "Task 3", status: "pending", owner: "agent", blockedBy: ["2"] },
		]);
		expect(isVisible(makeTask("5", { metadata: { _internal: "true" } }))).toBe(true);
	});

	it("counts statuses and considers only a non-empty visible completed list finished", () => {
		expect(
			countTasks([makeTask("1"), makeTask("2", { status: "in_progress" }), makeTask("3", { status: "completed" })]),
		).toEqual({ total: 3, pending: 1, inProgress: 1, completed: 1 });
		expect(isFinished(EMPTY_STATE)).toBe(false);
		expect(isFinished(makeState([makeTask("1", { metadata: { _internal: true } })]))).toBe(false);
		expect(
			isFinished(
				makeState([makeTask("1", { status: "completed" }), makeTask("2", { metadata: { _internal: true } })]),
			),
		).toBe(true);
		expect(isFinished(makeState([makeTask("1")]))).toBe(false);
		expect(isTaskStatus("deleted")).toBe(false);
		expect(findTask(EMPTY_STATE, "missing")).toBeUndefined();
	});
});
