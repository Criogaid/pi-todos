import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as config from "./config.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function writeConfig(path: string, contents: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
}

function configPaths() {
	const xdg = mkdtempSync(join(tmpdir(), "pi-todos-config-"));
	temporaryDirectories.push(xdg);
	vi.stubEnv("XDG_CONFIG_HOME", xdg);
	return {
		xdg: join(xdg, "pi-todos", "config.json"),
		home: join(homedir(), ".config", "pi-todos", "config.json"),
	};
}

describe("config file selection", () => {
	it("uses the trimmed absolute XDG directory for configPath", () => {
		const xdg = join(tmpdir(), "pi-todos-path-test");
		expect(config.configPath({ XDG_CONFIG_HOME: `  ${xdg}  ` })).toBe(join(xdg, "pi-todos", "config.json"));
	});

	it.each([
		["~", homedir()],
		["~/x", join(homedir(), "x")],
	])("expands %s in configPath", (value, directory) => {
		expect(config.configPath({ XDG_CONFIG_HOME: value })).toBe(join(directory, "pi-todos", "config.json"));
	});

	it.each([undefined, "", " \t ", "relative/path", "~user"])(
		"uses the home config path for an invalid XDG value: %j",
		(value) => {
			expect(config.configPath({ XDG_CONFIG_HOME: value })).toBe(
				join(homedir(), ".config", "pi-todos", "config.json"),
			);
		},
	);

	it("does not fall back to home config when the valid XDG config file is missing", () => {
		const { xdg, home } = configPaths();
		const defaults = config.loadSettings();
		writeConfig(home, { maxWidgetLines: 50 });
		expect(config.configPath()).toBe(xdg);
		expect(config.loadSettings()).toEqual(defaults);
	});

	it("reads the XDG config when a home config also exists", () => {
		const { xdg, home } = configPaths();
		writeConfig(xdg, { maxWidgetLines: 20 });
		writeConfig(home, { maxWidgetLines: 50 });
		expect(config.loadSettings().maxWidgetLines).toBe(20);
	});

	it("warns and stops at a malformed selected file instead of falling through", () => {
		const { xdg, home } = configPaths();
		writeConfig(xdg, "{broken");
		writeConfig(home, { maxWidgetLines: 50 });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(config.loadSettings().maxWidgetLines).toBe(config.DEFAULT_MAX_WIDGET_LINES);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(xdg));
	});

	it("uses defaults when absent or when the selected JSON value is not an object", () => {
		expect(config.loadSettings()).toMatchObject({
			guidance: {},
			resumeContext: true,
			collapseKey: config.DEFAULT_COLLAPSE_KEY,
			maxWidgetLines: config.DEFAULT_MAX_WIDGET_LINES,
		});
		const { xdg: path } = configPaths();
		for (const value of ["null", "[]", "42"]) {
			writeConfig(path, value);
			expect(config.loadSettings().guidance).toEqual({});
		}
	});

	it("resolves settings from the selected file and reads changes on reload", () => {
		const { xdg: path } = configPaths();
		writeConfig(path, {
			resumeContext: false,
			maxWidgetLines: 5,
			collapseKey: " Alt+O ",
			guidance: { description: "Track work" },
		});
		expect(config.loadSettings()).toEqual({
			resumeContext: false,
			maxWidgetLines: 5,
			collapseKey: "alt+o",
			guidance: { description: "Track work" },
		});
		writeConfig(path, { resumeContext: true, collapseKey: "off" });
		expect(config.loadSettings()).toMatchObject({ resumeContext: true, collapseKey: "off" });
	});

	it.each(["relative/path", ""])("uses the home config directory for an invalid XDG value: %j", (value) => {
		vi.stubEnv("XDG_CONFIG_HOME", value);
		writeConfig(join(homedir(), ".config", "pi-todos", "config.json"), { maxWidgetLines: 7 });
		expect(config.loadSettings().maxWidgetLines).toBe(7);
	});
});

describe("setting resolvers", () => {
	it("keeps valid guidance overrides and drops malformed fields independently", () => {
		const value = { description: "Custom", promptSnippet: 42, promptGuidelines: ["One", "Two"] };
		const resolved = config.resolveGuidance(value);
		expect(resolved).toEqual({ description: "Custom", promptGuidelines: ["One", "Two"] });
		value.promptGuidelines.push("Later");
		expect(resolved.promptGuidelines).toEqual(["One", "Two"]);
		for (const input of [undefined, null, [], "x", { description: "", promptGuidelines: ["", "ok"] }]) {
			expect(config.resolveGuidance(input)).toEqual({});
		}
	});

	it.each([undefined, null, "12", 2, 0, -1, 3.5, NaN, Infinity])(
		"falls back for an invalid row budget: %j",
		(value) => {
			expect(config.resolveMaxWidgetLines(value)).toBe(config.DEFAULT_MAX_WIDGET_LINES);
		},
	);

	it.each([3, 8, 50])("accepts a whole row budget at or above the minimum: %i", (value) => {
		expect(config.resolveMaxWidgetLines(value)).toBe(value);
	});

	it.each(["ctrl+shift+t", "alt+o", "escape", "f12", "ctrl+]", "super+alt+enter"])("accepts key spec %s", (spec) => {
		expect(config.isValidCollapseKeySpec(spec)).toBe(true);
	});

	it.each(["", "+", "+t", "ctrl+", "ctrl++t", "win+t", "ctrl+ctrl+t", "ctr+t", "f13"])(
		"rejects key spec %j",
		(spec) => {
			expect(config.isValidCollapseKeySpec(spec)).toBe(false);
			expect(config.resolveCollapseKey(spec)).toBe(config.DEFAULT_COLLAPSE_KEY);
		},
	);

	it("normalizes valid keys and supports disabling the shortcut", () => {
		expect(config.resolveCollapseKey(" Alt+O ")).toBe("alt+o");
		expect(config.resolveCollapseKey(" OFF ")).toBe(config.COLLAPSE_KEY_OFF);
		for (const value of [undefined, null, 42, {}, []])
			expect(config.resolveCollapseKey(value)).toBe(config.DEFAULT_COLLAPSE_KEY);
	});
});
