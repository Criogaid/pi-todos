import { describe, expect, it, vi } from "vitest";
import * as overlayModule from "./overlay.js";
import { isStaleOverlayModuleError, makeOverlayLoader } from "./overlay-loader.js";

describe("overlay loader", () => {
	it("shares concurrent imports and reuses the successful module", async () => {
		let resolve!: (module: typeof overlayModule) => void;
		const importer = vi.fn(
			() =>
				new Promise<typeof overlayModule>((accept) => {
					resolve = accept;
				}),
		);
		const load = makeOverlayLoader(importer);
		const first = load();
		const second = load();
		resolve(overlayModule);
		expect(await first).toBe(overlayModule);
		expect(await second).toBe(overlayModule);
		expect(await load()).toBe(overlayModule);
		expect(importer).toHaveBeenCalledTimes(1);
	});

	it("lets all callers retry after a shared transient rejection", async () => {
		let reject!: (error: Error) => void;
		const importer = vi
			.fn<() => Promise<typeof overlayModule>>()
			.mockImplementationOnce(
				() =>
					new Promise((_resolve, fail) => {
						reject = fail;
					}),
			)
			.mockResolvedValue(overlayModule);
		const load = makeOverlayLoader(importer);
		const failed = Promise.allSettled([load(), load()]);
		reject(new Error("transient import failure"));
		expect((await failed).map((result) => result.status)).toEqual(["rejected", "rejected"]);
		expect(await Promise.all([load(), load()])).toEqual([overlayModule, overlayModule]);
		expect(importer).toHaveBeenCalledTimes(2);
	});

	it("latches an invalid cached namespace and reports restart guidance", async () => {
		// Simulate jiti resolving a namespace that violates the TypeScript import contract.
		const importer = vi.fn(async () => ({ TodoOverlay: undefined }) as unknown as typeof overlayModule);
		const load = makeOverlayLoader(importer);
		const first = await load().catch((error: unknown) => error);
		expect(isStaleOverlayModuleError(first)).toBe(true);
		await expect(load()).rejects.toThrow(/restart Pi/);
		expect(importer).toHaveBeenCalledTimes(1);
		expect(isStaleOverlayModuleError(new Error("network failure"))).toBe(false);
	});
});
