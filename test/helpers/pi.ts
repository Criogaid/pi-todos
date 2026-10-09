import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionToolContext,
	ExtensionUIContext,
	RegisteredCommand,
	SessionEntry,
	Theme,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import type { MockTheme } from "./theme.js";

/** A captured `registerShortcut` registration (KeyId → handler). */
export interface CapturedShortcut {
	description?: string;
	handler: (ctx: unknown) => Promise<void> | void;
}

export interface CapturedPi {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	/** Keyboard shortcuts registered via `pi.registerShortcut(keyId, opts)`. */
	shortcuts: Map<string, CapturedShortcut>;
	flags: Map<string, unknown>;
	events: Map<string, Array<(...args: unknown[]) => unknown>>;
	eventsEmitted: Map<string, unknown[]>;
	activeTools: string[];
	allTools: ToolInfo[];
}

export interface MockPi {
	pi: ExtensionAPI;
	captured: CapturedPi;
}

export function createMockPi(options: Partial<ExtensionAPI> = {}): MockPi {
	const captured: CapturedPi = {
		tools: new Map(),
		commands: new Map(),
		shortcuts: new Map(),
		flags: new Map(),
		events: new Map(),
		eventsEmitted: new Map(),
		activeTools: [],
		allTools: [],
	};

	const pi = {
		registerTool: vi.fn((tool: ToolDefinition) => {
			captured.tools.set(tool.name, tool);
			if (!captured.activeTools.includes(tool.name)) captured.activeTools.push(tool.name);
		}),
		registerCommand: vi.fn((name: string, cmd: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			captured.commands.set(name, cmd);
		}),
		registerShortcut: vi.fn((shortcut: string, opts: CapturedShortcut) => {
			captured.shortcuts.set(shortcut, opts);
		}),
		registerFlag: vi.fn((name: string, value: unknown) => {
			captured.flags.set(name, value);
		}),
		getFlag: vi.fn((name: string) => captured.flags.get(name)),
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			const list = captured.events.get(event) ?? [];
			list.push(handler);
			captured.events.set(event, list);
		}),
		sendMessage: vi.fn(async () => {}),
		sendUserMessage: vi.fn(() => {}),
		appendEntry: vi.fn(() => {}),
		exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false })),
		getActiveTools: vi.fn(() => [...captured.activeTools]),
		setActiveTools: vi.fn((names: string[]) => {
			captured.activeTools = [...names];
		}),
		getAllTools: vi.fn(() => [...captured.allTools]),
		getThinkingLevel: vi.fn(() => "medium"),
		events: {
			emit: vi.fn((channel: string, data: unknown) => {
				const list = captured.eventsEmitted.get(channel) ?? [];
				list.push(data);
				captured.eventsEmitted.set(channel, list);
			}),
			on: vi.fn(() => () => {}),
		},
		getCommands: vi.fn(() => []),
		...options,
	} as unknown as ExtensionAPI;

	return { pi, captured };
}

export interface MockUI {
	notify: ReturnType<typeof vi.fn>;
	confirm: ReturnType<typeof vi.fn>;
	input: ReturnType<typeof vi.fn>;
	select: ReturnType<typeof vi.fn>;
	setWidget: ReturnType<typeof vi.fn>;
	setStatus: ReturnType<typeof vi.fn>;
	setWorkingMessage: ReturnType<typeof vi.fn>;
	setHiddenThinkingLabel: ReturnType<typeof vi.fn>;
	onTerminalInput: ReturnType<typeof vi.fn>;
	pasteToEditor: ReturnType<typeof vi.fn>;
	setEditorComponent: ReturnType<typeof vi.fn>;
	/** Only present when a test passes one in; overlay renders fall back to the factory theme otherwise. */
	theme?: Theme | MockTheme;
}

export function createMockUI(
	overrides: Partial<Omit<ExtensionUIContext, "theme">> & { theme?: Theme | MockTheme } = {},
): MockUI {
	return {
		notify: vi.fn(),
		confirm: vi.fn(async () => true),
		input: vi.fn(async () => ""),
		select: vi.fn(async () => undefined),
		setWidget: vi.fn(),
		setStatus: vi.fn(),
		setWorkingMessage: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		onTerminalInput: vi.fn(() => () => {}),
		pasteToEditor: vi.fn(),
		setEditorComponent: vi.fn(),
		...overrides,
	} as unknown as MockUI;
}

export function createMockSessionManager(branch: SessionEntry[] = [], sessionId = "test-session") {
	return {
		getBranch: vi.fn(() => branch),
		getEntries: vi.fn(() => branch),
		getLeafId: vi.fn(() => (branch.length ? branch[branch.length - 1].id : null)),
		getSessionFile: vi.fn(() => "/tmp/test-session.jsonl"),
		getSessionId: vi.fn(() => sessionId),
	};
}

export function createMockModelRegistry(models: Model<Api>[] = []) {
	return {
		find: vi.fn((provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id)),
		getAvailable: vi.fn(() => [...models]),
		getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key", headers: {} })),
	};
}

export interface MockCtxOptions {
	hasUI?: boolean;
	/** Host mode advertised by the context, such as "rpc". */
	mode?: string;
	cwd?: string;
	model?: Model<Api>;
	branch?: SessionEntry[];
	models?: Model<Api>[];
	ui?: Partial<ExtensionUIContext>;
	/** Session id the ctx advertises via `sessionManager.getSessionId()`. Defaults to "test-session". */
	sessionId?: string;
}

export function createMockCtx(opts: MockCtxOptions = {}): ExtensionToolContext {
	return {
		hasUI: opts.hasUI ?? false,
		mode: opts.mode,
		cwd: opts.cwd ?? "/tmp/test-cwd",
		model: opts.model,
		ui: createMockUI(opts.ui),
		sessionManager: createMockSessionManager(opts.branch ?? [], opts.sessionId),
		modelRegistry: createMockModelRegistry(opts.models ?? []),
		isIdle: vi.fn(() => true),
		tools: [],
		executeTool: vi.fn(async () => {
			throw new Error("executeTool is not available in tests");
		}),
	} as unknown as ExtensionToolContext;
}
