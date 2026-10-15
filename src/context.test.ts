import { describe, expect, it } from "vitest";
import { makeState, makeTask } from "../test/helpers/index.js";
import { buildTaskContext } from "./context.js";
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
