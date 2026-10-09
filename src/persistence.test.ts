import type { JsonObject } from "@earendil-works/pi-ai";
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
	it("replays snapshots from successful nestedCalls within wrapper tools such as codemode", () => {
		const directInitial = [{ content: "Direct initial", status: "in_progress" }];
		const nestedSuccess = [{ content: "Nested done", status: "completed" }];
		const laterDirect = [{ content: "Later direct", status: "pending" }];

		const branchWithNested = [
			entry({ todos: directInitial }),
			makeMessageEntry({
				role: "toolResult",
				toolCallId: "call_codemode",
				toolName: "codemode",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: Date.now(),
				nestedCalls: {
					complete: true,
					calls: [
						{ id: "call_1", name: "bash", status: "ok", arguments: { command: "ls" } },
						{ id: "call_2", name: "todo", status: "ok", arguments: { todos: nestedSuccess } },
					],
				},
			}),
		];
		expect(replayFromBranch(branchWithNested)).toEqual(nestedSuccess);

		// Later direct call overrides previous nested call
		expect(replayFromBranch([...branchWithNested, entry({ todos: laterDirect })])).toEqual(laterDirect);
	});

	it("ignores failed or malformed nestedCalls", () => {
		const valid = [{ content: "Valid", status: "completed" }];
		const branch = [
			entry({ todos: valid }),
			makeMessageEntry({
				role: "toolResult",
				toolCallId: "call_codemode",
				toolName: "codemode",
				content: [],
				isError: false,
				timestamp: Date.now(),
				nestedCalls: {
					complete: true,
					calls: [
						{ id: "call_1", name: "todo", status: "error", arguments: { todos: [] } },
						{ id: "call_2", name: "todo", status: "ok", arguments: { todos: "not an array" } },
						{ id: "call_3", name: "other", status: "ok", arguments: { todos: [] } },
					],
				},
			}),
		];
		expect(replayFromBranch(branch)).toEqual(valid);
	});

	it("handles stringified arguments in nestedCalls gracefully", () => {
		const nestedSuccess = [{ content: "Stringified args", status: "completed" }];
		const branch = [
			makeMessageEntry({
				role: "toolResult",
				toolCallId: "call_codemode",
				toolName: "codemode",
				content: [],
				isError: false,
				timestamp: Date.now(),
				nestedCalls: {
					complete: true,
					calls: [
						{
							id: "call_1",
							name: "todo",
							status: "ok",
							arguments: JSON.stringify({ todos: nestedSuccess }) as unknown as JsonObject,
						},
					],
				},
			}),
		];
		expect(replayFromBranch(branch)).toEqual(nestedSuccess);
	});
});
