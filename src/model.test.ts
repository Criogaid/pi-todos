import { describe, expect, it } from "vitest";
import { makeState, makeTask } from "../test/helpers/index.js";
import { activeTasks, applyOperations, EMPTY_STATE, openBlockers, panelTasks, readTasks } from "./model.js";
import { LIMITS, parseWrite, TASK_STATUSES, TaskError } from "./schema.js";

const create = (subject: string) => ({
	action: "create" as const,
	task: { subject, description: `Requirements for ${subject}` },
});
describe("atomic task transitions", () => {
	it("completes, starts, and creates together with final-state hints", () => {
		const original = makeState([makeTask("1", { status: "in_progress" }), makeTask("2", { dependsOn: ["1"] })]);
		const before = structuredClone(original);
		const result = applyOperations(original, [
			{ action: "update", id: "1", set: { status: "completed", progress: "Verified" } },
			{ action: "update", id: "2", set: { status: "in_progress" } },
			create("Follow-up"),
		]);
		expect(original).toEqual(before);
		expect(result.state.tasks.map((task) => task.status)).toEqual(["completed", "in_progress", "pending"]);
		expect(result.result.nextReady?.id).toBe("3");
		expect(result.result.active.tasks.map((task) => task.id)).toEqual(["2", "3"]);
		expect(result.state.tasks[0].description).toBe(original.tasks[0].description);
	});
	it("rolls back earlier operations and allocated IDs on a middle failure", () => {
		const state = makeState([makeTask()]);
		expect(() =>
			applyOperations(state, [create("New"), { action: "update", id: "99", set: {} }, create("Later")]),
		).toThrow(TaskError);
		expect(state.tasks).toHaveLength(1);
		expect(applyOperations(state, [create("Retry")]).result.outcomes[0].id).toBe("2");
	});
	it("rejects references to IDs allocated in the same request and updates after deletion", () => {
		expect(() => applyOperations(EMPTY_STATE, [create("First"), { action: "update", id: "1", set: {} }])).toThrow(
			TaskError,
		);
		expect(() =>
			applyOperations(EMPTY_STATE, [
				create("First"),
				{ action: "create", task: { subject: "Next", description: "Details", dependsOn: ["1"] } },
			]),
		).toThrow(TaskError);
		expect(() =>
			applyOperations(makeState([makeTask()]), [
				{ action: "delete", id: "1" },
				{ action: "update", id: "1", set: {} },
			]),
		).toThrow(TaskError);
	});
	it("replaces dependencies, accepts final graph repairs, and rejects unresolved cycles", () => {
		const state = makeState([makeTask("1", { dependsOn: ["2"] }), makeTask("2"), makeTask("3")]);
		const ops = [{ action: "update" as const, id: "2", set: { dependsOn: ["1"] } }];
		expect(() => applyOperations(state, ops)).toThrow(TaskError);
		const final = applyOperations(state, [...ops, { action: "update", id: "1", set: { dependsOn: ["3"] } }]).state;
		expect(final.tasks.map((task) => task.dependsOn)).toEqual([["3"], ["1"], []]);
		for (const dependsOn of [["1"], ["99"]])
			expect(() => applyOperations(state, [{ action: "update", id: "1", set: { dependsOn } }])).toThrow(TaskError);
	});
	it("replaces metadata and clears optional fields without erasing requirements", () => {
		const state = makeState([makeTask("1", { metadata: { old: true }, owner: "agent", progress: "Old" })]);
		const changed = applyOperations(state, [
			{
				action: "update",
				id: "1",
				set: { metadata: { value: null, _internal: true }, owner: null, progress: "New" },
			},
		]).state;
		expect(changed.tasks[0]).toMatchObject({
			metadata: { value: null, _internal: true },
			progress: "New",
			description: "Details 1",
		});
		expect(changed.tasks[0]).not.toHaveProperty("owner");
		expect(activeTasks(changed)).toHaveLength(1);
		expect(
			applyOperations(changed, [{ action: "update", id: "1", set: { metadata: null } }]).state.tasks[0],
		).not.toHaveProperty("metadata");
	});
	it("recognizes net no-ops including reordered metadata keys", () => {
		const state = makeState([makeTask("1", { metadata: { a: 1, b: 2 } })]);
		const result = applyOperations(state, [
			{ action: "update", id: "1", set: { status: "completed" } },
			{ action: "update", id: "1", set: { status: "pending", metadata: { b: 2, a: 1 } } },
		]);
		expect(result.state).toBe(state);
		expect(result.result.changed).toBe(false);
	});
	it("deletes references without reusing IDs and rejects exhausted IDs", () => {
		const state = makeState([makeTask("1"), makeTask("2", { dependsOn: ["1"] })]);
		const final = applyOperations(state, [{ action: "delete", id: "1" }]).state;
		expect(final.tasks[0].dependsOn).toEqual([]);
		expect(applyOperations(final, [create("New")]).result.outcomes[0].id).toBe("3");
		expect(() => applyOperations(makeState([], Number.MAX_SAFE_INTEGER), [create("Overflow")])).toThrow(TaskError);
	});
	it.each(TASK_STATUSES.flatMap((from) => TASK_STATUSES.map((to) => ({ from, to }))))(
		"allows $from to $to",
		({ from, to }) => {
			const state = makeState([
				makeTask("1", { status: from }),
				makeTask("2", { dependsOn: ["1"], status: "completed" }),
			]);
			const final = applyOperations(state, [{ action: "update", id: "1", set: { status: to } }]).state;
			expect(final.tasks[0].status).toBe(to);
			expect(final.tasks[1].status).toBe("completed");
			expect(openBlockers(final, final.tasks[1])).toEqual(to === "completed" ? [] : ["1"]);
		},
	);
});
describe("bounded shared views", () => {
	it("hides completed-only panels but retains readable and reopenable tasks", () => {
		const state = makeState([makeTask("1", { status: "completed" })]);
		expect(panelTasks(state)).toEqual([]);
		expect(readTasks(state, {}).tasks).toEqual([]);
		expect(readTasks(state, { scope: "all" }).tasks).toHaveLength(1);
		expect(
			panelTasks(applyOperations(state, [{ action: "update", id: "1", set: { status: "in_progress" } }]).state),
		).toHaveLength(1);
	});
	it("paginates by numeric creation ID without losing or duplicating tasks", () => {
		const state = makeState(Array.from({ length: LIMITS.summaryItems + 3 }, (_, i) => makeTask(String(i + 1))));
		const first = readTasks(state, {});
		if (first.view !== "summary") throw new Error("expected summary");
		const second = readTasks(state, { afterId: first.nextAfterId });
		expect([...first.tasks, ...second.tasks].map((task) => task.id)).toEqual(state.tasks.map((task) => task.id));
	});
	it("returns complete detail records with explicit continuation under the output budget", () => {
		const state = makeState(
			Array.from({ length: LIMITS.selectedIds }, (_, i) =>
				makeTask(String(i + 1), {
					description: "x".repeat(LIMITS.descriptionChars),
					progress: "y".repeat(LIMITS.progressChars),
				}),
			),
		);
		let ids = state.tasks.map((task) => task.id);
		const found = [];
		while (ids.length) {
			const page = readTasks(state, { view: "details", ids });
			if (page.view !== "details") throw new Error("expected details");
			expect(page.tasks.length).toBeGreaterThan(0);
			expect(JSON.stringify(page).length).toBeLessThanOrEqual(LIMITS.outputChars);
			found.push(...page.tasks);
			ids = page.nextIds;
		}
		expect(found.map(({ blockedBy: _blockedBy, ...task }) => task)).toEqual(state.tasks);
		expect(() => readTasks(state, { view: "details", ids: ["99"] })).toThrow(TaskError);
	});
	it("rejects a task whose encoded contents exceed the record budget", () => {
		const input = parseWrite({
			operations: [{ action: "create", task: { subject: "Big", description: "\u0000x".repeat(3000) } }],
		});
		expect(() => applyOperations(EMPTY_STATE, input.operations)).toThrow(TaskError);
	});
});

it("does not expose mutable state through detail results", () => {
	const state = makeState([makeTask("1", { metadata: { value: true } })]);
	const page = readTasks(state, { view: "details", ids: ["1"] });
	if (page.view !== "details") throw new Error("expected details");
	page.tasks[0].dependsOn.push("99");
	if (page.tasks[0].metadata) page.tasks[0].metadata.value = false;
	expect(state.tasks[0]).toMatchObject({ dependsOn: [], metadata: { value: true } });
});
