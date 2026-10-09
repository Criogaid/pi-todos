import type { Theme } from "@earendil-works/pi-coding-agent";
import { countTasks, type Task, type TaskStatus, type TaskSummary, type UpdateOutcome } from "./model.js";
import { sanitizeTerminalText } from "./sanitize.js";

// Model-facing text. These strings match what Claude Code's task tools return.

export const NO_TASKS_FOUND = "No tasks found";

function idList(ids: readonly string[]): string {
	return ids.map((id) => `#${id}`).join(", ");
}

export function formatCreated(task: Task): string {
	return `Task #${task.id} created successfully: ${task.subject}`;
}

export function formatTaskDetail(task: Task): string {
	const lines = [`Task #${task.id}: ${task.subject}`, `Status: ${task.status}`, `Description: ${task.description}`];
	if (task.blockedBy.length > 0) lines.push(`Blocked by: ${idList(task.blockedBy)}`);
	if (task.blocks.length > 0) lines.push(`Blocks: ${idList(task.blocks)}`);
	return lines.join("\n");
}

export function formatSummaryLine(summary: TaskSummary): string {
	let line = `#${summary.id} [${summary.status}] ${summary.subject}`;
	if (summary.owner) line += ` (${summary.owner})`;
	if (summary.blockedBy.length > 0) line += ` [blocked by ${idList(summary.blockedBy)}]`;
	return line;
}

export function formatTaskList(summaries: readonly TaskSummary[]): string {
	return summaries.length === 0 ? NO_TASKS_FOUND : summaries.map(formatSummaryLine).join("\n");
}

/** An update that changed nothing ends in a bare space, as Claude Code's does. */
export function formatUpdated(outcome: UpdateOutcome): string {
	if (!outcome.success) return outcome.error ?? "";
	return `Updated task #${outcome.taskId} ${outcome.updatedFields.join(", ")}`;
}

// Terminal text. Task fields are model-controlled, so every field is sanitized.

export const STATUS_GLYPH: Record<TaskStatus, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "✓",
};

export const STATUS_COLOR: Record<TaskStatus, "dim" | "warning" | "success"> = {
	pending: "dim",
	in_progress: "warning",
	completed: "success",
};

function activeFormSuffix(task: Task): string {
	return task.status === "in_progress" && task.activeForm ? ` (${sanitizeTerminalText(task.activeForm)})` : "";
}

function ownerSuffix(task: Task): string {
	return task.owner ? ` @${sanitizeTerminalText(task.owner)}` : "";
}

function blockedSuffix(openBlockers: readonly string[]): string {
	return openBlockers.length > 0 ? ` › blocked by ${idList(openBlockers)}` : "";
}

/** `/tasks` row: indented glyph, plain text. */
export function formatCommandLine(task: Task, openBlockers: readonly string[]): string {
	const subject = sanitizeTerminalText(task.subject);
	return `  ${STATUS_GLYPH[task.status]} #${task.id} ${subject}${activeFormSuffix(task)}${ownerSuffix(task)}${blockedSuffix(openBlockers)}`;
}

/** Themed row shared by the overlay and expanded tool results. */
export function formatThemedLine(task: Task, openBlockers: readonly string[], theme: Theme): string {
	const glyph = theme.fg(STATUS_COLOR[task.status], STATUS_GLYPH[task.status]);
	const color =
		task.status === "in_progress"
			? "accent"
			: task.status === "completed" || openBlockers.length > 0
				? "muted"
				: "text";
	let subject = theme.fg(color, sanitizeTerminalText(task.subject));
	if (task.status === "completed") subject = theme.strikethrough(subject);
	const suffix = `${activeFormSuffix(task)}${ownerSuffix(task)}${blockedSuffix(openBlockers)}`;
	return `${glyph} ${theme.fg("dim", `#${task.id}`)} ${subject}${suffix ? theme.fg("muted", suffix) : ""}`;
}

/** `done/total completed · N in progress · M pending`, omitting zero counts. */
export function formatCountsHeader(tasks: readonly Task[]): string {
	const counts = countTasks(tasks);
	const parts: string[] = [];
	if (counts.completed > 0) parts.push(`${counts.completed}/${counts.total} completed`);
	if (counts.inProgress > 0) parts.push(`${counts.inProgress} in progress`);
	if (counts.pending > 0) parts.push(`${counts.pending} pending`);
	return parts.join(" · ");
}
