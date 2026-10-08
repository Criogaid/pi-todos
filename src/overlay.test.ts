import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type MouseRegion, type TUI, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createMockUI, makeTheme } from "../test/helpers/index.js";
import type { Todo } from "./model.js";
import { TodoOverlay, windowTodos } from "./overlay.js";
import { setForeground, setTodos } from "./store.js";

const pending = (content: string): Todo => ({ content, status: "pending" });
const done = (content: string): Todo => ({ content, status: "completed" });
const inProgress = (content: string): Todo => ({ content, status: "in_progress", activeForm: `Working on ${content}` });

function numberedTodos(completed: number, active?: number): Todo[] {
	return Array.from({ length: 15 }, (_, index) => {
		const position = index + 1;
		const content = `Task ${position}`;
		return position === active ? inProgress(content) : position <= completed ? done(content) : pending(content);
	});
}

function expectWindow(widget: Component, first: number, footer: string): void {
	const lines = widget.render(100);
	expect(lines).toHaveLength(13);
	expect(lines.slice(1, -2).map((line) => line.match(/Task \d+/)?.[0])).toEqual(
		Array.from({ length: 10 }, (_, index) => `Task ${first + index}`),
	);
	expect(lines.at(-2)).toBe(`└─ ${footer}`);
	expect(lines.at(-1)).toBe("");
}

/** The overlay reads only `type` and `wheelDelta` from mouse events. */
const wheel = (delta: number) => ({ type: "wheel", wheelDelta: delta }) as TuiMouseEvent;

function setup(todos: Todo[], maxWidgetLines = 12, collapseKey = "alt+o") {
	setForeground("main");
	setTodos("main", todos);
	const theme = makeTheme() as Theme;
	const ui = createMockUI({ theme });
	const requestRender = vi.fn();
	const overlay = new TodoOverlay({ maxWidgetLines, collapseKey });
	// A widget factory receives only this TUI method in these tests.
	const tui = { requestRender } as unknown as TUI;
	overlay.setUICtx(ui as unknown as ExtensionUIContext);
	overlay.update();
	const call = ui.setWidget.mock.calls.find(([, factory]) => typeof factory === "function");
	if (!call) throw new Error("widget not registered");
	const factory: (tui: TUI, theme: Theme) => MouseRegion = call[1];
	const widget = factory(tui, theme);
	return { overlay, ui, widget, requestRender };
}

describe("windowTodos", () => {
	const todos = [pending("A"), pending("B"), pending("C"), pending("D"), pending("E")];

	it("returns the whole list when it fits", () => {
		expect(windowTodos(todos.slice(0, 2), 3, 0)).toEqual({ visible: todos.slice(0, 2), above: 0, below: 0 });
	});

	it("windows into the list and counts both hidden sides", () => {
		expect(windowTodos(todos, 2, 1)).toEqual({ visible: [todos[1], todos[2]], above: 1, below: 2 });
	});

	it("clamps an out-of-range offset to the last window", () => {
		expect(windowTodos(todos, 2, 99)).toEqual({ visible: [todos[3], todos[4]], above: 3, below: 0 });
		expect(windowTodos(todos, 2, -4)).toEqual({ visible: [todos[0], todos[1]], above: 0, below: 3 });
	});
});

