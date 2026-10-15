import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { makeTask, makeTheme } from "../test/helpers/index.js";
import { formatCommandLine, formatCountsHeader, formatThemedLine } from "./format.js";

describe("terminal task formatting", () => {
	it.each([
		["pending", "○"],
		["in_progress", "◐"],
		["completed", "✓"],
	] as const)("renders %s rows with owner and blockers", (status, glyph) => {
		const task = makeTask("3", { subject: "Run tests", activeForm: "Running tests", owner: "agent", status });
		expect(formatCommandLine(task, ["1", "2"])).toBe(
			`  ${glyph} #3 Run tests${status === "in_progress" ? " (Running tests)" : ""} @agent › blocked by #1, #2`,
		);
	});

	it("removes terminal controls from user-controlled fields", () => {
		const task = makeTask("1", {
			subject: "Run\u001b[31m tests\nnow",
			activeForm: "Working\rhard",
			owner: "Agent\tA",
			status: "in_progress",
		});
		expect(formatCommandLine(task, [])).toBe("  ◐ #1 Run tests now (Working hard) @Agent A");
		expect(formatThemedLine(task, [], makeTheme() as Theme)).toBe("◐ #1 Run tests now (Working hard) @Agent A");
	});

	it("emphasizes active work, mutes blocked work and strikes completed subjects", () => {
		const theme = makeTheme({
			fg: (color, text) => `<${color}>${text}</${color}>`,
			strikethrough: (text) => `<strike>${text}</strike>`,
		}) as Theme;
		expect(formatThemedLine(makeTask("1", { status: "in_progress" }), [], theme)).toContain(
			"<accent>Task 1</accent>",
		);
		expect(formatThemedLine(makeTask(), ["2"], theme)).toContain("<muted>Task 1</muted>");
		expect(formatThemedLine(makeTask("1", { status: "completed" }), [], theme)).toContain(
			"<strike><muted>Task 1</muted></strike>",
		);
		expect(formatThemedLine(makeTask(), [], theme)).toContain("<text>Task 1</text>");
	});

	it("reports counts while omitting zero parts", () => {
		expect(
			formatCountsHeader([
				makeTask(),
				makeTask("2", { status: "in_progress" }),
				makeTask("3", { status: "completed" }),
			]),
		).toBe("1/3 completed · 1 in progress · 1 pending");
		expect(formatCountsHeader([makeTask()])).toBe("1 pending");
		expect(formatCountsHeader([makeTask("1", { status: "completed" })])).toBe("1/1 completed");
		expect(formatCountsHeader([])).toBe("");
	});
});
