import { describe, expect, it } from "vitest";
import { formatError, isStaleCtxError, sessionIdOf, unlessStale } from "./host.js";

describe("host boundary", () => {
	it("ignores only stale-context errors and propagates other failures", () => {
		const stale = new Error("Extension context is stale after session replacement");
		expect(isStaleCtxError(stale)).toBe(true);
		expect(
			unlessStale(() => {
				throw stale;
			}),
		).toBeUndefined();
		const failure = new Error("session unavailable");
		expect(isStaleCtxError(failure)).toBe(false);
		expect(() =>
			unlessStale(() => {
				throw failure;
			}),
		).toThrow(failure);
		expect(unlessStale(() => "session")).toBe("session");
	});

	it("reads session identity and formats thrown values", () => {
		expect(sessionIdOf({ sessionManager: { getSessionId: () => "child" } })).toBe("child");
		expect(formatError(new Error("Failed"))).toBe("Failed");
		expect(formatError("Cancelled")).toBe("Cancelled");
	});
});
