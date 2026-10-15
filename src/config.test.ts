import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configPath, isValidCollapseKeySpec, loadSettings } from "./config.js";

function writeConfig(value: unknown) {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
	return path;
}
describe("strict configuration", () => {
	it("uses defaults only when a file or supported field is absent", () => {
		const initial = loadSettings();
		writeConfig({ taskContext: false, collapseKey: "off", guidance: { TaskWrite: { promptGuidelines: [] } } });
		expect(loadSettings()).toEqual({
			...initial,
			taskContext: false,
			collapseKey: "off",
			guidance: { TaskWrite: { promptGuidelines: [] } },
		});
	});
	it.each([
		{ resumeContext: false },
		{ taskReminder: false },
		{ guidance: { TaskCreate: {} } },
		{ taskContext: "false" },
		{ maxWidgetLines: 2 },
		{ maxWidgetLines: 3.5 },
		{ collapseKey: "ctr+]" },
		{ collapseKey: " ALT+O " },
		{ unknown: true },
		{ guidance: { TaskRead: { unknown: "x" } } },
		{ guidance: { TaskWrite: { description: "" } } },
		null,
		[],
		42,
		"{broken",
	])("rejects invalid config without rewriting it: %j", (value) => {
		const path = writeConfig(value);
		const before = readFileSync(path, "utf8");
		expect(() => loadSettings()).toThrow();
		expect(readFileSync(path, "utf8")).toBe(before);
	});
	it("names removed fields in the error", () => {
		writeConfig({ resumeContext: true });
		expect(() => loadSettings()).toThrow(/resumeContext/);
	});
	it("uses a valid XDG directory exclusively", () => {
		writeConfig({ taskContext: false });
		vi.stubEnv("XDG_CONFIG_HOME", join(homedir(), "isolated-xdg"));
		try {
			expect(loadSettings().taskContext).toBe(true);
		} finally {
			vi.unstubAllEnvs();
		}
	});
	it("resolves absolute, expanded, and invalid XDG paths", () => {
		expect(configPath({ XDG_CONFIG_HOME: "~/custom" })).toBe(join(homedir(), "custom", "pi-todos", "config.json"));
		expect(configPath({ XDG_CONFIG_HOME: "relative" })).toBe(join(homedir(), ".config", "pi-todos", "config.json"));
	});
	it.each(["ctrl+shift+t", "alt+o", "escape", "f12", "ctrl+]", "super+alt+enter"])("accepts key %s", (key) =>
		expect(isValidCollapseKeySpec(key)).toBe(true),
	);
	it.each(["", "+", "ctrl+", "ctrl++t", "win+t", "ctrl+ctrl+t", "ctr+t", "f13"])("rejects key %s", (key) =>
		expect(isValidCollapseKeySpec(key)).toBe(false),
	);
});
