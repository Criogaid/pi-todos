import { describe, expect, it } from "vitest";
import { makeSnapshotEntry, makeState, makeTask } from "../test/helpers/index.js";
import {
	findTask,
	isFinished,
	openBlockers,
	summarizeTasks,
	TASK_STATUSES,
	TASK_UPDATE_STATUSES,
	updateTask,
} from "./model.js";
import { replayFromBranch } from "./persistence.js";

const cases = TASK_STATUSES.flatMap((from) =>
	TASK_UPDATE_STATUSES.flatMap((to) =>
		(["outgoing", "incoming"] as const).flatMap((direction) =>
			[false, true].flatMap((internal) =>
				TASK_STATUSES.map((otherStatus) => ({ from, to, direction, internal, otherStatus })),
			),
		),
	),
);

describe("task transitions, dependencies and visibility combinations", () => {
	it.each(cases)(
		"$from to $to, $direction, internal=$internal, other=$otherStatus",
		({ from, to, direction, internal, otherStatus }) => {
			const initial = makeState([makeTask("1", { status: from }), makeTask("2", { status: otherStatus })]);
			const linked = updateTask(initial, {
				taskId: "1",
				...(direction === "outgoing" ? { addBlocks: ["2"] } : { addBlockedBy: ["2"] }),
			}).state;
			const before = structuredClone(linked);
			const changed = updateTask(linked, { taskId: "1", status: to, metadata: { _internal: internal } }).state;
			expect(linked).toEqual(before);
			expect(changed.highWaterMark).toBe(2);
			const first = findTask(changed, "1");
			const second = findTask(changed, "2");
			if (!second) throw new Error("unrelated task was removed");
			if (to === "deleted") {
				expect(first).toBeUndefined();
				expect(second.blocks).toEqual([]);
				expect(second.blockedBy).toEqual([]);
			} else {
				if (!first) throw new Error("updated task was removed");
				expect(first.status).toBe(to);
				if (direction === "outgoing") {
					expect(first.blocks).toEqual(["2"]);
					expect(second.blockedBy).toEqual(["1"]);
				} else {
					expect(first.blockedBy).toEqual(["2"]);
					expect(second.blocks).toEqual(["1"]);
				}
				expect(openBlockers(changed, first)).toEqual(
					direction === "incoming" && otherStatus !== "completed" ? ["2"] : [],
				);
			}
			expect(openBlockers(changed, second)).toEqual(
				direction === "outgoing" && to !== "completed" && to !== "deleted" ? ["1"] : [],
			);
			expect(summarizeTasks(changed).map((task) => task.id)).toEqual(
				to === "deleted" || internal ? ["2"] : ["1", "2"],
			);
			expect(isFinished(changed)).toBe(
				otherStatus === "completed" && (to === "deleted" || internal || to === "completed"),
			);
			expect(replayFromBranch([makeSnapshotEntry(linked), makeSnapshotEntry(changed)])).toEqual(changed);
		},
	);
});
