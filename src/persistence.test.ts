import { describe, expect, it } from "vitest";
import { makeMessageEntry, makeSnapshotEntry, makeState, makeTask, makeToolResult } from "../test/helpers/index.js";
import { EMPTY_STATE, isRecord } from "./model.js";
import {
	decodeSnapshot,
	isSnapshotEntry,
	replayFromBranch,
	snapshotOf,
	TASKS_SNAPSHOT_TYPE,
	TASKS_SNAPSHOT_VERSION,
} from "./persistence.js";

const state = makeState(
	[
		makeTask("1", {
			activeForm: "Working",
			owner: "agent",
			blocks: ["3"],
			metadata: { nested: { value: 1 }, _internal: true },
		}),
		makeTask("3", { status: "in_progress", blockedBy: ["1"] }),
	],
	9,
);

describe("task snapshots", () => {
	it("round-trips all task fields and a counter beyond the remaining ids", () => {
		const snapshot = snapshotOf(state, "call-create");
		expect(snapshot.toolCallId).toBe("call-create");
		expect(decodeSnapshot(snapshot)).toEqual(state);
		expect(decodeSnapshot(snapshotOf(makeState([], 9)))).toEqual(makeState([], 9));
		expect(snapshotOf(state)).not.toHaveProperty("toolCallId");
	});

	it("deep-clones metadata and dependency arrays on both write and read", () => {
		const original = structuredClone(state);
		const snapshot = snapshotOf(original);
		const decoded = decodeSnapshot(snapshot);
		if (!decoded) throw new Error("snapshot not decoded");
		const snapshotMetadata = snapshot.tasks[0].metadata;
		const decodedMetadata = decoded.tasks[0].metadata;
		if (!isRecord(snapshotMetadata?.nested) || !isRecord(decodedMetadata?.nested)) {
			throw new Error("nested metadata not decoded");
		}
		snapshot.tasks[0].blocks.push("changed");
		snapshotMetadata.nested.value = 2;
		expect(decodedMetadata.nested.value).toBe(1);
		decodedMetadata.nested.value = 3;
		decoded.tasks[1].blockedBy.push("other");
		expect(original).toEqual(state);
		expect(snapshotMetadata.nested.value).toBe(2);
		expect(snapshot.tasks[1].blockedBy).toEqual(["1"]);
	});

	it.each([
		undefined,
		null,
		[],
		{},
		{ ...snapshotOf(state), version: TASKS_SNAPSHOT_VERSION + 1 },
		{ ...snapshotOf(state), tasks: {} },
	])("rejects malformed envelope: %j", (data) => {
		expect(decodeSnapshot(data)).toBeUndefined();
	});

	it.each([undefined, null, "9", -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid high-water mark: %j",
		(highWaterMark) => {
			expect(decodeSnapshot({ ...snapshotOf(state), highWaterMark })).toBeUndefined();
		},
	);

	it.each(["0", "01", "-1", "1.5", "", "#1", "missing", "9007199254740992", 1])(
		"rejects invalid task id: %j",
		(id) => {
			expect(
				decodeSnapshot({
					version: TASKS_SNAPSHOT_VERSION,
					highWaterMark: Number.MAX_SAFE_INTEGER,
					tasks: [{ ...makeTask(), id }],
				}),
			).toBeUndefined();
		},
	);

	it("rejects ids above the counter and duplicate ids", () => {
		expect(decodeSnapshot({ ...snapshotOf(makeState([makeTask("2")])), highWaterMark: 1 })).toBeUndefined();
		expect(decodeSnapshot(snapshotOf(makeState([makeTask(), makeTask()])))).toBeUndefined();
	});

	it.each([
		{ subject: undefined },
		{ subject: 1 },
		{ description: null },
		{ description: false },
		{ status: "deleted" },
		{ status: 1 },
		{ activeForm: null },
		{ activeForm: 1 },
		{ owner: null },
		{ owner: 2 },
		{ blocks: "1" },
		{ blocks: [1] },
		{ blockedBy: null },
		{ blockedBy: [null] },
		{ metadata: [] },
		{ metadata: null },
		{ metadata: "text" },
	])("rejects the whole snapshot for a malformed task field: %j", (patch) => {
		expect(
			decodeSnapshot({
				version: TASKS_SNAPSHOT_VERSION,
				highWaterMark: 2,
				tasks: [makeTask(), { ...makeTask("2"), ...patch }],
			}),
		).toBeUndefined();
	});

	it.each([null, [], "task"])("rejects a non-object task: %j", (task) => {
		expect(decodeSnapshot({ version: TASKS_SNAPSHOT_VERSION, highWaterMark: 1, tasks: [task] })).toBeUndefined();
	});

	it("drops self and dangling edges while retaining valid dependencies", () => {
		const source = snapshotOf(
			makeState([makeTask("1", { blocks: ["1", "2", "missing"], blockedBy: ["1", "2", "missing"] }), makeTask("2")]),
		);
		const decoded = decodeSnapshot(source);
		expect(decoded?.tasks[0].blocks).toEqual(["2"]);
		expect(decoded?.tasks[0].blockedBy).toEqual(["2"]);
		expect(source.tasks[0].blocks).toEqual(["1", "2", "missing"]);
	});
});

describe("branch snapshot replay", () => {
	it("uses the last valid snapshot, skipping corrupt and foreign entries", () => {
		const first = makeSnapshotEntry(state);
		const lastState = makeState([makeTask("10", { status: "completed" })]);
		const invalid = { ...makeSnapshotEntry(state), data: { ...snapshotOf(state), highWaterMark: -1 } };
		function* branch() {
			yield null;
			yield first;
			yield makeSnapshotEntry(lastState);
			yield invalid;
			yield { type: "custom", customType: "other", data: snapshotOf(state) };
		}
		expect(replayFromBranch(branch())).toEqual(lastState);
		expect(replayFromBranch([first, makeSnapshotEntry(makeState([], 9))])).toEqual(makeState([], 9));
		expect(replayFromBranch([])).toBe(EMPTY_STATE);
	});

	it("ignores legacy snapshots, direct tool results and nested tool records", () => {
		const legacy = {
			type: "custom",
			customType: "pi-todos-snapshot",
			data: { version: 1, todos: [{ content: "Legacy", status: "pending" }] },
		};
		const direct = makeMessageEntry(makeToolResult({ toolName: "TaskCreate", details: snapshotOf(state) }));
		const nested = makeMessageEntry(
			makeToolResult({
				toolName: "codemode",
				nestedCalls: {
					complete: true,
					calls: [{ id: "call", name: "TaskCreate", status: "ok", arguments: snapshotOf(state) }],
				},
			}),
		);
		expect(replayFromBranch([legacy, direct, nested])).toBe(EMPTY_STATE);
		expect(replayFromBranch([makeSnapshotEntry(state), legacy, direct, nested])).toEqual(state);
	});

	it("recognizes only the current custom entry type", () => {
		expect(isSnapshotEntry({ type: "custom", customType: TASKS_SNAPSHOT_TYPE })).toBe(true);
		for (const entry of [
			null,
			{},
			{ type: "message", customType: TASKS_SNAPSHOT_TYPE },
			{ type: "custom", customType: "other" },
		])
			expect(isSnapshotEntry(entry)).toBe(false);
	});
});
