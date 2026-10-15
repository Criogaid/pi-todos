import { describe, expect, it } from "vitest";
import { makeSnapshotEntry, makeState, makeTask } from "../test/helpers/index.js";
import { EMPTY_STATE } from "./model.js";
import { decodeSnapshot, replayFromBranch, snapshotOf, TASKS_SNAPSHOT_TYPE } from "./persistence.js";

const state = makeState(
	[
		makeTask("1", { progress: "Checked", owner: "agent", metadata: { nested: { value: true } } }),
		makeTask("3", { dependsOn: ["1"] }),
	],
	9,
);
describe("strict branch snapshots", () => {
	it("round-trips every field and the allocation counter independently of the source", () => {
		const source = snapshotOf(state, "call");
		const decoded = decodeSnapshot(source);
		expect(decoded).toEqual(state);
		expect(decoded.tasks).not.toBe(source.tasks);
		expect(decoded.tasks[0].metadata).not.toBe(source.tasks[0].metadata);
		expect(decodeSnapshot(snapshotOf(makeState([], 9)))).toEqual(makeState([], 9));
	});
	it.each([
		{ version: 1 },
		{ version: 999 },
		{ highWaterMark: -1 },
		{ highWaterMark: "9" },
		{ tasks: [makeTask("2"), makeTask("1")] },
		{ tasks: [makeTask(), makeTask()] },
		{ tasks: [makeTask("10")] },
		{ tasks: [makeTask("1", { dependsOn: ["2"] })] },
		{ tasks: [makeTask("1", { dependsOn: ["1"] })] },
		{ tasks: [makeTask("1", { dependsOn: ["3"] }), makeTask("3", { dependsOn: ["1"] })] },
		{ tasks: [{ ...makeTask(), blocks: [] }] },
		{ tasks: [{ ...makeTask(), status: "deleted" }] },
		{ unknown: true },
	])("rejects unsupported or inconsistent snapshots: %j", (patch) => {
		const input = { ...snapshotOf(state), ...patch };
		const before = structuredClone(input);
		expect(() => decodeSnapshot(input)).toThrow();
		expect(input).toEqual(before);
	});
	it("restores the last snapshot on the selected branch and never falls back past invalid data", () => {
		const later = makeState([makeTask("10")]);
		const first = makeSnapshotEntry(state);
		expect(replayFromBranch([first, makeSnapshotEntry(later)])).toEqual(later);
		const invalid = { type: "custom", customType: TASKS_SNAPSHOT_TYPE, data: { version: 1 } };
		expect(() => replayFromBranch([first, invalid])).toThrow();
		expect(() => replayFromBranch([invalid, first])).toThrow();
		expect(replayFromBranch([])).toBe(EMPTY_STATE);
		expect(replayFromBranch([{ type: "custom", customType: "another-extension", data: {} }, first])).toEqual(state);
	});
});
