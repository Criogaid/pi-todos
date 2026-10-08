/**
 * Adapters for Pi host behavior that the domain code should not know about.
 *
 * After a session is replaced or reloaded, pi-core invalidates the old
 * context proxy while it may still emit lifecycle events through it; any
 * getter then throws. Those errors mean "this session is gone" and are safe to
 * ignore. Everything else is a real bug and must propagate.
 */

export interface SessionCtx {
	sessionManager: { getSessionId(): string; getBranch(): Iterable<unknown> };
}

/** Matches pi-core's ExtensionRunner message for an invalidated ctx proxy. */
const STALE_CTX_PATTERN = /stale after session replacement/;

export function isStaleCtxError(error: unknown): boolean {
	return STALE_CTX_PATTERN.test(String(error));
}

/** Run `read`, returning `undefined` if the host context has gone stale. */
export function unlessStale<T>(read: () => T): T | undefined {
	try {
		return read();
	} catch (error) {
		if (isStaleCtxError(error)) return undefined;
		throw error;
	}
}

export function sessionIdOf(ctx: { sessionManager: { getSessionId(): string } }): string {
	return ctx.sessionManager.getSessionId() ?? "";
}

export function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
