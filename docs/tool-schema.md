# `todo` tool reference

Parameter schema, validation rules, response format and persistence for the
`todo` tool registered by
[`pi-todos`](https://github.com/Criogaid/pi-todos).

## Model

The tool has one operation: **write the whole list**. Every call sends the
complete, ordered list and replaces the previous one. There are no ids, no
per-item updates, no tombstones and no dependency edges — the model keeps the
list consistent by always resending all of it, including completed items.

## Parameters

```ts
todo({
  todos: Array<{
    content: string,                                  // imperative, e.g. "Run the test suite"
    status: "pending" | "in_progress" | "completed",
    activeForm?: string,                              // shown while in_progress, e.g. "Running the test suite"
  }>,
})
```

- `content` is trimmed and must not be blank.
- At most **one** item may be `in_progress`. Zero is allowed.
- At most 100 items.
- `activeForm` is trimmed; a blank value is dropped.
- `todos: []` clears the list.
- Item order is preserved and is the display order.

A rejected call throws. Pi records it as a failed tool result and the list is
left unchanged.

| Message | Cause |
| --- | --- |
| `todos must be an array` | Missing or non-array `todos`. |
| `todos must have at most 100 items` | List too long. |
| `todos[i] must be an object` | Malformed item. |
| `todos[i].content must be a non-blank string` | Empty or whitespace-only content. |
| `todos[i].status must be one of pending, in_progress, completed` | Invalid status. |
| `at most one todo can be in_progress` | More than one active item. |

Pi validates the TypeBox schema before the tool runs, so most structural errors
are reported by the host in its own wording; the table lists the tool's own checks.

### Argument coercion by Pi

Pi converts tool arguments to the schema's declared types before validating
them, for every tool. For this tool that means:

- a number or boolean `content` or `activeForm` becomes a string (`1` → `"1"`,
  `false` → `"false"`);
- a `null` `content` becomes the string `"null"`, so the item is stored with
  the text `null`;
- a `null` `activeForm` is dropped, as if it had been omitted;
- a non-array `todos` value is wrapped into a one-element list
  (`todos: { content: "Task", status: "pending" }` becomes a one-item list).

Such inputs are accepted rather than rejected. Everything above still applies to
the converted values: `todos: "text"` or `todos: 5` wrap to a one-element list
and fail item validation, and a numeric `status` becomes a string that still has
to name one of the three values. The extension receives only validated
arguments and does not re-check what the host already normalized.

## Response

```ts
{
  content: [{ type: "text", text: string }],
  details: { todos: Array<{ content: string, status: string, activeForm?: string }> },
}
```

`content` is what the model reads back:

```
Todo list updated: 1/3 completed.
[completed] Reproduce the issue
[in_progress] Implement the fix (implementing the fix)
[pending] Verify the result
```

An empty list answers `Todo list cleared.`

## Persistence and replay

Each `todo` write saves its normalized list with `pi.appendEntry()` before
replacing live state. The custom entry contains `data: { version, toolCallId, todos }`;
its type and format version are defined in
[`src/persistence.ts`](../src/persistence.ts). These entries remain on the session
branch without entering model context.

On session start, compaction and tree navigation, replay walks the branch in
order and restores the latest valid snapshot. Later direct results or nested-call
records with the same call id are skipped so they cannot overwrite the saved
state. Failed writes leave the live list unchanged. Navigating to another branch
point restores the list saved there.

Wrapper tools such as `codemode` may omit arguments or calls from their bounded
`nestedCalls` records. The saved snapshots preserve the complete list regardless
of those limits, including Pi's parameter conversions and the tool's trimming.

Older sessions without custom snapshots still replay successful direct results
and decodable nested arguments. Arguments already omitted from an old session
cannot be recovered. Malformed snapshots and unsupported format versions are skipped.

The tool's renderers draw each result from its own `details`, so a historical
call in the transcript shows the list as it was at that point, not today's list.
