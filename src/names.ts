/** Tool names, shared by registration, config and the reminder. They match Claude Code's task tools. */

export const TASK_CREATE = "TaskCreate";
export const TASK_GET = "TaskGet";
export const TASK_LIST = "TaskList";
export const TASK_UPDATE = "TaskUpdate";

export const TASK_TOOL_NAMES = [TASK_CREATE, TASK_GET, TASK_LIST, TASK_UPDATE] as const;
export type TaskToolName = (typeof TASK_TOOL_NAMES)[number];

/** Tools that change the list. A call to either counts as task management for the reminder. */
export const TASK_WRITE_TOOL_NAMES: readonly string[] = [TASK_CREATE, TASK_UPDATE];
