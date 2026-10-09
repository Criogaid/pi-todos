import { describe, expect, it } from "vitest";
import { makeState, makeTask } from "../test/helpers/index.js";
import { EMPTY_STATE } from "./model.js";
import {
	__resetState,
	clearForeground,
	evictSession,
	getForeground,
	getForegroundState,
	getTaskState,
	setForeground,
	setTaskState,
} from "./store.js";

describe("session task state", () => {
	it("keeps states, counters and eviction local to the specified session", () => {
		const parent = makeState([makeTask()], 8);
		const child = makeState([makeTask("2")], 10);
		expect(getTaskState("missing")).toBe(EMPTY_STATE);
		setTaskState("parent", parent);
		setTaskState("child", child);
		setTaskState("parent", makeState([], parent.highWaterMark));
		expect(getTaskState("parent")).toEqual(makeState([], 8));
		expect(getTaskState("child")).toBe(child);
		evictSession("parent");
		expect(getTaskState("parent")).toBe(EMPTY_STATE);
		expect(getTaskState("child")).toBe(child);
	});

	it("shows only the selected foreground and resets every session", () => {
		const first = makeState([makeTask()]);
		const second = makeState([makeTask("2")]);
		setTaskState("first", first);
		setTaskState("second", second);
		expect(getForegroundState()).toBe(EMPTY_STATE);
		setForeground("first");
		expect(getForegroundState()).toBe(first);
		setForeground("second");
		expect(getForegroundState()).toBe(second);
		clearForeground();
		expect(getForeground()).toBeUndefined();
		expect(getForegroundState()).toBe(EMPTY_STATE);
		expect(getTaskState("first")).toBe(first);
		setForeground("first");
		__resetState();
		expect(getForeground()).toBeUndefined();
		expect(getTaskState("first")).toBe(EMPTY_STATE);
		expect(getTaskState("second")).toBe(EMPTY_STATE);
	});
});
