# Task tools reference

Parameters, results and persistence for the four task tools registered by
[`pi-todos`](https://github.com/Criogaid/pi-todos): `TaskCreate`, `TaskGet`,
`TaskList` and `TaskUpdate`. Names, parameters, descriptions and the text the
model reads back follow Claude Code's task tools, except where
[Differences from Claude Code](#differences-from-claude-code) says otherwise.

## Model

The list is a set of tasks with ids. Each call reads or changes one task:

- `TaskCreate` adds a task, `pending` unless told otherwise, and returns its
  id.
- `TaskGet` returns one task in full.
- `TaskList` returns a summary of every task.
- `TaskUpdate` changes some fields of one task, adds dependency edges, or
  deletes the task.

Ids are decimal strings assigned in order: `"1"`, `"2"`, `"3"`, … An id is
never reused, not after a deletion and not after a finished list is cleared.

Any status change is allowed, in any direction, and any number of tasks may be
`in_progress` at once. Tasks are listed in creation order.

## Differences from Claude Code

The tools follow Claude Code's, with a few changes that let the model do in
one response what would otherwise take several:

- `TaskCreate` also takes `status`, `addBlocks` and `addBlockedBy`, so a task
  can start `in_progress` and depend on existing tasks without a follow-up
  `TaskUpdate`.
- A `TaskUpdate` that completes or deletes a task names the next available
  task, so the model does not need `TaskList` to find it.
- A call that starts a task while others are still `in_progress` lists them,
  so the model notices a task it forgot to complete. Nothing is blocked or
  changed.
- The descriptions drop the advice to read a task before every update or list
  tasks after every completion or before every creation. They require independent
  task-tool calls in one assistant message, including creates, reads, updates and
  cleanup deletions. Task tools execute sequentially; execution order alone does
  not require another model turn. Wait only when a later call needs an earlier
  result, such as a new task id. Complete a task and start the next with a known
  id in the same message.

## `TaskCreate`

```ts
TaskCreate({
  subject: string,                    // imperative title, e.g. "Run the test suite"
  description: string,                // what needs to be done
  activeForm?: string,                // shown while in_progress, e.g. "Running the test suite"
  status?: "pending" | "in_progress" | "completed", // initial status, default "pending"
  addBlocks?: string[],               // existing tasks that cannot start until this one completes
  addBlockedBy?: string[],            // existing tasks that must complete before this one can start
  metadata?: Record<string, unknown>, // stored on the task
})
```

Edges are recorded on both tasks, as `TaskUpdate` records them. Ids that do
not exist yet are skipped, so a task cannot depend on one created later in the
same response; add those edges with `TaskUpdate` once the ids are known.

The model reads back `Task #<id> created successfully: <subject>`. When the
task is created `in_progress` and other tasks are `in_progress` too, a second
line lists them: `Also in progress: #2, #5. Mark any that are done as completed.`

## `TaskGet`

```ts
TaskGet({ taskId: string })
```

The model reads back:

```
Task #2: Implement the fix
Status: in_progress
Description: Patch the parser so empty input no longer throws
Blocked by: #1
Blocks: #3
```

The `Blocked by` and `Blocks` lines appear only when they are non-empty, and
they list every edge, open or not. An unknown id answers `Task not found`.

## `TaskList`

```ts
TaskList({})
```

One line per task, in creation order:

```
#1 [completed] Reproduce the issue
#2 [in_progress] Implement the fix (alice)
#3 [pending] Verify the result [blocked by #2]
```

The owner appears in parentheses when it is set. `blocked by` lists only
blockers that still exist and are not completed. An empty list answers
`No tasks found`.

Tasks whose `metadata._internal` is `true` are left out, as they are from the
overlay and `/tasks`.

## `TaskUpdate`

```ts
TaskUpdate({
  taskId: string,
  subject?: string,
  description?: string,
  activeForm?: string,
  status?: "pending" | "in_progress" | "completed" | "deleted",
  addBlocks?: string[],                // tasks that cannot start until this one completes
  addBlockedBy?: string[],             // tasks that must complete before this one can start
  owner?: string,
  metadata?: Record<string, unknown>,  // merged; a null value deletes that key
})
```

- A field is applied, and reported, only when its value differs from the
  current one. `metadata` is the exception: it is merged key by key and always
  reported when given.
- `addBlocks` and `addBlockedBy` only add edges. Each edge is recorded on both
  tasks: `addBlocks: ["3"]` on task 2 also adds `2` to task 3's `blockedBy`.
  Unknown ids, the task's own id and edges that already exist are skipped.
- `status: "deleted"` removes the task and every edge that points at it; other
  fields in the same call are ignored.

The model reads back `Updated task #<id> <fields>`, where `<fields>` lists the
changed fields in this order: `subject`, `description`, `activeForm`, `owner`,
`metadata`, `status`, `blocks`, `blockedBy`. A call that changes nothing lists
no fields: `Updated task #2 ` with a trailing space. A deletion reads
`Updated task #2 deleted`, and an unknown id `Task not found`.

When the call moves a task to `completed` or `deleted`, a second line names the
next available task — the lowest-id visible task that is `pending`, has no
owner and no open blockers:

```
Updated task #1 status
Next available task: #2 Implement the fix
```

The line is left out when no task is available. When the call moves a task to
`in_progress`, the `Also in progress` line described under `TaskCreate`
follows instead if other tasks are `in_progress`.

## Argument repair

Before validation, the tools accept a few near misses, as Claude Code does:

- `id` or `task_id` is read as `taskId`, and `active_form` as `activeForm`;
- a task id may be written `3`, `"#3"` or `" 3 "`, in `taskId`, `addBlocks`
  and `addBlockedBy`.

Pi then converts arguments to the schema's declared types and validates them;
a call that still does not match fails with the host's validation error and
changes nothing.

## Results

Every result carries the text above in `content`, plus the same structured
output in `details` (for the renderers) and `structuredContent` (for wrapper
tools such as `codemode`, which hand it to scripts). Each tool declares the
shape as its `outputSchema`:

```ts
TaskCreate → { task: { id, subject }, alsoInProgress?: string[] }
TaskGet    → { task: { id, subject, description, status, blocks, blockedBy } | null }
TaskList   → { tasks: Array<{ id, subject, status, owner?, blockedBy }> }
TaskUpdate → { success, taskId, updatedFields, error?, statusChange?: { from, to }, nextTask?: { id, subject }, alsoInProgress?: string[] }
```

`TaskList` reports open blockers only, as in its text. An unknown id is not a
failed tool call: `TaskGet` returns `task: null`, and `TaskUpdate` returns
`success: false` with `error: "Task not found"`.

## Persistence and replay

Each successful `TaskCreate` or `TaskUpdate` saves the whole list with
`pi.appendEntry()` before replacing live state, including calls that change
nothing. The custom entry has the type `pi-todos-tasks` and contains
`data: { version, tasks, highWaterMark, toolCallId }`, where `highWaterMark` is
the highest id assigned so far. These entries stay on the session branch and
never enter model context. `TaskGet`, `TaskList` and calls for an unknown id
save nothing.

On session start, compaction and tree navigation, the list is restored from
the latest valid snapshot on the branch, so navigating to another branch point
restores the list saved there. Malformed snapshots and other format versions
are skipped, and edges to tasks a snapshot does not contain are dropped.
Calls made inside wrapper tools such as `codemode` run the same code and save
their own snapshots.

There are no task files on disk and no list shared between sessions. Snapshots
from the earlier `todo` tool are not read.

## Finished lists

When every visible task is `completed`, the list stays until the next agent
run starts. The extension then clears it, keeping the id counter, and saves
the empty list as a snapshot without a `toolCallId`. Claude Code clears a
finished list a few seconds after its last task completes; clearing at the
next run keeps the result on screen until you move on.

## Task reminder

When `taskReminder` is on (the default), the extension counts assistant turns
on the session branch. Once 10 turns have passed since the last `TaskCreate`
or `TaskUpdate` call, and 10 since the last reminder, the end of the turn adds
a hidden message, the same text Claude Code sends, suggesting the task tools
if they are relevant. It is stored in the session, so later turns count from
it. No reminder is added after an aborted or failed turn, or while `TaskCreate`
is not an active tool. See [configuration.md](configuration.md#taskreminder).
