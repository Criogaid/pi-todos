import type { Theme } from "@earendil-works/pi-coding-agent";
import { countTasks, type Task, type TaskStatus } from "./model.js";
import { sanitizeTerminalText } from "./sanitize.js";

function idList(ids: readonly string[]): string {
	return ids.map((id) => `#${id}`).join(", ");
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
