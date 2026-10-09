import { describe, expect, it } from "vitest";
import { makeState, makeTask } from "../test/helpers/index.js";
import { EMPTY_STATE, isRecord } from "./model.js";
import { buildResumeContext, ResumeTracker } from "./resume.js";

function records(text: string) {
	return text
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => {
			const value: unknown = JSON.parse(line);
			if (
				!isRecord(value) ||
				typeof value.id !== "string" ||
				typeof value.subject !== "string" ||
				typeof value.status !== "string"
			)
				throw new Error("invalid task record");
			return { ...value, id: value.id, subject: value.subject, status: value.status };
		});
}

describe("task resume context", () => {
	it("omits empty, completed and internal-only lists", () => {
		expect(buildResumeContext(EMPTY_STATE)).toBeUndefined();
		expect(buildResumeContext(makeState([makeTask("1", { status: "completed" })]))).toBeUndefined();
		expect(buildResumeContext(makeState([makeTask("1", { metadata: { _internal: true } })]))).toBeUndefined();
	});

	it("puts active work first, includes open blockers and counts only visible tasks", () => {
		const state = makeState([
			makeTask("1"),
			makeTask("2", { status: "completed" }),
			makeTask("3", { subject: "Current", status: "in_progress", blockedBy: ["1", "2", "missing"] }),
			makeTask("4", { metadata: { _internal: true } }),
		]);
		const text = buildResumeContext(state);
		if (!text) throw new Error("missing resume context");
		expect(records(text)).toEqual([
			{ id: "3", status: "in_progress", subject: "Current", blockedBy: ["1"] },
			{ id: "1", status: "pending", subject: "Task 1" },
		]);
		const secondHeaderLine = text.split("\n")[1];
		expect(secondHeaderLine).toContain("TaskList");
		expect(secondHeaderLine).toContain("TaskGet");
		expect(secondHeaderLine).toContain("TaskUpdate");
		expect(text).toContain("Showing 2 of 2 unfinished tasks; 1 completed tasks not shown.");
		expect(text.split("\n").findIndex((line) => line.startsWith("{"))).toBe(2);
	});

	it("emits at most twenty records and reports omitted work", () => {
		const tasks = Array.from({ length: 25 }, (_, i) => makeTask(String(i + 1)));
		const text = buildResumeContext(makeState(tasks));
		if (!text) throw new Error("missing resume context");
		expect(records(text).map((task) => task.id)).toEqual(tasks.slice(0, 20).map((task) => task.id));
		expect(text).toContain("Showing 20 of 25 unfinished tasks; 0 completed tasks not shown.");
	});

	it("truncates subjects by code point and respects the total character budget", () => {
		const text = buildResumeContext(
			makeState(Array.from({ length: 30 }, (_, i) => makeTask(String(i + 1), { subject: "😀".repeat(200) }))),
		);
		if (!text) throw new Error("missing resume context");
		const items = records(text);
		expect(items.length).toBeGreaterThan(0);
		expect(items.length).toBeLessThanOrEqual(20);
		expect(text.length).toBeLessThanOrEqual(6000);
		for (const task of items) {
			expect(Array.from(task.subject)).toHaveLength(160);
			expect(task.subject.endsWith("…")).toBe(true);
			expect(task.subject).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
		}
		expect(text).toContain(`Showing ${items.length} of 30 unfinished tasks; 0 completed tasks not shown.`);
	});

	it("escapes controls and Unicode line separators into complete JSON records", () => {
		const subject = `quoted " text\n\u2028\u2029\u009b${"\u0000".repeat(200)}`;
		const text = buildResumeContext(
			makeState(Array.from({ length: 100 }, (_, i) => makeTask(String(i + 1), { subject }))),
		);
		if (!text) throw new Error("missing resume context");
		expect(text.length).toBeLessThanOrEqual(6000);
		expect(text).not.toMatch(/[\u0000\u009b\u2028\u2029]/u);
		const items = records(text);
		expect(items.length).toBeGreaterThan(0);
		expect(items.length).toBeLessThan(20);
		expect(items[0].subject).toContain("\u2028\u2029\u009b");
		expect(text).toContain(`Showing ${items.length} of 100 unfinished tasks; 0 completed tasks not shown.`);
	});
});

describe("ResumeTracker", () => {
	it("requires a mark and a begun request before acknowledging", () => {
		const tracker = new ResumeTracker();
		expect(tracker.begin("a")).toBe(false);
		tracker.mark("a");
		tracker.acknowledge("a");
		expect(tracker.begin("a")).toBe(true);
		tracker.acknowledge("a");
		expect(tracker.begin("a")).toBe(false);
	});

	it("keeps summaries available for retry until acknowledged", () => {
		const tracker = new ResumeTracker();
		tracker.mark("a");
		expect(tracker.begin("a")).toBe(true);
		expect(tracker.begin("a")).toBe(true);
		tracker.acknowledge("a");
		expect(tracker.begin("a")).toBe(false);
	});

	it("does not let an older request acknowledge a newer restore generation", () => {
		const tracker = new ResumeTracker();
		tracker.mark("a");
		tracker.begin("a");
		tracker.mark("a");
		tracker.acknowledge("a");
		expect(tracker.begin("a")).toBe(true);
		tracker.acknowledge("a");
		expect(tracker.begin("a")).toBe(false);
	});

	it("isolates sessions and drops pending and in-flight state on shutdown", () => {
		const tracker = new ResumeTracker();
		tracker.mark("a");
		tracker.mark("b");
		tracker.begin("a");
		tracker.drop("a");
		tracker.acknowledge("a");
		expect(tracker.begin("a")).toBe(false);
		expect(tracker.begin("b")).toBe(true);
		tracker.mark("a");
		tracker.acknowledge("a");
		expect(tracker.begin("a")).toBe(true);
	});
});
