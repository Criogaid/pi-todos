/**
 * pi-todos — registers the `todo` tool, the `/todos` command and the overlay,
 * and maps Pi lifecycle events onto them:
 *
 * - session start / compaction / tree navigation: replay the list from the
 *   branch and owe the model one resume summary;
 * - `context`: send that summary; a successful assistant message acknowledges it;
 * - a successful `todo` call: refresh the overlay;
 * - agent start: dismiss a finished list;
 * - shutdown: drop the session's state and, for the foreground, the overlay.
 */

import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { COLLAPSE_KEY_OFF, loadSettings } from "./config.js";
import { formatError, type SessionCtx, sessionIdOf, unlessStale } from "./host.js";
import type { TodoOverlay } from "./overlay.js";
import { isStaleOverlayModuleError, makeOverlayLoader, type OverlayImporter } from "./overlay-loader.js";
import { replayFromBranch } from "./persistence.js";
import { buildResumeContext, ResumeTracker } from "./resume.js";
import {
	clearForeground,
	evictSession,
	getForeground,
	getForegroundTodos,
	getTodos,
	setForeground,
	setTodos,
} from "./store.js";
import { registerTodosCommand, registerTodoTool, TOOL_NAME } from "./tool.js";

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
		if (!ui || (!overlay && getForegroundTodos().length === 0)) return;
		const { TodoOverlay } = await loadOverlay();
		if (generation !== uiGeneration || !ui) return;
		overlay ??= new TodoOverlay({ maxWidgetLines: settings.maxWidgetLines, collapseKey: settings.collapseKey });
		overlay.setUICtx(ui);
		overlay.update();
	}

	/** Replay a session's list from its branch. Returns its id, or undefined if the ctx is stale. */
	function restore(ctx: SessionCtx): string | undefined {
		return unlessStale(() => {
			const id = sessionIdOf(ctx);
			setTodos(id, replayFromBranch(ctx.sessionManager.getBranch()));
			if (settings.resumeContext) resume.mark(id);
			return id;
		});
	}

	registerTodoTool(pi, settings.guidance);
	registerTodosCommand(pi);

	if (settings.collapseKey !== COLLAPSE_KEY_OFF) {
		pi.registerShortcut(settings.collapseKey as KeyId, {
			description: "Collapse or expand the todo overlay",
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
		const content = buildResumeContext(getTodos(id));
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
		if (event.toolName !== TOOL_NAME || event.isError) return;
		try {
			await refreshOverlay();
		} catch (error) {
			// The tool call itself succeeded; a transient load failure only costs
			// this refresh. The latched stale-module error needs a restart, so surface it.
			if (isStaleOverlayModuleError(error)) throw error;
			console.warn(`[pi-todos] overlay refresh failed (will retry on next update): ${formatError(error)}`);
		}
	});

	pi.on("agent_start", (_event, ctx) => {
		if (unlessStale(() => sessionIdOf(ctx)) === getForeground()) overlay?.dismissIfFinished();
	});

	// Evaluate the overlay module after startup while Pi's dependency paths are
	// stable. A failure is swallowed here; the loader lets the next update retry.
	const prewarmTimer = setTimeout(() => void loadOverlay().catch(() => undefined), PREWARM_DELAY_MS);
	prewarmTimer.unref?.();
}
