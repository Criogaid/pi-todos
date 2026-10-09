import { type JsonObject, type Tool, validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type MouseRegion, type TUI, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	createMockCtx,
	createMockPi,
	createMockUI,
	makeMessageEntry,
	makeTheme,
	makeToolResult,
	makeUserMessage,
} from "../test/helpers/index.js";
import type { Todo } from "./model.js";
import { TodoOverlay } from "./overlay.js";
import { replayFromBranch } from "./persistence.js";
import { setForeground, setTodos } from "./store.js";
import { registerTodoTool } from "./tool.js";

/** Cartesian product generator for N orthogonal arrays. */
function cartesian<T extends readonly (readonly unknown[])[]>(
	...dimensions: T
): { [K in keyof T]: T[K] extends readonly (infer U)[] ? U : never }[] {
	return dimensions.reduce(
		(acc: unknown[][], curr: readonly unknown[]) => acc.flatMap((prev) => curr.map((item) => [...prev, item])),
		[[]],
	) as unknown as { [K in keyof T]: T[K] extends readonly (infer U)[] ? U : never }[];
}

const pendingTodo = (content: string): Todo => ({ content, status: "pending" });
const completedTodo = (content: string): Todo => ({ content, status: "completed" });

/* -------------------------------------------------------------------------------------------------
 * 矩阵一：replayFromBranch 笛卡尔积容灾测试 (180 种场景)
 * -----------------------------------------------------------------------------------------------*/
describe("replayFromBranch combinatorial matrix", () => {
	const sources = ["direct", "nested-object", "nested-string", "foreign"] as const;
	const statuses = ["ok", "error", "unfinished"] as const;
	const payloads = ["valid", "empty", "corrupt-type", "corrupt-items", "corrupt-status"] as const;
	const contexts = ["lone", "preceded-by-valid", "followed-by-valid"] as const;

	const matrix = cartesian(sources, statuses, payloads, contexts);

	it.each(matrix)("source: %s, status: %s, payload: %s, context: %s", (source, status, payloadKind, context) => {
		const validPayload = [completedTodo("Candidate Todo")];
		const baselinePayload = [pendingTodo("Baseline Work")];
		const latestPayload = [completedTodo("Latest Work")];

		let rawPayload: unknown;
		if (payloadKind === "valid") rawPayload = validPayload;
		else if (payloadKind === "empty") rawPayload = [];
		else if (payloadKind === "corrupt-type") rawPayload = "not-an-array";
		else if (payloadKind === "corrupt-items") rawPayload = [{ content: "", status: "pending" }];
		else if (payloadKind === "corrupt-status") rawPayload = [{ content: "X", status: "invalid_status" }];

		// Construct candidate message entry
		let candidateEntry: unknown;
		const isError = status !== "ok";

		if (source === "direct") {
			candidateEntry = makeMessageEntry(
				makeToolResult({
					toolName: "todo",
					details: { todos: rawPayload },
					isError,
				}),
			);
		} else if (source === "nested-object" || source === "nested-string") {
			const args = source === "nested-string" ? JSON.stringify({ todos: rawPayload }) : { todos: rawPayload };
			candidateEntry = makeMessageEntry({
				role: "toolResult",
				toolCallId: "call_wrapper",
				toolName: "codemode",
				content: [],
				isError: false,
				timestamp: Date.now(),
				nestedCalls: {
					complete: true,
					calls: [
						{
							id: "sub_1",
							name: "todo",
							status,
							arguments: args as unknown as JsonObject,
						},
					],
				},
			});
		} else {
			// foreign tool
			candidateEntry = makeMessageEntry(
				makeToolResult({
					toolName: "bash",
					details: { todos: rawPayload },
					isError,
				}),
			);
		}

		// Assemble branch
		const branch: unknown[] = [];
		if (context === "preceded-by-valid") {
			branch.push(
				makeMessageEntry(
					makeToolResult({
						toolName: "todo",
						details: { todos: baselinePayload },
						isError: false,
					}),
				),
			);
		}

		branch.push(candidateEntry);
		branch.push(makeMessageEntry(makeUserMessage("ping")));

		if (context === "followed-by-valid") {
			branch.push(
				makeMessageEntry(
					makeToolResult({
						toolName: "todo",
						details: { todos: latestPayload },
						isError: false,
					}),
				),
			);
		}

		const result = replayFromBranch(branch);

		// Invariant assertions
		const candidateEffective =
			source !== "foreign" && status === "ok" && (payloadKind === "valid" || payloadKind === "empty");

		if (context === "followed-by-valid") {
			expect(result).toEqual(latestPayload);
		} else if (candidateEffective) {
			expect(result).toEqual(payloadKind === "valid" ? validPayload : []);
		} else if (context === "preceded-by-valid") {
			// Invariant: Failed, malformed or foreign entries MUST NOT pollute baseline state
			expect(result).toEqual(baselinePayload);
		} else {
			expect(result).toEqual([]);
		}
	});
});

