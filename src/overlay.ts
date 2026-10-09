/**
 * Persistent widget above the editor showing the foreground session's task
 * list. Loaded lazily (see overlay-loader.ts) so sessions without tasks never
 * pay for it.
 *
 * Display rules:
 * - internal tasks (`metadata._internal`) are hidden; the heading counts the rest;
 * - past the row budget the list becomes a window over the full list: the
 *   mouse wheel moves it (Pi's fullscreen renderer captures the mouse; Pi 0.85+)
 *   and the footer counts the rows hidden above and below. Pi's tool-output
 *   expansion still shows every task;
 * - a changed list opens the window at the first task in progress, else the
 *   first unfinished task; a write that changes nothing keeps the window;
 * - a finished list is cleared at the start of the next agent run (see
 *   index.ts), which removes the widget.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import { type TUI, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth } from "@earendil-works/pi-tui";
import { formatThemedLine } from "./format.js";
import { countTasks, openBlockers, type Task, visibleTasks } from "./model.js";
import { getForegroundState } from "./store.js";

const WIDGET_KEY = "pi-todos";

/** Added in pi-tui 0.85.0; read off the namespace so older hosts still load the panel, without wheel scrolling. */
const MouseRegion = piTui.MouseRegion as typeof piTui.MouseRegion | undefined;

export interface OverlayOptions {
	/** Content-row budget, heading included. */
	maxWidgetLines: number;
	/** The key actually bound to `toggleCollapse`, shown in the collapsed hint. */
	collapseKey: string;
}

export interface OverlayWindow {
	visible: readonly Task[];
	above: number;
	below: number;
}

/** Clip `tasks` to a `rows`-high window at `scrollTop`, counting the rows it hides. */
export function windowTasks(tasks: readonly Task[], rows: number, scrollTop: number): OverlayWindow {
	const maxScrollTop = Math.max(0, tasks.length - rows);
	const top = Math.max(0, Math.min(maxScrollTop, Math.trunc(scrollTop)));
	const visible = tasks.slice(top, top + rows);
	return { visible, above: top, below: tasks.length - top - visible.length };
}

function listKey(tasks: readonly Task[]): string {
	return JSON.stringify(tasks);
}

