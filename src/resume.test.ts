import { describe, expect, it } from "vitest";
import type { Todo } from "./model.js";
import { buildResumeContext, ResumeTracker } from "./resume.js";

function records(text: string): Array<{ status: string; content: string }> {
	return text
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line));
}

describe("buildResumeContext", () => {
	it("omits empty and fully completed lists", () => {
		expect(buildResumeContext([])).toBeUndefined();
		expect(buildResumeContext([{ content: "Done", status: "completed" }])).toBeUndefined();
	});

	it("puts current work first and counts omitted completed items", () => {
		const todos: Todo[] = [
			{ content: "Next", status: "pending" },
			{ content: "Done", status: "completed" },
			{ content: "Current", status: "in_progress", activeForm: "Working" },
		];
		const text = buildResumeContext(todos);
		if (!text) throw new Error("missing resume context");
		expect(records(text)).toEqual([
			{ status: "in_progress", content: "Current" },
			{ status: "pending", content: "Next" },
		]);
		expect(text).toContain("Showing 2 of 2 unfinished items; 1 completed items not shown.");
	});

	it("shows the first twenty unfinished items when the character budget allows them", () => {
		const todos: Todo[] = Array.from({ length: 25 }, (_, i) => ({ content: `Task ${i}`, status: "pending" }));
		const text = buildResumeContext(todos);
		if (!text) throw new Error("missing resume context");
		expect(records(text)).toEqual(todos.slice(0, 20));
		expect(text).toContain("Showing 20 of 25 unfinished items; 0 completed items not shown.");
	});

	it("bounds the item count and truncates content by code point", () => {
		const text = buildResumeContext(
			Array.from({ length: 30 }, (_, i) => ({ content: `${i}: ${"😀".repeat(200)}`, status: "pending" })),
		);
		if (!text) throw new Error("missing resume context");
		const items = records(text);
		expect(items.length).toBeLessThanOrEqual(20);
		expect(items.length).toBeGreaterThan(0);
		expect(text.length).toBeLessThanOrEqual(6000);
		for (const item of items) {
			expect(Array.from(item.content)).toHaveLength(160);
			expect(item.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
		}
		expect(text).toContain(`Showing ${items.length} of 30 unfinished items; 0 completed items not shown.`);
	});

	it("escapes line and terminal controls and only emits complete JSON records within the total bound", () => {
		const content = `quoted " text\n\u2028\u009b${"\u0000".repeat(200)}`;
		const text = buildResumeContext(Array.from({ length: 100 }, () => ({ content, status: "pending" })));
		if (!text) throw new Error("missing resume context");
		expect(text.length).toBeLessThanOrEqual(6000);
		expect(text).not.toMatch(/[\u0000\u009b\u2028]/u);
		const items = records(text);
		expect(items.length).toBeGreaterThan(0);
		expect(items.length).toBeLessThan(20);
		expect(text).toContain(`Showing ${items.length} of 100 unfinished items; 0 completed items not shown.`);
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

	it("isolates sessions and drops both pending and in-flight state on shutdown", () => {
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