/* -------------------------------------------------------------------------------------------------
 * 矩阵二：TodoOverlay 渲染与视口滚动笛卡尔积测试 (216 种场景)
 * -----------------------------------------------------------------------------------------------*/
describe("TodoOverlay rendering and scrolling combinatorial matrix", () => {
	const listKinds = ["empty", "small", "exact", "overflow", "all-completed", "all-pending"] as const;
	const scrollDeltas = [0, 5, 999, -50] as const;
	const uiModes = ["normal", "collapsed", "expanded"] as const;
	const widths = [12, 80, 200] as const;

	const matrix = cartesian(listKinds, scrollDeltas, uiModes, widths);

	it.each(matrix)("list: %s, scrollDelta: %s, uiMode: %s, width: %s", (listKind, scrollDelta, uiMode, width) => {
		let todos: Todo[];
		if (listKind === "empty") todos = [];
		else if (listKind === "small") todos = [pendingTodo("Task 1"), completedTodo("Task 2")];
		else if (listKind === "exact") todos = Array.from({ length: 11 }, (_, i) => pendingTodo(`Task ${i}`));
		else if (listKind === "overflow") todos = Array.from({ length: 25 }, (_, i) => pendingTodo(`Task ${i}`));
		else if (listKind === "all-completed") todos = Array.from({ length: 15 }, (_, i) => completedTodo(`Task ${i}`));
		else todos = Array.from({ length: 15 }, (_, i) => pendingTodo(`Task ${i}`));

		const maxWidgetLines = 12;
		setForeground("comb-session");
		setTodos("comb-session", todos);

		const theme = makeTheme() as Theme;
		const isExpanded = uiMode === "expanded";
		const ui = createMockUI({
			theme,
			getToolsExpanded: vi.fn(() => isExpanded),
		});
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const overlay = new TodoOverlay({ maxWidgetLines, collapseKey: "alt+o" });
		overlay.setUICtx(ui as unknown as ExtensionUIContext);
		overlay.update();

		const call = ui.setWidget.mock.calls.find(([, f]) => typeof f === "function");
		if (todos.length === 0) {
			expect(call).toBeUndefined();
			return;
		}
		expect(call).toBeDefined();

		const factory = call?.[1] as (t: TUI, th: Theme) => MouseRegion;
		const widget = factory(tui, theme);

		if (uiMode === "collapsed") {
			overlay.toggleCollapse();
		}

		// Apply wheel delta
		if (scrollDelta !== 0) {
			widget.handleMouse({ type: "wheel", wheelDelta: scrollDelta } as TuiMouseEvent);
		}

		const lines = widget.render(width);

		// Invariant 1: Width constraint (No line may exceed width)
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}

		// Invariant 2: Height budget constraint
		if (uiMode === "collapsed") {
			expect(lines.length).toBe(3); // heading + hint + spacer
		} else if (uiMode === "expanded") {
			expect(lines.length).toBe(todos.length + 2); // heading + all items + spacer
		} else {
			// Normal mode: Content + spacer MUST NOT exceed budget
			expect(lines.length).toBeLessThanOrEqual(maxWidgetLines + 1);
		}

		// Invariant 3: Spacer invariant (Last line must always be empty spacer)
		expect(lines[lines.length - 1]).toBe("");

		// Invariant 4: Heading count invariant (when width is wide enough not to truncate)
		if (width >= 80) {
			const completedCount = todos.filter((t) => t.status === "completed").length;
			expect(lines[0]).toContain(`Todos (${completedCount}/${todos.length})`);
		}
	});
});

