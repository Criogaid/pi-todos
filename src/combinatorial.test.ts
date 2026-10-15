import { describe, expect, it } from "vitest";
import { makeSnapshotEntry, makeState, makeTask } from "../test/helpers/index.js";
import { applyOperations, openBlockers, readTasks } from "./model.js";
import { replayFromBranch } from "./persistence.js";
import { TASK_STATUSES } from "./schema.js";

const cases = TASK_STATUSES.flatMap((from) =>
	TASK_STATUSES.flatMap((to) => [false, true].map((deleted) => ({ from, to, deleted }))),
);
describe("transitions, graph projections, and restoration", () => {
	it.each(cases)("$from to $to, deleted=$deleted", ({ from, to, deleted }) => {
		const state = makeState([
			makeTask("1", { status: from, metadata: { _internal: true } }),
			makeTask("2", { dependsOn: ["1"] }),
		]);
		const final = applyOperations(state, [
			deleted ? { action: "delete", id: "1" } : { action: "update", id: "1", set: { status: to } },
		]).state;
		expect(openBlockers(final, final.tasks[final.tasks.length - 1])).toEqual(
			deleted || to === "completed" ? [] : ["1"],
		);
		expect(readTasks(final, { scope: "all" }).tasks).toHaveLength(deleted ? 1 : 2);
		expect(replayFromBranch([makeSnapshotEntry(state), makeSnapshotEntry(final)])).toEqual(final);
	});
});
