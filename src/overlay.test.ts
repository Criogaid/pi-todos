import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type MouseRegion, type TUI, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createMockUI, makeState, makeTask, makeTheme } from "../test/helpers/index.js";
import type { Task } from "./model.js";
import { TodoOverlay, windowTasks } from "./overlay.js";
import { setForeground, setTaskState } from "./store.js";

function numberedTasks(completed = 0, active?: number): Task[] {
	return Array.from({ length: 15 }, (_, index) =>
		makeTask(String(index + 1), {
			status: index + 1 === active ? "in_progress" : index < completed ? "completed" : "pending",
			activeForm: `Working on Task ${index + 1}`,
		}),
	);
}
// The panel reads only these two fields of a host mouse event.
const wheel = (wheelDelta: number) => ({ type: "wheel", wheelDelta }) as TuiMouseEvent;
function setup(tasks: Task[], maxWidgetLines = 12, collapseKey = "alt+o") {
	setForeground("main");
	setTaskState("main", makeState(tasks));
	const theme = makeTheme() as Theme;
	const ui = createMockUI({ theme });
	const requestRender = vi.fn();
	const overlay = new TodoOverlay({ maxWidgetLines, collapseKey });
	// Widget factories only use requestRender on the host TUI in these tests.
	const tui = { requestRender } as unknown as TUI;
	overlay.setUICtx(ui as unknown as ExtensionUIContext);
	overlay.update();
	const call = ui.setWidget.mock.calls.find(([, factory]) => typeof factory === "function");
	if (!call) throw new Error("widget not registered");
	const factory: (tui: TUI, theme: Theme) => MouseRegion = call[1];
	return { overlay, ui, widget: factory(tui, theme), requestRender };
}
function expectWindow(widget: Component, first: number, footer: string) {
	const lines = widget.render(100);
	expect(lines).toHaveLength(13);
	expect(lines.slice(1, -2).map((line) => line.match(/Task \d+/)?.[0])).toEqual(
		Array.from({ length: 10 }, (_, index) => `Task ${first + index}`),
	);
	expect(lines.at(-2)).toBe(`└─ ${footer}`);
	expect(lines.at(-1)).toBe("");
}

describe("task windows", () => {
	const tasks = Array.from({ length: 5 }, (_, index) => makeTask(String(index + 1)));
	it("returns all tasks when they fit and counts both hidden sides on overflow", () => {
		expect(windowTasks(tasks.slice(0, 2), 3, 0)).toEqual({ visible: tasks.slice(0, 2), above: 0, below: 0 });
		expect(windowTasks(tasks, 2, 1)).toEqual({ visible: tasks.slice(1, 3), above: 1, below: 2 });
		expect(windowTasks([], 2, 0)).toEqual({ visible: [], above: 0, below: 0 });
	});
	it("clamps negative and excessive offsets and truncates fractional offsets", () => {
		expect(windowTasks(tasks, 2, 99)).toEqual({ visible: tasks.slice(3), above: 3, below: 0 });
		expect(windowTasks(tasks, 2, -4)).toEqual({ visible: tasks.slice(0, 2), above: 0, below: 3 });
		expect(windowTasks(tasks, 2, 1.9)).toEqual({ visible: tasks.slice(1, 3), above: 1, below: 2 });
	});
});

