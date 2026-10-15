/** The complete public task-tool surface. */
export const TASK_READ = "TaskRead";
export const TASK_WRITE = "TaskWrite";
export const TASK_TOOL_NAMES = [TASK_READ, TASK_WRITE] as const;
export type TaskToolName = (typeof TASK_TOOL_NAMES)[number];
