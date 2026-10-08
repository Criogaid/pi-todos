import { describe, expect, it } from "vitest";
import { verifyShipManifest } from "./helpers/index.js";

describe("publish manifest", () => {
	it("ships every production module without stale manifest paths", () => {
		expect(verifyShipManifest(new URL("../package.json", import.meta.url).href)).toMatchObject({
			missing: [],
			stale: [],
		});
	});
});
