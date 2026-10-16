/** Registers the unified task contract and projects branch state into context and the UI. */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, loadSettings } from "./config.js";
import { buildTaskContext, carriedOverTasks, TASK_CONTEXT_TYPE, taskContextIndex } from "./context.js";
import { formatError, type SessionCtx, sessionIdOf, unlessStale } from "./host.js";
import { panelTasks } from "./model.js";
import { TASK_WRITE } from "./names.js";
import type { TodoOverlay } from "./overlay.js";
import { isStaleOverlayModuleError, makeOverlayLoader, type OverlayImporter } from "./overlay-loader.js";
import { replayFromBranch } from "./persistence.js";
import {
	clearForeground,
	evictSession,
	failSession,
	getForeground,
	getForegroundState,
	getTaskState,
	setForeground,
	setTaskState,
} from "./store.js";
import { registerTasksCommand, registerTaskTools } from "./tool.js";

/** Delay before pre-warming the overlay module, so Pi's startup work settles first. */
export const PREWARM_DELAY_MS = 2000;

export default function (pi: ExtensionAPI, importOverlay?: OverlayImporter) {
	const settings = loadSettings();
	const loadOverlay = makeOverlayLoader(importOverlay);
	let overlay: TodoOverlay | undefined;
	let ui: ExtensionUIContext | undefined;
	// Bumped whenever the foreground UI binding changes, so an overlay import
	// that resolves late cannot bind to a context that has since gone away.
	let uiGeneration = 0;
	let prewarmTimer: ReturnType<typeof setTimeout> | undefined;

	async function refreshOverlay(generation = uiGeneration): Promise<void> {
		if (!ui || (!overlay && panelTasks(getForegroundState()).length === 0)) return;
		const { TodoOverlay } = await loadOverlay();
		if (generation !== uiGeneration || !ui) return;
		overlay ??= new TodoOverlay({ maxWidgetLines: settings.maxWidgetLines, collapseKey: settings.collapseKey });
		overlay.setUICtx(ui);
		overlay.update();
	}

	/** A failed refresh only costs this redraw; the latched stale-module error needs a restart, so surface it. */
	async function refreshOverlaySafely(): Promise<void> {
		try {
			await refreshOverlay();
		} catch (error) {
			if (isStaleOverlayModuleError(error)) throw error;
			console.warn(`[pi-todos] overlay refresh failed (will retry on next update): ${formatError(error)}`);
		}
	}

	/** Replay a session's list from its branch. Returns its id, or undefined if the ctx is stale. */
	function restore(ctx: SessionCtx): string | undefined {
		return unlessStale(() => {
			const id = sessionIdOf(ctx);
			try {
				setTaskState(id, replayFromBranch(ctx.sessionManager.getBranch()));
			} catch (error) {
				failSession(id, error instanceof Error ? error : new Error(String(error)));
				if (id === getForeground()) {
					uiGeneration++;
					overlay?.dispose();
				}
				throw error;
			}
			return id;
		});
	}

	registerTaskTools(pi, settings.guidance);
	registerTasksCommand(pi);

	if (settings.collapseKey !== COLLAPSE_KEY_OFF) {
		pi.registerShortcut(settings.collapseKey as KeyId, {
			description: "Collapse or expand the task overlay",
			handler: (ctx) => {
				if (ctx.hasUI && overlay?.isRegistered()) overlay.toggleCollapse();
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		const id = restore(ctx);
		if (id === undefined || !ctx.hasUI) return;
		// The first UI-bearing session owns the overlay; child sessions keep
		// their own state but never rebind it.
		if (getForeground() === undefined) setForeground(id);
		if (id !== getForeground()) return;
		ui = ctx.ui;
		clearTimeout(prewarmTimer);
		// A failed warm-up is retried by the next actual overlay update.
		prewarmTimer = setTimeout(() => void loadOverlay().catch(() => undefined), PREWARM_DELAY_MS);
		prewarmTimer.unref?.();
		await refreshOverlay(++uiGeneration);
	});

	const restoreAndRefresh = async (ctx: SessionCtx) => {
		const id = restore(ctx);
		if (id !== undefined && id === getForeground()) await refreshOverlay();
	};
	pi.on("session_compact", (_event, ctx) => restoreAndRefresh(ctx));
	pi.on("session_tree", (_event, ctx) => restoreAndRefresh(ctx));

	pi.on("session_shutdown", async (_event, ctx) => {
		// A stale ctx during disposal is treated as the foreground shutting down.
		const id = unlessStale(() => sessionIdOf(ctx)) ?? getForeground();
		if (id !== undefined) {
			evictSession(id);
		}
		if (id !== undefined && id !== getForeground()) return;
		uiGeneration++;
		clearTimeout(prewarmTimer);
		ui = undefined;
		try {
			overlay?.dispose();
		} finally {
			overlay = undefined;
			clearForeground();
		}
	});

	pi.on("context", (event, ctx) => {
		if (!settings.taskContext) return;
		const branch = unlessStale(() => {
			// A failed restoration keeps blocking task access here as it does in the tools.
			getTaskState(sessionIdOf(ctx));
			return ctx.sessionManager.getBranch();
		});
		if (branch === undefined) return;
		// Drop this extension's transient view if another hook passes it back.
		const messages = event.messages.filter(
			(message) => message.role !== "custom" || message.customType !== TASK_CONTEXT_TYPE,
		);
		const visible = new Set(
			messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])),
		);
		const carried = carriedOverTasks(branch, visible);
		const content = carried && buildTaskContext(carried.state);
		if (!content) return messages.length === event.messages.length ? undefined : { messages };
		const index = taskContextIndex(messages);
		return {
			messages: [
				...messages.slice(0, index),
				{
					role: "custom" as const,
					customType: TASK_CONTEXT_TYPE,
					content,
					display: false,
					timestamp: carried.timestamp,
				},
				...messages.slice(index),
			],
		};
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== TASK_WRITE || event.isError) return;
		await refreshOverlaySafely();
	});
}
