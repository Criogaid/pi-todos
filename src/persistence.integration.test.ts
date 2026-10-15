import { mkdtempSync, rmSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { JsonObject } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The same contract probes can exercise an installed host without changing dependencies.
const hostRoot =
	process.env.PI_TODOS_TEST_HOST_ROOT ??
	fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url));
const corePackage = findPackageJSON(
	"@earendil-works/pi-agent-core",
	pathToFileURL(join(resolve(hostRoot), "package.json")),
);
if (!corePackage) throw new Error("Selected host has no pi-agent-core package");
const hostUrl = (path: string) => pathToFileURL(join(hostRoot, path)).href;
// These typed boundaries deliberately require the selected host to implement the checked API.
const { SessionManager }: typeof import("@earendil-works/pi-coding-agent") = await import(hostUrl("dist/index.js"));
const {
	NESTED_CALL_LIMITS,
	NestedToolCallRunner,
}: typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/core/nested-tool-calls.js") = await import(
	hostUrl("dist/core/nested-tool-calls.js")
);
const {
	wrapToolDefinition,
}: typeof import("../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/tool-definition-wrapper.js") =
	await import(hostUrl("dist/core/tools/tool-definition-wrapper.js"));
const {
	runToolCall,
}: typeof import("../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js") =
	await import(pathToFileURL(join(dirname(corePackage), "dist/agent-loop.js")).href);

import {
	createMockCtx,
	createMockPi,
	makeAssistantMessage,
	makeToolResult,
	makeUserMessage,
} from "../test/helpers/index.js";
import registerExtension from "./index.js";
import { isRecord } from "./model.js";
import { TASKS_SNAPSHOT_TYPE } from "./persistence.js";
import { getTaskState } from "./store.js";

const directories: string[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setup() {
	const directory = mkdtempSync(join(tmpdir(), "pi-task-replay-"));
	directories.push(directory);
	let manager = SessionManager.create(process.cwd(), directory);
	manager.appendMessage(makeUserMessage("Track work"));
	const ctx = () => ({ ...createMockCtx(), sessionManager: manager });
	function register() {
		const registration = createMockPi({
			appendEntry: (type, data) => {
				manager.appendCustomEntry(type, data);
			},
		});
		registerExtension(registration.pi);
		return registration;
	}
	let registration = register();
	async function emit(name: string, event: unknown) {
		for (const handler of registration.captured.events.get(name) ?? []) await handler(event, ctx());
	}
	await emit("session_start", {});
	const tools = () =>
		Array.from(registration.captured.tools.values(), (definition) => wrapToolDefinition(definition, ctx));
	function run(
		call: Parameters<typeof runToolCall>[0],
		signal?: AbortSignal,
		onUpdate?: Parameters<typeof runToolCall>[1]["onUpdate"],
	) {
		const available = tools();
		return runToolCall(call, {
			tools: available,
			assistantMessage: makeAssistantMessage(),
			context: { messages: [], tools: available },
			signal,
			onUpdate,
		});
	}
	let nextCall = 0;
	async function call(name: string, args: JsonObject = {}) {
		const id = `direct-${++nextCall}`;
		manager.appendMessage(makeAssistantMessage([name]));
		const outcome = await run({ type: "toolCall", id, name, arguments: args });
		await emit("tool_execution_end", {
			toolName: name,
			toolCallId: id,
			result: outcome.result,
			isError: outcome.isError,
		});
		manager.appendMessage(
			makeToolResult({ toolName: name, toolCallId: id, isError: outcome.isError, details: outcome.result.details }),
		);
		return outcome;
	}
	async function nested(calls: readonly { name: string; args: unknown }[], concurrent = false, wrapperError = false) {
		const id = `wrapper-${++nextCall}`;
		manager.appendMessage(makeAssistantMessage(["codemode"]));
		const runner = new NestedToolCallRunner({
			getTools: tools,
			isSequential: () => false,
			emit: async (event) => {
				await emit(event.type, event);
			},
			runToolCall: (toolCall, _parent, signal, onUpdate) => run(toolCall, signal, onUpdate),
		});
		const outcomes = [];
		if (concurrent)
			outcomes.push(...(await Promise.all(calls.map(({ name, args }) => runner.execute(id, name, args)))));
		else for (const { name, args } of calls) outcomes.push(await runner.execute(id, name, args));
		const nestedCalls = runner.takeRecord(id)?.calls;
		manager.appendMessage(
			makeToolResult({ toolName: "codemode", toolCallId: id, isError: wrapperError, nestedCalls }),
		);
		return { outcomes, nestedCalls };
	}
	async function reload() {
		const file = manager.getSessionFile();
		if (!file) throw new Error("session not persisted");
		await emit("session_shutdown", {});
		manager = SessionManager.open(file, directory);
		registration = register();
		await emit("session_start", {});
		return state();
	}
	const state = () => getTaskState(manager.getSessionId());
	return {
		call,
		nested,
		reload,
		state,
		emit,
		manager: () => manager,
		snapshotCount: () =>
			manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === TASKS_SNAPSHOT_TYPE)
				.length,
	};
}
function createdId(outcome: Awaited<ReturnType<typeof runToolCall>>): string {
	expect(outcome.isError).toBe(false);
	const output = outcome.result.structuredContent;
	if (
		!isRecord(output) ||
		!Array.isArray(output.outcomes) ||
		!isRecord(output.outcomes[0]) ||
		typeof output.outcomes[0].id !== "string"
	)
		throw new Error("missing structured task id");
	return output.outcomes[0].id;
}
const createArgs = (subject: string, description = "Requirements") => ({
	operations: [{ action: "create", task: { subject, description } }],
});
const updateArgs = (id: string, set: JsonObject) => ({ operations: [{ action: "update", id, set }] });

