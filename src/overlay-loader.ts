/**
 * Lazy loader for the overlay module, hardened against two Pi/jiti behaviors:
 *
 * - a rejected dynamic import would otherwise stay memoized for the process
 *   lifetime, so a rejected promise is dropped and the next call retries;
 * - after dependency churn jiti can resolve a "poisoned" namespace without the
 *   expected export. Re-importing returns the same cached namespace, so that
 *   failure is latched and reported with restart guidance instead.
 */

type OverlayModule = typeof import("./overlay.js");
export type OverlayImporter = () => Promise<OverlayModule>;

const STALE_OVERLAY_MESSAGE = "Todo overlay module cache is stale; restart Pi";

export function isStaleOverlayModuleError(error: unknown): boolean {
	return String(error).includes(STALE_OVERLAY_MESSAGE);
}

export function makeOverlayLoader(importOverlay: OverlayImporter = () => import("./overlay.js")): OverlayImporter {
	let memo: Promise<OverlayModule> | undefined;
	return async () => {
		memo ??= importOverlay();
		const current = memo;
		let mod: OverlayModule;
		try {
			mod = await current;
		} catch (error) {
			// Clear only our own rejection; a concurrent caller may already have installed a retry.
			if (memo === current) memo = undefined;
			throw error;
		}
		if (typeof mod.TodoOverlay !== "function") {
			throw new Error(`${STALE_OVERLAY_MESSAGE} (resolved namespace keys: ${JSON.stringify(Object.keys(mod))})`);
		}
		return mod;
	};
}
