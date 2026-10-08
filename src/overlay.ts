/**
 * Persistent widget above the editor showing the foreground session's list.
 * Loaded lazily (see overlay-loader.ts) so sessions without todos never pay
 * for it.
 *
 * Display rules:
 * - the heading counts the whole list;
 * - past the row budget the list becomes a window over the full list: the
 *   mouse wheel moves it (Pi's fullscreen renderer captures the mouse; Pi 0.85+)
 *   and the footer counts the rows hidden above and below. Pi's tool-output
 *   expansion still shows every item;
 * - a changed list opens the window at the item in progress, else the first
 *   unfinished item; resending the same list keeps the window;
 * - once the list is finished, it is dismissed at the start of the next agent
 *   turn and stays hidden until the model writes a different list.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";
import { type TUI, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth } from "@earendil-works/pi-tui";
import { formatThemedLine } from "./format.js";
import { countTodos, EMPTY_TODOS, isFinished, type Todo, type TodoList } from "./model.js";
import { getForegroundTodos } from "./store.js";

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
	visible: readonly Todo[];
	above: number;
	below: number;
}

/** Clip `todos` to a `rows`-high window at `scrollTop`, counting the rows it hides. */
export function windowTodos(todos: TodoList, rows: number, scrollTop: number): OverlayWindow {
	const maxScrollTop = Math.max(0, todos.length - rows);
	const top = Math.max(0, Math.min(maxScrollTop, Math.trunc(scrollTop)));
	const visible = todos.slice(top, top + rows);
	return { visible, above: top, below: todos.length - top - visible.length };
}

function listKey(todos: TodoList): string {
	return JSON.stringify(todos);
}

/** Where a changed list's window opens: the item in progress, else the first unfinished item, else the top. */
function focusIndex(todos: TodoList): number {
	const active = todos.findIndex((todo) => todo.status === "in_progress");
	if (active !== -1) return active;
	const unfinished = todos.findIndex((todo) => todo.status !== "completed");
	return unfinished === -1 ? 0 : unfinished;
}

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private tui: TUI | undefined;
	private registered = false;
	private collapsed = false;
	/** Serialized list hidden by `dismissIfFinished`; content-based so a replay of the same list stays hidden. */
	private dismissedKey: string | undefined;
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
		const todos = this.todos();
		if (todos.length === 0) {
			if (this.registered) this.uiCtx.setWidget(WIDGET_KEY, undefined);
			this.registered = false;
			this.tui = undefined;
			return;
		}
		this.anchorScroll(todos);
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

	/** Called at the start of an agent turn: a finished list has served its purpose. */
	dismissIfFinished(): void {
		const todos = getForegroundTodos();
		if (!isFinished(todos)) return;
		this.dismissedKey = listKey(todos);
		this.update();
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

	private todos(): TodoList {
		const todos = getForegroundTodos();
		return this.dismissedKey !== undefined && listKey(todos) === this.dismissedKey ? EMPTY_TODOS : todos;
	}

	/** Move the window to the current work when the list content has changed. */
	private anchorScroll(todos: TodoList): void {
		const key = listKey(todos);
		if (key !== this.scrolledKey) {
			this.scrolledKey = key;
			this.scrollTop = focusIndex(todos);
		}
	}

	/** Content rows the window shows; on overflow the footer takes one of them. */
	private windowRows(todos: TodoList): number {
		const budget = Math.max(this.options.maxWidgetLines - 1, 1);
		// Pi's tool-output expansion (ctrl+o by default) also expands this widget.
		if (this.uiCtx?.getToolsExpanded?.() === true) return todos.length;
		return todos.length > budget ? Math.max(budget - 1, 1) : budget;
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
		const todos = this.todos();
		const maxScrollTop = todos.length - this.windowRows(todos);
		if (maxScrollTop <= 0) return undefined;
		this.anchorScroll(todos);
		// Move from where the window is drawn, not from a requested offset past the end.
		const current = Math.min(maxScrollTop, this.scrollTop);
		const next = Math.max(0, Math.min(maxScrollTop, current + lines));
		if (next === current) return undefined;
		this.scrollTop = next;
		return { handled: true };
	}

	private render(theme: Theme, width: number): string[] {
		const todos = this.todos();
		if (todos.length === 0) return [];
		const clip = (line: string) => truncateToWidth(line, width, "…");
		const counts = countTodos(todos);
		const active = counts.completed < counts.total;
		const color = active ? "accent" : "dim";
		const heading = clip(
			`${theme.fg(color, active ? "●" : "○")} ${theme.fg(color, `Todos (${counts.completed}/${counts.total})`)}`,
		);

		if (this.collapsed) {
			const hint = `${this.options.collapseKey} to expand`;
			return [heading, clip(`${theme.fg("dim", "└─")} ${theme.fg("dim", hint)}`), ""];
		}

		const rows = this.windowRows(todos);
		const win = windowTodos(todos, rows, this.scrollTop);
		const body = win.visible.map((todo) => formatThemedLine(todo, theme));
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