describe("task persistence through the real Pi host", () => {
	it("runs direct atomic batches and reads through provider argument validation", async () => {
		const h = await setup();
		const id = createdId(await h.call("TaskWrite", createArgs("Build")));
		const result = await h.call("TaskWrite", {
			operations: [
				{ action: "update", id, set: { status: "completed", progress: "Verified" } },
				{ action: "create", task: { subject: "Next", description: "Requirements", status: "in_progress" } },
			],
		});
		expect(result.isError).toBe(false);
		const read = await h.call("TaskRead", { view: "details", ids: [id] });
		expect(read.result.structuredContent).toMatchObject({
			tasks: [{ id, status: "completed", progress: "Verified" }],
		});
		expect(h.snapshotCount()).toBe(2);
		const state = structuredClone(h.state());
		expect(await h.reload()).toEqual(state);
	});
	it("runs nested tools with structured results and restores snapshots when wrapper diagnostics omit arguments", async () => {
		const h = await setup();
		const description = "x".repeat(NESTED_CALL_LIMITS.maxArgumentBytesPerCall / 2);
		const args = {
			operations: [
				{
					action: "create",
					task: { subject: "Nested", description, metadata: { extra: "y".repeat(description.length) } },
				},
			],
		};
		const { outcomes, nestedCalls } = await h.nested([
			{ name: "TaskWrite", args },
			{ name: "TaskRead", args: {} },
		]);
		createdId(outcomes[0]);
		expect(nestedCalls?.calls[0]?.arguments).toBeUndefined();
		const before = structuredClone(h.state());
		expect(await h.reload()).toEqual(before);
	});
	it("preserves writes omitted from the bounded nested-call record", async () => {
		const h = await setup();
		const calls = Array.from({ length: NESTED_CALL_LIMITS.maxCalls + 1 }, (_, i) => ({
			name: "TaskWrite",
			args: createArgs(`Task ${i}`),
		}));
		const { outcomes, nestedCalls } = await h.nested(calls);
		expect(outcomes.every((outcome) => !outcome.isError)).toBe(true);
		expect(nestedCalls?.calls.length).toBeLessThan(outcomes.length);
		expect((await h.reload()).tasks).toHaveLength(calls.length);
	});
	it("serializes concurrent nested writes and retains a write when its wrapper fails", async () => {
		const h = await setup();
		const { outcomes } = await h.nested(
			["A", "B", "C"].map((subject) => ({ name: "TaskWrite", args: createArgs(subject) })),
			true,
			true,
		);
		expect(new Set(outcomes.map(createdId)).size).toBe(3);
		expect((await h.reload()).tasks).toHaveLength(3);
	});
	it("rejects numeric IDs, old names, unknown fields, and failed batches without snapshots", async () => {
		const h = await setup();
		await h.call("TaskWrite", createArgs("Saved"));
		const before = structuredClone(h.state());
		for (const [name, args] of [
			["TaskCreate", { subject: "Old", description: "Old" }],
			["TaskWrite", { operations: [{ action: "update", id: 1, set: {} }] }],
			["TaskWrite", { operations: [{ action: "update", id: "1", set: { addBlockedBy: [] } }] }],
			["TaskWrite", { operations: [...createArgs("Rolled back").operations, { action: "delete", id: "99" }] }],
		] satisfies [string, JsonObject][])
			expect((await h.call(name, args)).isError).toBe(true);
		await h.call("TaskRead");
		await h.call("TaskWrite", updateArgs("1", {}));
		expect(h.snapshotCount()).toBe(1);
		expect(await h.reload()).toEqual(before);
	});
	it("rejects non-JSON nested metadata arrays before saving and retains dense arrays after reopening", async () => {
		const h = await setup();
		await h.call("TaskWrite", createArgs("Saved"));
		const before = structuredClone(h.state());
		for (const values of [
			new Array<string>(2),
			Object.assign(["saved"], { extra: "lost" }),
			Object.assign(new Array<string>(1), { extra: "lost" }),
		]) {
			const { outcomes } = await h.nested([
				{
					name: "TaskWrite",
					args: {
						operations: [
							...createArgs("Rejected batch").operations,
							{ action: "update", id: "1", set: { metadata: { values } } },
						],
					},
				},
			]);
			expect(outcomes[0].isError).toBe(true);
			expect(h.state()).toEqual(before);
			expect(h.snapshotCount()).toBe(1);
		}
		const metadata = { values: [[], [null, null], ["saved", { nested: [] }]] };
		expect((await h.call("TaskWrite", updateArgs("1", { metadata }))).isError).toBe(false);
		expect((await h.reload()).tasks[0].metadata).toEqual(metadata);
	});
	it("cleans deleted dependencies and retains completed work across a new run", async () => {
		const h = await setup();
		await h.call("TaskWrite", createArgs("First"));
		await h.call("TaskWrite", createArgs("Second"));
		await h.call("TaskWrite", updateArgs("2", { dependsOn: ["1"] }));
		await h.call("TaskWrite", {
			operations: [
				{ action: "delete", id: "1" },
				{ action: "update", id: "2", set: { status: "completed" } },
			],
		});
		await h.emit("agent_start", {});
		const restored = await h.reload();
		expect(restored.tasks).toMatchObject([{ id: "2", status: "completed", dependsOn: [] }]);
		expect(createdId(await h.call("TaskWrite", createArgs("Third")))).toBe("3");
	});
	it("restores the selected branch and survives real compaction", async () => {
		const h = await setup();
		await h.call("TaskWrite", createArgs("First"));
		const firstLeaf = h.manager().getLeafId();
		if (!firstLeaf) throw new Error("missing branch point");
		await h.call("TaskWrite", createArgs("Abandoned"));
		h.manager().branch(firstLeaf);
		await h.emit("session_tree", {});
		expect(h.state().tasks.map((task) => task.subject)).toEqual(["First"]);
		await h.call("TaskWrite", createArgs("New branch"));
		const before = structuredClone(h.state());
		h.manager().appendCompaction("Summary", h.manager().getLeafId(), 100);
		await h.emit("session_compact", {});
		expect(await h.reload()).toEqual(before);
	});
	it("keeps disk snapshots isolated across sessions", async () => {
		const first = await setup();
		const second = await setup();
		await first.call("TaskWrite", createArgs("First session"));
		await second.call("TaskWrite", createArgs("Second session"));
		expect((await first.reload()).tasks[0].subject).toBe("First session");
		expect((await second.reload()).tasks[0].subject).toBe("Second session");
		expect(first.state().tasks[0].subject).toBe("First session");
	});
});

it("preserves status during progress updates and clears optional fields through host validation", async () => {
	const h = await setup();
	await h.call("TaskWrite", createArgs("Task"));
	await h.call("TaskWrite", updateArgs("1", { status: "in_progress", owner: "agent", metadata: { keep: null } }));
	await h.call("TaskWrite", updateArgs("1", { progress: "Checked", owner: null }));
	expect(h.state().tasks[0]).toMatchObject({ status: "in_progress", progress: "Checked", metadata: { keep: null } });
	expect(h.state().tasks[0]).not.toHaveProperty("owner");
});