describe("task overlay", () => {
	it("shows task ids and counts visible tasks outside the current window", () => {
		const { widget, ui } = setup(
			[makeTask("1", { status: "completed" }), makeTask("2"), makeTask("3"), makeTask("4"), makeTask("5")],
			4,
		);
		expect(ui.setWidget).toHaveBeenCalledWith("pi-todos", expect.any(Function), { placement: "aboveEditor" });
		expect(widget.render(100)).toEqual([
			"● Tasks (1/5)",
			"├─ ○ #2 Task 2",
			"├─ ○ #3 Task 3",
			"└─ ↑ 1 above · ↓ 2 below",
			"",
		]);
	});

	it.each([
		{ active: 11, completed: 10, first: 6, footer: "↑ 5 above" },
		{ active: 1, completed: 0, first: 1, footer: "↓ 5 below" },
		{ active: 15, completed: 14, first: 6, footer: "↑ 5 above" },
	])("keeps active task $active visible", ({ active, completed, first, footer }) => {
		const { widget } = setup(numberedTasks(completed, active));
		expectWindow(widget, first, footer);
		expect(widget.render(100)[0]).toBe(`● Tasks (${completed}/15)`);
		expect(widget.render(100)).toContain(`├─ ◐ #${active} Task ${active} (Working on Task ${active})`);
	});

	it("focuses the first in-progress task rather than earlier pending or later active tasks", () => {
		const tasks = numberedTasks(0, 4).map((task) =>
			task.id === "12" ? { ...task, status: "in_progress" as const } : task,
		);
		const { widget } = setup(tasks);
		expectWindow(widget, 4, "↑ 3 above · ↓ 2 below");
	});

	it.each([
		{ completed: 13, first: 6, footer: "↑ 5 above" },
		{ completed: 15, first: 1, footer: "↓ 5 below" },
	])("focuses unfinished work or the top when $completed tasks are completed", ({ completed, first, footer }) => {
		expectWindow(setup(numberedTasks(completed)).widget, first, footer);
	});

	it("hides internal tasks and displays only open blockers", () => {
		const { widget } = setup([
			makeTask("1", { metadata: { _internal: true }, status: "in_progress" }),
			makeTask("2", { status: "completed" }),
			makeTask("3"),
			makeTask("4", { owner: "agent", blockedBy: ["2", "3", "missing"] }),
		]);
		const lines = widget.render(100);
		expect(lines[0]).toBe("● Tasks (1/3)");
		expect(lines.join("\n")).not.toContain("#1");
		expect(lines.join("\n")).toContain("#4 Task 4 @agent › blocked by #3");
		expect(lines.join("\n")).not.toContain("blocked by #2");
	});

	it("keeps completed lists visible until the live state is cleared", () => {
		const { overlay, widget, ui } = setup([makeTask("1", { status: "completed" })]);
		expect(widget.render(100)[0]).toBe("○ Tasks (1/1)");
		overlay.update();
		expect(overlay.isRegistered()).toBe(true);
		setTaskState("main", makeState([], 1));
		overlay.update();
		expect(overlay.isRegistered()).toBe(false);
		expect(ui.setWidget).toHaveBeenLastCalledWith("pi-todos", undefined);
	});

	it("unregisters an internal-only list and stays disposed", () => {
		const { overlay, ui } = setup([makeTask()]);
		setTaskState("main", makeState([makeTask("1", { metadata: { _internal: true } })]));
		overlay.update();
		expect(overlay.isRegistered()).toBe(false);
		expect(ui.setWidget).toHaveBeenLastCalledWith("pi-todos", undefined);
		setTaskState("main", makeState([makeTask()]));
		overlay.update();
		overlay.dispose();
		overlay.update();
		expect(overlay.isRegistered()).toBe(false);
	});

	it("collapses with the bound shortcut hint and requests a full redraw", () => {
		const { overlay, widget, requestRender } = setup([makeTask("1", { status: "completed" })], 12, "ctrl+]");
		overlay.toggleCollapse();
		expect(widget.render(100)).toEqual(["○ Tasks (1/1)", "└─ ctrl+] to expand", ""]);
		expect(requestRender).toHaveBeenCalledWith(true);
		overlay.toggleCollapse();
		expect(widget.render(100)).toContain("└─ ✓ #1 Task 1");
	});

	it("shows every task while expanded and restores the clamped focused window", () => {
		const { widget, ui } = setup(numberedTasks(14, 15));
		expectWindow(widget, 6, "↑ 5 above");
		const getToolsExpanded = vi.fn(() => true);
		Object.assign(ui, { getToolsExpanded });
		const lines = widget.render(100);
		expect(lines).toHaveLength(17);
		expect(lines.slice(1, -1).map((line) => line.match(/Task \d+/)?.[0])).toEqual(
			Array.from({ length: 15 }, (_, i) => `Task ${i + 1}`),
		);
		expect(lines.some((line) => /[↑↓]/.test(line))).toBe(false);
		expect(widget.handleMouse(wheel(-1))).toBeUndefined();
		for (const line of widget.render(12)) expect(visibleWidth(line)).toBeLessThanOrEqual(12);
		getToolsExpanded.mockReturnValue(false);
		expectWindow(widget, 6, "↑ 5 above");
	});

	it("scrolls between windows, clamps at both edges and leaves edge events unhandled", () => {
		const { widget } = setup(numberedTasks());
		expect(widget.handleMouse(wheel(-1))).toBeUndefined();
		expect(widget.handleMouse(wheel(2))).toEqual({ handled: true });
		expectWindow(widget, 3, "↑ 2 above · ↓ 3 below");
		expect(widget.handleMouse(wheel(99))).toEqual({ handled: true });
		expectWindow(widget, 6, "↑ 5 above");
		expect(widget.handleMouse(wheel(1))).toBeUndefined();
		expect(widget.handleMouse(wheel(-1))).toEqual({ handled: true });
		expectWindow(widget, 5, "↑ 4 above · ↓ 1 below");
		expect(widget.handleMouse({ type: "click" } as TuiMouseEvent)).toBeUndefined();
		expect(widget.handleMouse(wheel(0))).toBeUndefined();
	});

	it("moves up from a focus offset beyond the last full window", () => {
		const { widget } = setup(numberedTasks(14, 15));
		expect(widget.handleMouse(wheel(-1))).toEqual({ handled: true });
		expectWindow(widget, 5, "↑ 4 above · ↓ 1 below");
	});

	it("preserves the window on identical state and refocuses when the task list changes", () => {
		const tasks = numberedTasks(10, 11);
		const { overlay, widget } = setup(tasks);
		widget.handleMouse(wheel(-3));
		expectWindow(widget, 3, "↑ 2 above · ↓ 3 below");
		setTaskState("main", makeState(structuredClone(tasks)));
		overlay.update();
		expectWindow(widget, 3, "↑ 2 above · ↓ 3 below");
		setTaskState(
			"main",
			makeState(tasks.map((task) => (task.id === "1" ? { ...task, description: "Edited" } : task))),
		);
		overlay.update();
		expectWindow(widget, 6, "↑ 5 above");
		setTaskState("main", makeState(numberedTasks(0, 1)));
		overlay.update();
		expectWindow(widget, 1, "↓ 5 below");
	});

	it("leaves the wheel unhandled when the list fits or is collapsed", () => {
		expect(setup([makeTask()]).widget.handleMouse(wheel(2))).toBeUndefined();
		const { overlay, widget } = setup(numberedTasks());
		overlay.toggleCollapse();
		expect(widget.handleMouse(wheel(2))).toBeUndefined();
		overlay.toggleCollapse();
		expectWindow(widget, 1, "↓ 5 below");
	});

	it("registers a replacement UI and follows its current theme", () => {
		const { overlay } = setup([makeTask()]);
		const themed = makeTheme({ fg: (color, text) => `<${color}>${text}</${color}>` }) as Theme;
		const ui = createMockUI({ theme: themed });
		overlay.setUICtx(ui as unknown as ExtensionUIContext);
		overlay.update();
		const factory: (tui: TUI, theme: Theme) => Component = ui.setWidget.mock.calls[0][1];
		const widget = factory({ requestRender: vi.fn() } as unknown as TUI, themeFallback());
		expect(widget.render(200)[0]).toContain("<accent>Tasks (0/1)</accent>");
		Object.assign(ui, { theme: makeTheme() as Theme });
		expect(widget.render(200)[0]).toBe("● Tasks (0/1)");
	});

	it("renders the same panel when the host has no MouseRegion", async () => {
		const tasks = numberedTasks(10, 11);
		const expected = setup(tasks).widget.render(100);
		vi.doMock("@earendil-works/pi-tui", async (importOriginal) => ({
			...(await importOriginal<typeof import("@earendil-works/pi-tui")>()),
			MouseRegion: undefined,
		}));
		vi.resetModules();
		try {
			const { TodoOverlay: HostOverlay } = await import("./overlay.js");
			const store = await import("./store.js");
			store.setForeground("compat");
			store.setTaskState("compat", makeState(tasks));
			let widget: Component | undefined;
			const theme = themeFallback();
			const ui = createMockUI({
				theme,
				setWidget: vi.fn((_key, factory) => {
					if (typeof factory === "function") widget = factory({ requestRender: vi.fn() } as unknown as TUI, theme);
				}),
			});
			const overlay = new HostOverlay({ maxWidgetLines: 12, collapseKey: "alt+o" });
			overlay.setUICtx(ui as unknown as ExtensionUIContext);
			overlay.update();
			if (!widget) throw new Error("missing widget");
			expect(widget).not.toHaveProperty("handleMouse");
			expect(widget.render(100)).toEqual(expected);
		} finally {
			vi.doUnmock("@earendil-works/pi-tui");
			vi.resetModules();
		}
	});
});

function themeFallback(): Theme {
	return makeTheme() as Theme;
}
