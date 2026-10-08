import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts", "test/**/*.test.ts"],
		exclude: ["**/node_modules/**"],
		setupFiles: ["./test/setup.ts"],
		hookTimeout: 30_000,
		testTimeout: 15_000,
		unstubGlobals: true,
		clearMocks: true,
		restoreMocks: true,
	},
});
