import { describe, expect, it } from "vitest";
import { makeMessageEntry, makeToolResult, makeUserMessage } from "../test/helpers/index.js";
import { decodeSnapshot, replayFromBranch } from "./persistence.js";

const todos = [{ content: "Run tests", status: "in_progress", activeForm: "Running tests" }];

function entry(details: unknown, toolName = "todo", isError = false) {
	return makeMessageEntry(makeToolResult({ toolName, details, isError }));
}

describe("decodeSnapshot", () => {
	it("decodes snapshots including clear, preserving activeForm", () => {
		expect(decodeSnapshot({ todos })).toEqual(todos);
		expect(decodeSnapshot({ todos: [] })).toEqual([]);
	});

	it.each([
		undefined,
		null,
		[],
		{},
		{ todos: "[]" },
		{ todos: [null] },
		{ todos: [...todos, { content: "", status: "pending" }] },
		{ todos: [{ content: "Task", status: "unknown" }] },
		{ todos: [{ content: "Task", status: "pending", activeForm: 1 }] },
	])("rejects an entire malformed snapshot: %j", (details) => {
		expect(decodeSnapshot(details)).toBeUndefined();
	});

	it("skips tool results marked isError even when their snapshots are decodable", () => {
		expect(replayFromBranch([entry({ todos }, "todo", true)])).toEqual([]);
		expect(replayFromBranch([entry({ todos }), entry({ todos: [] }, "todo", true)])).toEqual(todos);
	});

	it("returns detached records so render or replay consumers cannot mutate saved details", () => {
		const details = structuredClone({ todos });
		const decoded = decodeSnapshot(details);
		if (!decoded) throw new Error("snapshot not decoded");
		decoded[0].content = "Changed";
		expect(details.todos).toEqual(todos);
	});
});

describe("replayFromBranch", () => {
	it("accepts an iterable and selects the last valid successful snapshot", () => {
		const initial = { todos: [{ content: "Initial", status: "pending" }] };
		const branch = [
			entry(initial),
			makeMessageEntry(makeUserMessage("Continue")),
			entry({ todos }),
			entry({ todos: [] }, "other"),
			entry({ todos: [] }, "todo", true),
			entry({ todos: [{ content: "Broken", status: "unknown" }] }),
			{ type: "custom", message: { role: "toolResult", toolName: "todo", details: { todos: [] } } },
			null,
		];
		function* entries() {
			yield* branch;
		}
		expect(replayFromBranch(entries())).toEqual(todos);
	});

	it("ignores other tools' results even when their snapshots are decodable", () => {
		expect(replayFromBranch([entry({ todos }, "other")])).toEqual([]);
		expect(replayFromBranch([entry({ todos }), entry({ todos: [] }, "other")])).toEqual(todos);
	});

	it("keeps a valid snapshot when a later result contains a malformed item", () => {
		expect(replayFromBranch([entry({ todos }), entry({ todos: [...todos, null] })])).toEqual(todos);
	});

	it("clears on a valid empty snapshot and does not retain state from another replay", () => {
		expect(replayFromBranch([entry({ todos }), entry({ todos: [] })])).toEqual([]);
		expect(replayFromBranch([])).toEqual([]);
	});
});
