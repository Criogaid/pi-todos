import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { TASK_TOOL_NAMES, type TaskToolName } from "./names.js";

/** Prompt-copy overrides for one task tool. */
export interface GuidanceFields {
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
}

/** Overrides keyed by tool name; a tool without an entry keeps its built-in copy. */
export type Guidance = Partial<Record<TaskToolName, GuidanceFields>>;

/**
 * Settings are read once, when Pi loads the extension. `/reload` re-runs the
 * extension factory, which is the single way to apply a config change — so the
 * bound shortcut, the hint that names it and the row budget never disagree.
 */
export interface TaskSettings {
	guidance: Guidance;
	/** Inject one bounded unfinished-task summary after restore or compaction. */
	resumeContext: boolean;
	/** Remind the model about the task tools after 10 turns without a TaskCreate or TaskUpdate call. */
	taskReminder: boolean;
	/** Overlay content-row budget, heading included. */
	maxWidgetLines: number;
	/** Validated, lowercased collapse key, or `COLLAPSE_KEY_OFF`. */
	collapseKey: string;
}

export const DEFAULT_MAX_WIDGET_LINES = 12;
export const MIN_WIDGET_LINES = 3;
export const DEFAULT_COLLAPSE_KEY = "ctrl+shift+t";
/** Sentinel `collapseKey` value that registers no shortcut. */
export const COLLAPSE_KEY_OFF = "off";

/**
 * `$XDG_CONFIG_HOME` when it is an absolute path (a leading `~` is expanded),
 * otherwise `~/.config`.
 */
function configHome(env: NodeJS.ProcessEnv): string {
	const fallback = join(homedir(), ".config");
	const raw = env.XDG_CONFIG_HOME?.trim();
	if (!raw) return fallback;
	const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
	return isAbsolute(expanded) ? expanded : fallback;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(configHome(env), "pi-todos", "config.json");
}

/** A missing file yields `{}`; a malformed one warns and yields `{}`. */
function readConfig(): Record<string, unknown> {
	const path = configPath();
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch (error) {
		console.warn(`[pi-todos] invalid config at ${path}, using defaults: ${(error as Error).message}`);
		return {};
	}
}

export function loadSettings(): TaskSettings {
	const raw = readConfig();
	return {
		guidance: resolveGuidance(raw.guidance),
		resumeContext: raw.resumeContext !== false,
		taskReminder: raw.taskReminder !== false,
		maxWidgetLines: resolveMaxWidgetLines(raw.maxWidgetLines),
		collapseKey: resolveCollapseKey(raw.collapseKey),
	};
}

/** Resolve each tool's overrides; unknown tool names are ignored. */
export function resolveGuidance(value: unknown): Guidance {
	if (value === null || typeof value !== "object") return {};
	const raw = value as Record<string, unknown>;
	const guidance: Guidance = {};
	for (const name of TASK_TOOL_NAMES) {
		const fields = resolveGuidanceFields(raw[name]);
		if (Object.keys(fields).length > 0) guidance[name] = fields;
	}
	return guidance;
}

/** Keep only valid overrides: non-empty strings and a non-empty array of non-empty strings. */
export function resolveGuidanceFields(value: unknown): GuidanceFields {
	if (value === null || typeof value !== "object") return {};
	const raw = value as Record<string, unknown>;
	const guidance: GuidanceFields = {};
	if (typeof raw.description === "string" && raw.description) guidance.description = raw.description;
	if (typeof raw.promptSnippet === "string" && raw.promptSnippet) guidance.promptSnippet = raw.promptSnippet;
	const lines = raw.promptGuidelines;
	if (Array.isArray(lines) && lines.length > 0 && lines.every((line) => typeof line === "string" && line)) {
		guidance.promptGuidelines = [...lines];
	}
	return guidance;
}

/** A non-integer or a value below the floor falls back to the default; no ceiling. */
export function resolveMaxWidgetLines(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= MIN_WIDGET_LINES
		? value
		: DEFAULT_MAX_WIDGET_LINES;
}

// Named keys accepted by pi-tui's `matchesKey`. parseKeyId lowercases the id
// before matching, so lowercase spellings are canonical.
const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

/**
 * Validate a key spec against pi-tui's KeyId grammar strictly: distinct
 * modifiers, then one printable character or a named key. pi-tui takes the
 * last `+`-part as the key and ignores unknown parts, so a loose check would
 * let a typo like `ctr+]` capture every bare `]` keypress.
 */
export function isValidCollapseKeySpec(spec: string): boolean {
	if (!spec) return false;
	if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	const parts = spec.split("+");
	const base = parts[parts.length - 1] ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size) return false;
	if (!modifiers.every((m) => MODIFIERS.has(m))) return false;
	return base.length === 1 ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base) : SPECIAL_KEYS.has(base);
}

/** Missing, blank, non-string or invalid values fall back to the default. */
export function resolveCollapseKey(value: unknown): string {
	const spec = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (spec === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidCollapseKeySpec(spec) ? spec : DEFAULT_COLLAPSE_KEY;
}
