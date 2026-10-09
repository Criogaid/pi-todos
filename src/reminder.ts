/**
 * Claude Code's task reminder: after 10 assistant turns without a TaskCreate
 * or TaskUpdate call, and 10 turns after the previous reminder, the model gets
 * a hidden nudge to use the task tools.
 *
 * The count is read from the session branch rather than kept in memory, so it
 * survives `/reload` and follows tree navigation.
 */

import { isRecord } from "./model.js";
import { TASK_CREATE, TASK_UPDATE, TASK_WRITE_TOOL_NAMES } from "./names.js";
import { isSnapshotEntry } from "./persistence.js";

export const REMINDER_MESSAGE_TYPE = "pi-todos-reminder";
export const REMINDER_INTERVAL_TURNS = 10;

export const REMINDER_TEXT = `<system-reminder>
The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using ${TASK_CREATE} to add new tasks and ${TASK_UPDATE} to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable. Make sure that you NEVER mention this reminder to the user
</system-reminder>`;

function assistantMessage(entry: Record<string, unknown>): Record<string, unknown> | undefined {
	const message = entry.type === "message" ? entry.message : undefined;
	return isRecord(message) && message.role === "assistant" ? message : undefined;
}

function callsWriteTool(message: Record<string, unknown>): boolean {
	return (
		Array.isArray(message.content) &&
		message.content.some(
			(block) =>
				isRecord(block) &&
				block.type === "toolCall" &&
				typeof block.name === "string" &&
				TASK_WRITE_TOOL_NAMES.includes(block.name),
		)
	);
}

/**
 * A direct call shows up as a tool call in an assistant message. A call made
 * inside a wrapper tool shows up as the snapshot it saved; a snapshot without
 * a call id is the extension clearing a finished list, not task management.
 */
function isTaskManagement(entry: Record<string, unknown>): boolean {
	if (isSnapshotEntry(entry)) return isRecord(entry.data) && typeof entry.data.toolCallId === "string";
	const message = assistantMessage(entry);
	return message !== undefined && callsWriteTool(message);
}

function isReminder(entry: Record<string, unknown>): boolean {
	return entry.type === "custom_message" && entry.customType === REMINDER_MESSAGE_TYPE;
}

/** Whether the last task-management call and the last reminder are both at least 10 assistant turns back. */
export function isReminderDue(branch: Iterable<unknown>): boolean {
	const entries = Array.from(branch);
	let turns = 0;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isRecord(entry)) continue;
		if (isTaskManagement(entry) || isReminder(entry)) return false;
		if (assistantMessage(entry) && ++turns >= REMINDER_INTERVAL_TURNS) return true;
	}
	return false;
}
