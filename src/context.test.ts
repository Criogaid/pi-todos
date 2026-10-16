import { describe, expect, it } from "vitest";
import { makeSnapshotEntry, makeState, makeTask } from "../test/helpers/index.js";
import { buildTaskContext, carriedOverTasks, taskContextIndex } from "./context.js";
import { LIMITS } from "./schema.js";

describe("bounded current-state context", () => {
	it("includes active requirements and progress, prioritizes work in progress, and excludes metadata", () => {
		const state = makeState([
			makeTask("1"),
			makeTask("2", {
				status: "in_progress",
				description: "Must preserve data",
				progress: "Next check",
				dependsOn: ["1"],
				metadata: { secret: "not-context" },
			}),
			makeTask("3", { status: "completed" }),
		]);
		const text = buildTaskContext(state);
		expect(text).toContain("Must preserve data");
		expect(text).toContain("Next check");
		expect(text).not.toContain("not-context");
		expect(text).not.toContain("Task 3");
		expect(text?.indexOf('"id":"2"')).toBeLessThan(text?.indexOf('"id":"1"') ?? 0);
	});
	it("omits empty and completed-only state but never hides tasks through metadata", () => {
		expect(buildTaskContext(makeState())).toBeUndefined();
		expect(buildTaskContext(makeState([makeTask("1", { status: "completed" })]))).toBeUndefined();
		expect(buildTaskContext(makeState([makeTask("1", { metadata: { _internal: true } })]))).toContain("Task 1");
	});
	it("reports shortened fields and omitted tasks while bounding escaped output", () => {
		const state = makeState(
			Array.from({ length: 30 }, (_, i) =>
				makeTask(String(i + 1), {
					status: "in_progress",
					description: "😀\u2028\u009b".repeat(1000),
					progress: "p".repeat(LIMITS.progressChars),
				}),
			),
		);
		const text = buildTaskContext(state);
		expect(text?.length).toBeLessThanOrEqual(LIMITS.contextChars);
		expect(text).toContain("omitted");
		expect(text).toContain("TaskRead");
		expect(text).not.toMatch(/[\u009b\u2028]/u);
		const rows = text?.split("\n").filter((row) => row.startsWith("{")) ?? [];
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(JSON.parse(row)).toMatchObject({ truncatedFields: ["description", "progress"] });
	});
});

describe("carried-over snapshot selection", () => {
	it("returns no state for an empty branch or unrelated entries", () => {
		expect(carriedOverTasks([], new Set())).toBeUndefined();
		expect(
			carriedOverTasks([null, { type: "message" }, { type: "custom", customType: "other" }], new Set()),
		).toBeUndefined();
	});
	it("returns no state when the first snapshot is visible", () => {
		expect(carriedOverTasks([makeSnapshotEntry(makeState(), "visible")], new Set(["visible"]))).toBeUndefined();
	});
	it("selects the last hidden snapshot and stops decoding at the first visible snapshot", () => {
		const state = makeState([makeTask("2")]);
		const hidden = { ...makeSnapshotEntry(state, "hidden"), timestamp: "2026-02-03T04:05:06.000Z" };
		const visible = { ...makeSnapshotEntry(makeState(), "visible"), data: { toolCallId: "visible" } };
		function* branch() {
			yield makeSnapshotEntry(makeState());
			yield hidden;
			yield visible;
			yield { ...hidden, data: null };
		}
		expect(carriedOverTasks(branch(), new Set(["visible"]))).toEqual({
			state,
			timestamp: Date.parse(hidden.timestamp),
		});
	});
	it("treats snapshots without a tool call id as hidden", () => {
		const state = makeState([makeTask("1")]);
		const entry = makeSnapshotEntry(state);
		expect(carriedOverTasks([entry], new Set(["visible"]))).toEqual({
			state,
			timestamp: Date.parse(entry.timestamp),
		});
	});
	it.each(["invalid", undefined, 123])("uses zero for an invalid timestamp: %s", (timestamp) => {
		const state = makeState([makeTask("1")]);
		expect(carriedOverTasks([{ ...makeSnapshotEntry(state), timestamp }], new Set())).toEqual({
			state,
			timestamp: 0,
		});
	});
	it("propagates a malformed selected snapshot", () => {
		const entry = { ...makeSnapshotEntry(makeState()), data: { version: 1 } };
		expect(() => carriedOverTasks([entry], new Set())).toThrow();
	});
});

describe("task context insertion index", () => {
	it("starts at zero without a compaction summary", () => {
		expect(taskContextIndex([])).toBe(0);
		expect(taskContextIndex([{ role: "user" }, { role: "toolResult" }])).toBe(0);
	});
	it("inserts immediately after the last compaction summary", () => {
		expect(
			taskContextIndex([
				{ role: "compactionSummary" },
				{ role: "user" },
				{ role: "compactionSummary" },
				{ role: "assistant" },
			]),
		).toBe(3);
	});
});