describe("TodoOverlay", () => {
	it("counts the entire list in the heading and reports rows outside the window", () => {
		const { ui, widget } = setup([done("Old"), pending("A"), pending("B"), pending("C"), pending("D")], 4);
		expect(ui.setWidget).toHaveBeenCalledWith("pi-todos", expect.any(Function), { placement: "aboveEditor" });
		expect(widget.render(100)).toEqual(["● Todos (1/5)", "├─ ○ A", "├─ ○ B", "└─ ↑ 1 above · ↓ 2 below", ""]);
	});

	it.each([
		{ active: 11, completed: 10, first: 6, footer: "↑ 5 above" },
		{ active: 1, completed: 0, first: 1, footer: "↓ 5 below" },
		{ active: 15, completed: 14, first: 6, footer: "↑ 5 above" },
	])("keeps active item $active and its active form visible", ({ active, completed, first, footer }) => {
		const { widget } = setup(numberedTodos(completed, active));
		expectWindow(widget, first, footer);
		expect(widget.render(100)[0]).toBe(`● Todos (${completed}/15)`);
		expect(widget.render(100)).toContain(`├─ ◐ Task ${active} (Working on Task ${active})`);
	});

	it("prefers the in-progress item over earlier pending items", () => {
		const { widget } = setup(numberedTodos(0, 11));
		expectWindow(widget, 6, "↑ 5 above");
		expect(widget.render(100)).toContain("├─ ◐ Task 11 (Working on Task 11)");
	});

	it.each([
		{ completed: 13, first: 6, footer: "↑ 5 above" },
		{ completed: 15, first: 1, footer: "↓ 5 below" },
	])("focuses unfinished work or the top with $completed completed items", ({ completed, first, footer }) => {
		const { widget } = setup(numberedTodos(completed));
		expectWindow(widget, first, footer);
		if (completed === 13) expect(widget.render(100)).toContain("├─ ○ Task 14");
	});

	it("moves up immediately from a focus offset beyond the last full window", () => {
		const { widget } = setup(numberedTodos(14, 15));
		expectWindow(widget, 6, "↑ 5 above");
		expect(widget.handleMouse(wheel(1))).toBeUndefined();
		expectWindow(widget, 6, "↑ 5 above");
		expect(widget.handleMouse(wheel(-1))).toEqual({ handled: true });
		expectWindow(widget, 5, "↑ 4 above · ↓ 1 below");
	});

	it("follows newly active work after the user scrolls", () => {
		const { overlay, widget } = setup(numberedTodos(0, 1));
		expect(widget.handleMouse(wheel(2))).toEqual({ handled: true });
		expectWindow(widget, 3, "↑ 2 above · ↓ 3 below");
		setTodos("main", numberedTodos(10, 11));
		overlay.update();
		expectWindow(widget, 6, "↑ 5 above");
		expect(widget.render(100)).toContain("├─ ◐ Task 11 (Working on Task 11)");
	});

	it("shows a dim completed heading and uses the bound key in the collapse hint", () => {
		const { widget, overlay, requestRender } = setup([done("Finished")], 12, "ctrl+]");
		expect(widget.render(100)[0]).toBe("○ Todos (1/1)");
		overlay.toggleCollapse();
		expect(widget.render(100)).toEqual(["○ Todos (1/1)", "└─ ctrl+] to expand", ""]);
		expect(requestRender).toHaveBeenCalledWith(true);
		overlay.toggleCollapse();
		expect(widget.render(100)).toContain("└─ ✓ Finished");
	});

	it("dismisses a finished list until different content is written", () => {
		const { overlay, ui } = setup([done("Finished")]);
		overlay.dismissIfFinished();
		expect(overlay.isRegistered()).toBe(false);
		expect(ui.setWidget).toHaveBeenLastCalledWith("pi-todos", undefined);
		setTodos("main", [done("Finished")]);
		overlay.update();
		expect(overlay.isRegistered()).toBe(false);
		setTodos("main", [pending("New work")]);
		overlay.update();
		expect(overlay.isRegistered()).toBe(true);
		setTodos("main", [done("Different finished list")]);
		overlay.update();
		expect(overlay.isRegistered()).toBe(true);
	});

	it("retains unfinished work on dismissal and unregisters when cleared or disposed", () => {
		const { overlay, ui, widget } = setup([pending("Work")]);
		overlay.dismissIfFinished();
		expect(overlay.isRegistered()).toBe(true);
		expect(widget.render(100)).toContain("└─ ○ Work");
		setTodos("main", []);
		overlay.update();
		expect(overlay.isRegistered()).toBe(false);
		expect(ui.setWidget).toHaveBeenLastCalledWith("pi-todos", undefined);
		setTodos("main", [pending("Again")]);
		overlay.update();
		overlay.dispose();
		expect(overlay.isRegistered()).toBe(false);
		overlay.update();
		expect(overlay.isRegistered()).toBe(false);
	});

	it("expands all items with the host expansion control and clips narrow output", () => {
		const { widget, ui } = setup(
			Array.from({ length: 8 }, (_, i) => pending(`Long task number ${i}`)),
			3,
		);
		expect(widget.render(100)).toHaveLength(4);
		const getToolsExpanded = vi.fn(() => true);
		Object.assign(ui, { getToolsExpanded });
		expect(widget.render(100)).toHaveLength(10);
		for (const line of widget.render(12)) expect(visibleWidth(line)).toBeLessThanOrEqual(12);
	});

	it("shows the whole list while expanded and restores the clamped focus window", () => {
		const { overlay, widget, ui } = setup(numberedTodos(14, 15));
		expectWindow(widget, 6, "↑ 5 above");
		const getToolsExpanded = vi.fn(() => true);
		Object.assign(ui, { getToolsExpanded });
		const expanded = widget.render(100);
		expect(expanded).toHaveLength(17);
		expect(expanded.slice(1, -1).map((line) => line.match(/Task \d+/)?.[0])).toEqual(
			Array.from({ length: 15 }, (_, index) => `Task ${index + 1}`),
		);
		expect(expanded.some((line) => /[↑↓]/.test(line))).toBe(false);
		expect(widget.handleMouse(wheel(-1))).toBeUndefined();
		overlay.update();
		getToolsExpanded.mockReturnValue(false);
		expectWindow(widget, 6, "↑ 5 above");
		expect(widget.render(100)).toContain("├─ ◐ Task 15 (Working on Task 15)");
	});

	it("scrolls the window with the mouse wheel and clamps at the last window", () => {
		const todos = Array.from({ length: 5 }, (_, i) => pending(`Task ${i}`));
		const { overlay, widget } = setup(todos, 4);
		// Budget 4: heading + two window rows + footer. Wheel to the middle.
		expect(widget.handleMouse(wheel(2))).toEqual({ handled: true });
		overlay.update();
		expect(widget.render(100)).toEqual([
			"● Todos (0/5)",
			"├─ ○ Task 2",
			"├─ ○ Task 3",
			"└─ ↑ 2 above · ↓ 1 below",
			"",
		]);
		// Overshooting clamps to the last window, not past it.
		expect(widget.handleMouse(wheel(9))).toEqual({ handled: true });
		expect(widget.render(100)).toEqual(["● Todos (0/5)", "├─ ○ Task 3", "├─ ○ Task 4", "└─ ↑ 3 above", ""]);
	});

	it("leaves edge and non-wheel mouse events unhandled", () => {
		const todos = Array.from({ length: 5 }, (_, i) => pending(`Task ${i}`));
		const { widget } = setup(todos, 4);
		expect(widget.handleMouse(wheel(-1))).toBeUndefined();
		expect(widget.handleMouse(wheel(99))).toEqual({ handled: true });
		expect(widget.handleMouse(wheel(1))).toBeUndefined();
		expect(widget.handleMouse({ type: "click" } as TuiMouseEvent)).toBeUndefined();
	});

	it("ignores the wheel while the list fits, is expanded, or is collapsed", () => {
		const { widget } = setup([pending("Only"), pending("Two")], 12);
		expect(widget.handleMouse(wheel(3))).toBeUndefined();
	});

	it("leaves the wheel unhandled while collapsed", () => {
		const todos = Array.from({ length: 5 }, (_, i) => pending(`Task ${i}`));
		const { overlay, widget } = setup(todos, 4);
		overlay.toggleCollapse();
		expect(widget.handleMouse(wheel(2))).toBeUndefined();
		overlay.toggleCollapse();
		// The hidden window did not move.
		expect(widget.render(100).join("\n")).toContain("○ Task 0");
	});

	it("preserves a scrolled window for identical content and refocuses after an offscreen edit", () => {
		const todos = numberedTodos(10, 11);
		const { overlay, widget } = setup(todos);
		expect(widget.handleMouse(wheel(-3))).toEqual({ handled: true });
		expectWindow(widget, 3, "↑ 2 above · ↓ 3 below");
		setTodos(
			"main",
			todos.map((todo) => ({ ...todo })),
		);
		overlay.update();
		expectWindow(widget, 3, "↑ 2 above · ↓ 3 below");
		setTodos(
			"main",
			todos.map((todo, index) => (index === 0 ? { ...todo, content: "Updated first task" } : { ...todo })),
		);
		overlay.update();
		expectWindow(widget, 6, "↑ 5 above");
		expect(widget.render(100)).toContain("├─ ◐ Task 11 (Working on Task 11)");
	});

	it("registers on a replacement UI context and uses its current theme", () => {
		const { overlay } = setup([pending("Work")]);
		const theme = makeTheme({ fg: (color, text) => `<${color}>${text}</${color}>` }) as Theme;
		const ui = createMockUI({ theme });
		overlay.setUICtx(ui as unknown as ExtensionUIContext);
		overlay.update();
		expect(ui.setWidget).toHaveBeenCalledWith("pi-todos", expect.any(Function), { placement: "aboveEditor" });
		const factory: (tui: TUI, theme: Theme) => Component = ui.setWidget.mock.calls[0][1];
		const widget = factory({ requestRender: vi.fn() } as unknown as TUI, makeTheme() as Theme);
		expect(widget.render(200)[0]).toContain("<accent>Todos (0/1)</accent>");
	});

	it("registers and renders the same panel when the host has no MouseRegion", async () => {
		const todos = numberedTodos(10, 11);
		const expected = setup(todos).widget.render(100);
		vi.doMock("@earendil-works/pi-tui", async (importOriginal) => {
			const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
			// Vitest rejects missing mock exports; undefined models a host without this export.
			return { ...actual, MouseRegion: undefined };
		});
		vi.resetModules();
		try {
			const { TodoOverlay: HostTodoOverlay } = await import("./overlay.js");
			const store = await import("./store.js");
			store.setForeground("no-mouse-region");
			store.setTodos("no-mouse-region", todos);
			const theme = makeTheme() as Theme;
			const tui = { requestRender: vi.fn() } as unknown as TUI;
			let widget: Component | undefined;
			const ui = createMockUI({
				theme,
				setWidget: vi.fn((_key, factory) => {
					if (typeof factory === "function") widget = factory(tui, theme);
				}),
			});
			const overlay = new HostTodoOverlay({ maxWidgetLines: 12, collapseKey: "alt+o" });
			overlay.setUICtx(ui as unknown as ExtensionUIContext);
			expect(() => overlay.update()).not.toThrow();
			expect(overlay.isRegistered()).toBe(true);
			if (!widget) throw new Error("widget factory did not return a panel");
			expect(widget).not.toHaveProperty("handleMouse");
			expect(typeof widget.invalidate).toBe("function");
			expect(widget.render(100)).toEqual(expected);
		} finally {
			vi.doUnmock("@earendil-works/pi-tui");
			vi.resetModules();
		}
	});
});
