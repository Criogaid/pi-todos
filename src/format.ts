import type { Theme } from "@earendil-works/pi-coding-agent";
import { countTasks, type Task, type TaskStatus, type TaskSummary, type UpdateOutcome } from "./model.js";
import { sanitizeTerminalText } from "./sanitize.js";

// Model-facing text. These strings match what Claude Code's task tools return,
// except the next-available and also-in-progress lines, which are pi-todos' own.

export const NO_TASKS_FOUND = "No tasks found";

function idList(ids: readonly string[]): string {
	return ids.map((id) => `#${id}`).join(", ");
}

/** Hints appended to a write result, each on its own line. */
export interface ResultHints {
	/** The task to pick up next, after one was resolved. */
	nextTask?: Pick<Task, "id" | "subject">;
	/** Other tasks still in_progress, after one was started. */
	alsoInProgress?: readonly string[];
}

function withHints(line: string, hints: ResultHints): string {
	const lines = [line];
	if (hints.nextTask) lines.push(formatNextAvailable(hints.nextTask));
	if (hints.alsoInProgress?.length) lines.push(formatAlsoInProgress(hints.alsoInProgress));
	return lines.join("\n");
}

export function formatCreated(task: Task, hints: ResultHints = {}): string {
	return withHints(`Task #${task.id} created successfully: ${task.subject}`, hints);
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

/**
 * An update that changed nothing ends in a bare space, as Claude Code's does.
 * Hints follow on their own lines: the next available task, so the model does
 * not need a TaskList call to find it, and other tasks left in_progress.
 */
export function formatUpdated(outcome: UpdateOutcome, hints: ResultHints = {}): string {
	if (!outcome.success) return outcome.error ?? "";
	return withHints(`Updated task #${outcome.taskId} ${outcome.updatedFields.join(", ")}`, hints);
}

export function formatNextAvailable(task: Pick<Task, "id" | "subject">): string {
	return `Next available task: #${task.id} ${task.subject}`;
}

export function formatAlsoInProgress(ids: readonly string[]): string {
	return `Also in progress: ${idList(ids)}. Mark any that are done as completed.`;
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