/** Where a changed list's window opens: the first task in progress, else the first unfinished task, else the top. */
function focusIndex(tasks: readonly Task[]): number {
	const active = tasks.findIndex((task) => task.status === "in_progress");
	if (active !== -1) return active;
	const unfinished = tasks.findIndex((task) => task.status !== "completed");
	return unfinished === -1 ? 0 : unfinished;
}

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private tui: TUI | undefined;
	private registered = false;
	private collapsed = false;
	/**
	 * Requested window offset into the current list; it may point past the last
	 * full window, which rendering clamps. `scrolledKey` is the list it belongs to.
	 */
	private scrollTop = 0;
	private scrolledKey: string | undefined;
	private readonly options: OverlayOptions;

	constructor(options: OverlayOptions) {
		this.options = options;
	}

	setUICtx(ctx: ExtensionUIContext): void {
		// A new UI context (after /reload) needs a fresh registration.
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.registered = false;
			this.tui = undefined;
		}
	}

	/** Register, refresh or unregister the widget to match the current list. */
	update(): void {
		if (!this.uiCtx) return;
		const tasks = this.tasks();
		if (tasks.length === 0) {
			if (this.registered) this.uiCtx.setWidget(WIDGET_KEY, undefined);
			this.registered = false;
			this.tui = undefined;
			return;
		}
		this.anchorScroll(tasks);
		if (this.registered) {
			this.tui?.requestRender();
			return;
		}
		this.uiCtx.setWidget(
			WIDGET_KEY,
			(tui, factoryTheme) => {
				this.tui = tui;
				const panel = {
					// Read the theme per render so theme switches apply; nothing is cached.
					render: (width: number) => this.render(this.uiCtx?.theme ?? factoryTheme, width),
					invalidate: () => {},
				};
				return MouseRegion ? new MouseRegion(panel, (event) => this.onMouse(event)) : panel;
			},
			{ placement: "aboveEditor" },
		);
		this.registered = true;
	}

	toggleCollapse(): void {
		this.collapsed = !this.collapsed;
		// Force a full redraw: the widget height changes.
		this.tui?.requestRender(true);
	}

	isRegistered(): boolean {
		return this.registered;
	}

	dispose(): void {
		try {
			if (this.uiCtx && this.registered) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		} finally {
			this.uiCtx = undefined;
			this.tui = undefined;
			this.registered = false;
		}
	}

	private tasks(): Task[] {
		return visibleTasks(getForegroundState());
	}

	/** Move the window to the current work when the list content has changed. */
	private anchorScroll(tasks: readonly Task[]): void {
		const key = listKey(tasks);
		if (key !== this.scrolledKey) {
			this.scrolledKey = key;
			this.scrollTop = focusIndex(tasks);
		}
	}

	/** Content rows the window shows; on overflow the footer takes one of them. */
	private windowRows(tasks: readonly Task[]): number {
		const budget = Math.max(this.options.maxWidgetLines - 1, 1);
		// Pi's tool-output expansion (ctrl+o by default) also expands this widget.
		if (this.uiCtx?.getToolsExpanded?.() === true) return tasks.length;
		return tasks.length > budget ? Math.max(budget - 1, 1) : budget;
	}

	/**
	 * The wheel is the only event this widget consumes, and only while the list
	 * overflows. At the window's edges the event stays unhandled so the host
	 * keeps its default wheel behavior.
	 */
	private onMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || this.collapsed) return undefined;
		const lines = Math.trunc(event.wheelDelta ?? 0);
		if (lines === 0) return undefined;
		const tasks = this.tasks();
		const maxScrollTop = tasks.length - this.windowRows(tasks);
		if (maxScrollTop <= 0) return undefined;
		this.anchorScroll(tasks);
		// Move from where the window is drawn, not from a requested offset past the end.
		const current = Math.min(maxScrollTop, this.scrollTop);
		const next = Math.max(0, Math.min(maxScrollTop, current + lines));
		if (next === current) return undefined;
		this.scrollTop = next;
		return { handled: true };
	}

	private render(theme: Theme, width: number): string[] {
		const state = getForegroundState();
		const tasks = visibleTasks(state);
		if (tasks.length === 0) return [];
		const clip = (line: string) => truncateToWidth(line, width, "…");
		const counts = countTasks(tasks);
		const active = counts.completed < counts.total;
		const color = active ? "accent" : "dim";
		const heading = clip(
			`${theme.fg(color, active ? "●" : "○")} ${theme.fg(color, `Tasks (${counts.completed}/${counts.total})`)}`,
		);

		if (this.collapsed) {
			const hint = `${this.options.collapseKey} to expand`;
			return [heading, clip(`${theme.fg("dim", "└─")} ${theme.fg("dim", hint)}`), ""];
		}

		const rows = this.windowRows(tasks);
		const win = windowTasks(tasks, rows, this.scrollTop);
		const body = win.visible.map((task) => formatThemedLine(task, openBlockers(state, task), theme));
		if (win.above + win.below > 0) {
			const parts: string[] = [];
			if (win.above > 0) parts.push(`↑ ${win.above} above`);
			if (win.below > 0) parts.push(`↓ ${win.below} below`);
			body.push(theme.fg("dim", parts.join(" · ")));
		}
		const lines = body.map((row, index) =>
			clip(`${theme.fg("dim", index === body.length - 1 ? "└─" : "├─")} ${row}`),
		);
		// Trailing spacer: Pi pads above widgets but not below, so keep the panel off the editor border.
		return [heading, ...lines, ""];
	}
}
