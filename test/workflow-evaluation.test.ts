import { expect, it } from "vitest";
import { buildTaskContext } from "../src/context.js";
import { LIMITS } from "../src/schema.js";
import { getTaskState } from "../src/store.js";
import { registerTaskTools } from "../src/tool.js";
import { createMockCtx, createMockPi } from "./helpers/index.js";

it("executes a planning and handoff scenario with bounded recurring context", async () => {
	const { pi, captured } = createMockPi();
	registerTaskTools(pi);
	const tool = captured.tools.get("TaskWrite");
	if (!tool?.prepareArguments) throw new Error("TaskWrite is missing");
	const ctx = createMockCtx();
	const operations = ["Reproduce", "Implement", "Verify", "Document", "Review"].map((subject, index) => ({
		action: "create",
		task: {
			subject,
			description: `${subject} the parser fix and preserve supported inputs`,
			status: index === 0 ? "in_progress" : "pending",
		},
	}));
	await tool.execute("plan", tool.prepareArguments({ operations }), undefined, undefined, ctx);
	const before = buildTaskContext(getTaskState("test-session"));
	const result = await tool.execute(
		"handoff",
		tool.prepareArguments({
			operations: [
				{ action: "update", id: "1", set: { status: "completed", progress: "Failing input captured" } },
				{
					action: "update",
					id: "2",
					set: {
						status: "in_progress",
						progress: "Patch the parser, then run regression tests",
						dependsOn: ["1"],
					},
				},
			],
		}),
		undefined,
		undefined,
		ctx,
	);
	const after = buildTaskContext(getTaskState("test-session"));
	expect(pi.appendEntry).toHaveBeenCalledTimes(2);
	expect(result.isError).toBe(false);
	expect(after).toContain("Patch the parser");
	expect(after?.length).toBeLessThanOrEqual(LIMITS.contextChars);
	if (process.env.PI_TODOS_REPORT_COST === "1") {
		const declarations = [...captured.tools.values()].map(
			({ name, description, promptSnippet, promptGuidelines, parameters }) => ({
				name,
				description,
				promptSnippet,
				promptGuidelines,
				parameters,
			}),
		);
		console.info(
			JSON.stringify({
				unit: "UTF-16 characters, not tokens or billed requests",
				toolDeclarationChars: JSON.stringify(declarations).length,
				initialContextChars: before?.length,
				handoffContextChars: after?.length,
				hundredUnchangedRequestsContextChars: (after?.length ?? 0) * 100,
				scriptedOperations: operations.length + 2,
				scriptedToolCalls: 2,
				snapshots: 2,
			}),
		);
	}
});
