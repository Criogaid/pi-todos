# Task tools

`TaskRead` and `TaskWrite` operate on one session-local state. Their schemas,
result shapes, and limits live in [`schema.ts`](../src/schema.ts); domain
transitions and shared selectors live in [`model.ts`](../src/model.ts).

## Task model

| Field | Meaning |
| --- | --- |
| `id` | Assigned positive decimal string. Stable within branch history; deletion never resets allocation. |
| `subject` | Required outcome title. |
| `description` | Required requirements, constraints, and completion criteria. |
| `progress` | Optional replaceable checkpoint with findings and next action. |
| `status` | `pending`, `in_progress`, or `completed`. Creation defaults to pending. |
| `dependsOn` | Prerequisite IDs, stored only on the dependent task. Defaults to an empty array on creation. |
| `owner` | Optional assignment label, with no locking or subagent authority. |
| `activeForm` | Optional display label while in progress. |
| `metadata` | Optional JSON object. No key has visibility or scheduling semantics. |

All text fields require a non-whitespace character. Optional fields may be
cleared with `null`; omitted fields remain unchanged. Arrays and metadata are
replaced as a whole. A `null` value inside metadata is ordinary data.

All status transitions are allowed. Dependencies do not enforce starting order.
A prerequisite becoming completed stops blocking its dependents; reopening it
restores the blocker without reopening those dependents. Every view derives
`blockedBy` from unfinished prerequisites. The complete relation remains
available as `dependsOn` in task details.

## TaskWrite

```ts
TaskWrite({
  operations: [
    { action: "update", id: "1", set: { status: "completed", progress: "Checks passed" } },
    { action: "update", id: "2", set: { status: "in_progress", dependsOn: ["1"] } },
    { action: "create", task: { subject: "Investigate the new issue", description: "Identify the cause" } }
  ]
})
```

One operation uses the same array shape. `create.task` requires subject and
description and accepts the remaining editable fields. `update.set` accepts
any subset of editable fields, including an empty no-op object. `delete`
requires only `id`; it removes the task and references to it. Deletion does not
mean completion.

Operations execute in order on an unpublished candidate. IDs referenced anywhere
must already exist before the request; obtain new IDs from the result before
linking new tasks. Updating a task after deleting it fails. A final dependency
graph with missing IDs, self-dependencies, or a cycle rejects the whole batch.
Intermediate graph cycles are allowed if later operations resolve them.

A changed candidate is saved once before publication. Rejected batches publish
nothing and allocate no IDs. A batch with no net state change saves no snapshot.
Evaluation, append, and publication run synchronously without an await between
them, including inside concurrent nested calls.

```ts
{
  ok: true,
  changed: boolean,
  outcomes: Array<{ action: "create" | "update" | "delete", id: string, changed: boolean }>,
  active: SummaryPage,
  nextReady?: TaskSummary
}
```

Outcomes correspond to operations in input order. Their `changed` flags describe
each operation; the top-level flag describes the net change. Hints come only from
the final state. `nextReady` is the first pending, unowned task without current
blockers. It is a suggestion, not a reservation or scheduling constraint.

## TaskRead

```ts
TaskRead({})
TaskRead({ view: "summary", scope: "all", afterId: "20" })
TaskRead({ view: "details", ids: ["1", "2"] })
```

Summary is the default. `scope` defaults to `active` (unfinished tasks); `all`
includes completed tasks. Tasks are ordered by numeric creation ID. `afterId`
is an exclusive cursor, so a deleted task can still be used as a cursor. A page
reports total matching tasks and the number remaining after that page. Follow
`nextAfterId` with the same scope while tasks remain omitted.

Details requires `ids` and forbids `scope` and `afterId`. It returns complete
stored tasks plus current `blockedBy`, in requested order. To stay within the
output budget, it may return only a prefix of the requested tasks. Follow
`nextIds` in another details request. It never silently truncates stored fields.
Any unknown selected ID rejects the request without returning partial details.

```ts
type TaskSummary = { id: string, subject: string, status: string, owner?: string, blockedBy: string[] };
type SummaryPage = {
  ok: true, view: "summary", scope: "active" | "all",
  tasks: TaskSummary[], total: number, omitted: number, nextAfterId?: string
};
type DetailPage = { ok: true, view: "details", tasks: TaskDetail[], nextIds: string[] };
```

## Bounds

These are safety and attention budgets, not configuration options. Update
[`LIMITS`](../src/schema.ts), this section, and the linked README together.
JSON serialization budgets use JavaScript string length (UTF-16 units); text
schema bounds and context field shortening count Unicode code points.

| Input or view | Bound |
| --- | --- |
| Operations per write | 50 |
| Prerequisites per task | 100 distinct IDs |
| Selected detail IDs per read | 5 |
| Subject | 240 code points |
| Requirements | 8,000 code points |
| Progress | 2,000 code points |
| Owner or active label | 160 code points |
| Stored task serialized as JSON | 16,000 UTF-16 units |
| JSON nesting, including the request or snapshot envelope | 32 object/array levels |
| Summary page | 20 records and 8,000 UTF-16 units |
| Detail result | 24,000 UTF-16 units |
| Current-task context | 20 records and 6,000 UTF-16 units |
| Requirements/progress in context | At most 800 code points per field, shortened further when needed to fit |

The record bound includes escaped text and metadata, ensuring at least one
complete task can fit a detail response. Smaller summary and operation limits
also bound write feedback. IDs must be positive decimal strings without a `#`,
spaces, leading zeroes, or numeric coercion. Allocation stops at the largest
safe integer. Input with unknown fields or another argument shape is rejected
before the host can coerce it. Programmatic inputs must also be JSON values;
explicit `undefined`, non-finite numbers, functions, and cycles are rejected.

## Errors and structured output

The same typed outcome produces JSON text in `content`, renderer `details`, and
`structuredContent` for codemode. Both tools declare an output schema.
Domain and persistence failures return `isError: true` with:

```ts
{
  ok: false,
  error: { code, field, message, operationIndex?, id? },
  active?: SummaryPage
}
```

The operation index is zero-based. An available state includes an active summary
for recovery, including an explicit empty summary when appropriate. Unavailable
state does not claim an empty plan. Raw schema failures occur before execution
and are reported by the host's failed-tool mechanism. They do not write anything.

Persistence errors leave live state unchanged but may have an uncertain durable
outcome in the host. Reload and inspect before retrying a create; there is no
idempotency key or automatic retry mechanism.

## Persistence and lifecycle

Snapshot type `pi-todos-tasks` uses format version 2 with tasks, highWaterMark,
and the originating toolCallId. Only this format is read or written. Every task
snapshot on the selected branch must be supported and valid; invalid data is
not skipped to recover an earlier state. A restoration failure blocks task tools
until a new session or valid branch is selected. Other extensions' entries are
not task snapshots.

There are no legacy tools, argument repairs, snapshot converters, downgrade
handlers, or historical result adapters. Existing session files remain untouched.
No tasks are inferred from tool-result text or nested-call diagnostics.

Completed work remains stored and reopenable. No run-start clearing, hidden-task
policy, reminder timer, or resume acknowledgement exists. The
[current context policy](configuration.md#task-context) and the panel are
projections of the same state.
