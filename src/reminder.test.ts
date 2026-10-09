import { describe, expect, it } from "vitest";
import {
	makeAssistantMessage,
	makeMessageEntry,
	makeSnapshotEntry,
	makeState,
	makeToolResult,
	makeUserMessage,
} from "../test/helpers/index.js";
import { isReminderDue, REMINDER_INTERVAL_TURNS, REMINDER_MESSAGE_TYPE } from "./reminder.js";

function turns(count: number) {
	return Array.from({ length: count }, () => makeMessageEntry(makeAssistantMessage()));
}
const reminder = { type: "custom_message", customType: REMINDER_MESSAGE_TYPE };

describe("branch-based task reminder", () => {
	it("becomes due after ten assistant turns, ignoring non-assistant entries", () => {
		expect(isReminderDue([])).toBe(false);
		expect(isReminderDue(turns(9))).toBe(false);
		expect(isReminderDue(turns(10))).toBe(true);
		const noise = [
			null,
			{},
			makeMessageEntry(makeUserMessage("Continue")),
			makeMessageEntry(makeToolResult({ toolName: "TaskGet" })),
		];
		expect(isReminderDue([...turns(9), ...noise])).toBe(false);
		expect(isReminderDue([...turns(9), ...noise, ...turns(1)])).toBe(true);
	});

	it.each([
		["TaskCreate", makeMessageEntry(makeAssistantMessage(["TaskCreate"]))],
		["TaskUpdate", makeMessageEntry(makeAssistantMessage(["TaskUpdate"]))],
		["nested write snapshot", makeSnapshotEntry(makeState(), "wrapper/1")],
		["previous reminder", reminder],
	])("resets the interval at %s", (_name, marker) => {
		expect(isReminderDue([...turns(10), marker])).toBe(false);
		expect(isReminderDue([...turns(10), marker, ...turns(REMINDER_INTERVAL_TURNS - 1)])).toBe(false);
		expect(isReminderDue([...turns(10), marker, ...turns(REMINDER_INTERVAL_TURNS)])).toBe(true);
	});

	it.each(["TaskGet", "TaskList"])("counts a %s turn without treating it as task management", (name) => {
		expect(isReminderDue([...turns(9), makeMessageEntry(makeAssistantMessage([name]))])).toBe(true);
	});

	it("does not count automatic clearing as a task-management marker", () => {
		const clear = makeSnapshotEntry(makeState([], 9));
		expect(isReminderDue([...turns(9), clear, ...turns(1)])).toBe(true);
	});

	it("spaces reminders by the assistant turns on the selected branch", () => {
		const branch = [...turns(10), reminder, ...turns(4)];
		expect(isReminderDue(branch)).toBe(false);
		expect(isReminderDue([...branch, ...turns(6)])).toBe(true);
		expect(isReminderDue([...branch, ...turns(6), reminder])).toBe(false);
		function* selectedBranch() {
			yield* branch;
		}
		expect(isReminderDue(selectedBranch())).toBe(false);
	});
});
