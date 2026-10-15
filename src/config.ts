import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { TASK_READ, TASK_WRITE } from "./names.js";
import { TaskError, validate } from "./schema.js";

const GuidanceFieldsSchema = Type.Object(
	{
		description: Type.Optional(Type.String({ minLength: 1 })),
		promptSnippet: Type.Optional(Type.String({ minLength: 1 })),
		promptGuidelines: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	},
	{ additionalProperties: false },
);
export type GuidanceFields = Static<typeof GuidanceFieldsSchema>;
const GuidanceSchema = Type.Object(
	{
		[TASK_READ]: Type.Optional(GuidanceFieldsSchema),
		[TASK_WRITE]: Type.Optional(GuidanceFieldsSchema),
	},
	{ additionalProperties: false },
);
export type Guidance = Static<typeof GuidanceSchema>;

export const DEFAULT_MAX_WIDGET_LINES = 12;
export const MIN_WIDGET_LINES = 3;
export const DEFAULT_COLLAPSE_KEY = "ctrl+shift+t";
/** Sentinel `collapseKey` value that registers no shortcut. */
export const COLLAPSE_KEY_OFF = "off";

const SettingsSchema = Type.Object(
	{
		guidance: { ...GuidanceSchema, default: {} },
		taskContext: Type.Boolean({ default: true }),
		maxWidgetLines: Type.Integer({ minimum: MIN_WIDGET_LINES, default: DEFAULT_MAX_WIDGET_LINES }),
		collapseKey: Type.String({ default: DEFAULT_COLLAPSE_KEY }),
	},
	{ additionalProperties: false },
);
export type TaskSettings = Static<typeof SettingsSchema>;

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

/** Missing configuration uses defaults; invalid configuration prevents loading. */
export function loadSettings(): TaskSettings {
	const path = configPath();
	let raw: unknown = {};
	if (existsSync(path)) {
		try {
			raw = JSON.parse(readFileSync(path, "utf-8"));
		} catch (error) {
			throw new Error(`config: cannot read valid JSON at ${path}`, { cause: error });
		}
	}
	validate(Type.Partial(SettingsSchema), raw, "config");
	const settings = validate(SettingsSchema, Value.Default(SettingsSchema, structuredClone(raw)), "config");
	if (settings.collapseKey !== COLLAPSE_KEY_OFF && !isValidCollapseKeySpec(settings.collapseKey))
		throw new TaskError("invalid_input", "config.collapseKey", "must be a lowercase Pi key specification or off");
	return settings;
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
