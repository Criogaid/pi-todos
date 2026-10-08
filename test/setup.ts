import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";

const testHome = mkdtempSync(join(tmpdir(), "pi-todos-test-home-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.XDG_CONFIG_HOME;

beforeEach(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.XDG_CONFIG_HOME;
	// Import after setting the isolated home so config reads and test mocks use it.
	const store = await import("../src/store.js");
	store.__resetState();
	rmSync(join(testHome, ".config", "pi-todos", "config.json"), { force: true });
});

afterAll(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	rmSync(testHome, { recursive: true, force: true });
});