/* -------------------------------------------------------------------------------------------------
 * 矩阵三：入参校验与宿主类型转换笛卡尔积测试 (125 种场景)
 * -----------------------------------------------------------------------------------------------*/
describe("Tool parameter validation and coercion combinatorial matrix", () => {
	const containerForms = ["array", "single-object", "empty-array", "scalar-num", "scalar-str"] as const;
	const contentForms = ["normal", "num-coerced", "bool-coerced", "blank", "empty"] as const;
	const statusForms = ["pending", "in_progress", "completed", "invalid-enum", "number"] as const;

	const matrix = cartesian(containerForms, contentForms, statusForms);

	it.each(matrix)("container: %s, content: %s, status: %s", async (containerForm, contentForm, statusForm) => {
		const { pi, captured } = createMockPi();
		registerTodoTool(pi, {});
		const tool = captured.tools.get("todo");
		if (!tool) throw new Error("todo not registered");

		let rawContent: unknown;
		if (contentForm === "normal") rawContent = "Valid content";
		else if (contentForm === "num-coerced") rawContent = 42;
		else if (contentForm === "bool-coerced") rawContent = true;
		else if (contentForm === "blank") rawContent = "   ";
		else rawContent = "";

		let rawStatus: unknown;
		if (statusForm === "number") rawStatus = 1;
		else rawStatus = statusForm;

		const item = { content: rawContent, status: rawStatus };

		let rawTodos: unknown;
		if (containerForm === "array") rawTodos = [item];
		else if (containerForm === "single-object") rawTodos = item;
		else if (containerForm === "empty-array") rawTodos = [];
		else if (containerForm === "scalar-num") rawTodos = 999;
		else rawTodos = "just-a-string";

		const isContainerValid =
			containerForm === "array" || containerForm === "single-object" || containerForm === "empty-array";
		const isContentValid =
			contentForm === "normal" || contentForm === "num-coerced" || contentForm === "bool-coerced";
		const isStatusValid = statusForm === "pending" || statusForm === "in_progress" || statusForm === "completed";

		const shouldPass = containerForm === "empty-array" || (isContainerValid && isContentValid && isStatusValid);

		const validateAndExecute = async () => {
			// 1. Host validation step (Value.Convert + TypeBox check)
			const validatedArgs = validateToolArguments(tool as unknown as Tool, {
				type: "toolCall",
				id: "call_test",
				name: "todo",
				arguments: { todos: rawTodos } as JsonObject,
			});
			// 2. Tool execution step (normalizeTodos + snapshot commit)
			return await tool.execute("call_test", validatedArgs, undefined, undefined, createMockCtx());
		};

		if (shouldPass) {
			const res = await validateAndExecute();
			expect(res.isError).toBeFalsy();
			if (containerForm === "empty-array") {
				expect(res.details).toEqual({ todos: [] });
			} else {
				const expectedContent = String(rawContent).trim();
				expect(res.details).toEqual({
					todos: [{ content: expectedContent, status: statusForm }],
				});
			}
		} else {
			await expect(validateAndExecute()).rejects.toThrow();
		}
	});
});
