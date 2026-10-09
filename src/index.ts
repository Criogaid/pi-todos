/**
 * pi-todos — registers Claude Code's task tools (TaskCreate, TaskGet,
 * TaskList, TaskUpdate), the `/tasks` command and the overlay, and maps Pi
 * lifecycle events onto them:
 *
 * - session start / compaction / tree navigation: replay the list from the
 *   branch and owe the model one resume summary;
 * - `context`: send that summary; a successful assistant message acknowledges it;
 * - a successful TaskCreate or TaskUpdate call: refresh the overlay;
 * - agent start: clear a finished list, keeping the id counter;
 * - turn end: remind the model of the task tools after 10 turns without them;
 * - shutdown: drop the session's state and, for the foreground, the overlay.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, loadSettings } from "./config.js";
import { formatError, type SessionCtx, sessionIdOf, unlessStale } from "./host.js";
import { isFinished, resetTasks, visibleTasks } from "./model.js";
import { TASK_CREATE, TASK_WRITE_TOOL_NAMES } from "./names.js";
import type { TodoOverlay } from "./overlay.js";
import { isStaleOverlayModuleError, makeOverlayLoader, type OverlayImporter } from "./overlay-loader.js";
import { replayFromBranch, snapshotOf, TASKS_SNAPSHOT_TYPE } from "./persistence.js";
import { isReminderDue, REMINDER_MESSAGE_TYPE, REMINDER_TEXT } from "./reminder.js";
import { buildResumeContext, ResumeTracker } from "./resume.js";
import {
	clearForeground,
	evictSession,
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
	const resume = new ResumeTracker();
	let overlay: TodoOverlay | undefined;
	let ui: ExtensionUIContext | undefined;
	// Bumped whenever the foreground UI binding changes, so an overlay import
	// that resolves late cannot bind to a context that has since gone away.
	let uiGeneration = 0;

	async function refreshOverlay(generation = uiGeneration): Promise<void> {
		if (!ui || (!overlay && visibleTasks(getForegroundState()).length === 0)) return;
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
			setTaskState(id, replayFromBranch(ctx.sessionManager.getBranch()));
			if (settings.resumeContext) resume.mark(id);
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
			resume.drop(id);
		}
		if (id !== undefined && id !== getForeground()) return;
		uiGeneration++;
		ui = undefined;
		try {
			overlay?.dispose();
		} finally {
			overlay = undefined;
			clearForeground();
		}
	});

	// `context` runs before every provider call, including the continuation
	// right after auto-compaction. The summary is transient, not persisted.
	pi.on("context", (event, ctx) => {
		const id = unlessStale(() => sessionIdOf(ctx));
		if (id === undefined || !resume.begin(id)) return;
		const content = buildResumeContext(getTaskState(id));
		if (!content) {
			resume.drop(id);
			return;
		}
		return {
			messages: [
				...event.messages,
				{ role: "custom" as const, customType: "pi-todos-resume", content, display: false, timestamp: Date.now() },
			],
		};
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
		const id = unlessStale(() => sessionIdOf(ctx));
		if (id !== undefined) resume.acknowledge(id);
	});

	pi.on("tool_execution_end", async (event) => {
		if (!TASK_WRITE_TOOL_NAMES.includes(event.toolName) || event.isError) return;
		await refreshOverlaySafely();
	});

	// Claude Code clears a finished list shortly after its last task completes.
	// Doing it when the next run starts keeps the finished list on screen until
	// the user moves on. The snapshot has no call id: it is not a model call.
	pi.on("agent_start", async (_event, ctx) => {
		const id = unlessStale(() => sessionIdOf(ctx));
		if (id === undefined) return;
		const state = getTaskState(id);
		if (!isFinished(state)) return;
		const cleared = resetTasks(state);
		pi.appendEntry(TASKS_SNAPSHOT_TYPE, snapshotOf(cleared));
		setTaskState(id, cleared);
		if (id === getForeground()) await refreshOverlaySafely();
	});

	// The reminder is persisted as a hidden message, so it reaches the next
	// model request and later turns can count back to it.
	pi.on("turn_end", (event, ctx) => {
		if (!settings.taskReminder || event.outcome !== "completed") return;
		if (!pi.getActiveTools().includes(TASK_CREATE)) return;
		const due = unlessStale(() => isReminderDue(ctx.sessionManager.getBranch()));
		if (!due) return;
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message" as const,
					customType: REMINDER_MESSAGE_TYPE,
					content: REMINDER_TEXT,
					display: false,
				},
			],
		};
	});

	// Evaluate the overlay module after startup while Pi's dependency paths are
	// stable. A failure is swallowed here; the loader lets the next update retry.
	const prewarmTimer = setTimeout(() => void loadOverlay().catch(() => undefined), PREWARM_DELAY_MS);
	prewarmTimer.unref?.();
}
