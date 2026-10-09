# Overlay and `/tasks` display

How
[`pi-todos`](https://github.com/Criogaid/pi-todos)
renders the task list — when the overlay appears, what each glyph means, how
overflow is trimmed.

## When the overlay exists

The widget is mounted above the Pi editor under the key `pi-todos`.

| Stage | Condition |
| --- | --- |
| Loaded | The overlay module is loaded lazily, the first time the foreground session has a visible task. Headless sessions never load it. |
| Registered | Only while the list has at least one visible task. |
| Bound | Only the foreground session — the first session started with a UI — drives the overlay. A detached or child session has its own list and never repaints the foreground panel. |
| Disposed | On the foreground session's shutdown. A child session shutting down leaves the overlay alone. |

Lists are kept per session id, so parallel sessions cannot read or overwrite
each other's lists. The extension writes no files: on session start,
compaction and session-tree changes the list is restored from the last task
snapshot on the branch.

## Anatomy

```
● Tasks (2/5)
├─ ✓ #1 Create DemoTodo domain entity
├─ ✓ #2 Create IDemoTodoRepository interface
├─ ◐ #3 Create DemoTodoRepository (Creating the repository)
├─ ○ #4 Register DI bindings › blocked by #3
└─ ○ #5 Add integration tests
```

- **Heading** — `Tasks (completed/total)`, counted over the visible list. Accent
  `●` while anything is unfinished; dim `○` once everything is completed.
- **Glyphs** — `○` pending, `◐` in_progress, `✓` completed. Completed tasks
  render muted and struck through.
- **Id** — each row shows the task id the model uses with `TaskGet` and
  `TaskUpdate`.
- **activeForm** — appended in parentheses while the task is `in_progress`.
- **Owner** — appended as `@owner` when set.
- **Blockers** — `› blocked by #n` lists blockers that still exist and are not
  completed; a blocked task renders muted.
- **Prefixes** — `├─` on each row, `└─` on the last. A blank spacer line is
  appended so the panel is not flush against the input box.

Tasks whose `metadata._internal` is `true` are not shown or counted. Rows
longer than the terminal width are truncated with `…`.

## Overflow

The content-row budget is `maxWidgetLines` (default `12`); the heading counts
against it. When the list does not fit, it becomes a window over the full list:

1. one row is reserved for the position footer (`↑ N above · ↓ N below`);
2. the remaining rows show the window at its current offset;
3. turning the mouse wheel over the panel moves the window; at its edges the
   event stays unhandled so the host keeps its default wheel behavior;
4. a changed list opens the window at the first `in_progress` task — or, with
   none, the first unfinished task — so the current work stays in view; near
   the end of the list the window stops at the last task instead. A write that
   changes nothing keeps the window where it is.

Mouse wheel scrolling requires Pi's fullscreen renderer, which is the only one
that captures mouse events, and Pi 0.85 or later; older hosts show the window
without wheel scrolling. Otherwise use Pi's tool-output expansion shortcut
(`ctrl+o` by default), which expands the widget to show every task, or
`/tasks`.

## Finished lists

When every visible task is completed, the list stays on screen for the rest of
that run. When the next agent run starts, the extension clears the list and the
panel disappears. Ids keep counting from where they were, so the next task the
model creates gets a new id.

## Collapsing

Press `ctrl+shift+t` to collapse the panel to the heading plus a dim
`└─ ctrl+shift+t to expand` hint, and again to expand it. Rebind or disable the
shortcut with the `collapseKey` option; see
[configuration.md](./configuration.md#collapsekey).

## `/tasks`

`/tasks` prints the whole visible list grouped by status, independent of the
overlay's row budget:

```
2/7 completed · 1 in progress · 4 pending
── Pending ──
  ○ #4 Register DI bindings › blocked by #3
  ○ #5 Add integration tests
  ○ #6 Wire up the HTTP endpoint
  ○ #7 Update the API docs
── In Progress ──
  ◐ #3 Create DemoTodoRepository (Creating the repository)
── Completed ──
  ✓ #1 Create DemoTodo domain entity
  ✓ #2 Create IDemoTodoRepository interface
```

The header omits any count that is zero; sections appear only when they have
tasks.

- With no tasks: `No tasks yet. Ask the agent to add some!`
- In a non-interactive session: `/tasks requires interactive mode`

## Tool rows

Each task tool call renders a one-line row in the transcript: the tool name
and the task id or subject, then the result — `✓ #3 created`,
`✓ #3 pending → in_progress`, or `✓ 2/5 completed` for `TaskList`. Pi's
tool-output expansion shows the description for `TaskGet` and every row for
`TaskList`. Rows render from each call's own result, so historical calls keep
showing what they returned then.

## Language

All text is English: the overlay, `/tasks`, tool responses, errors and schema
descriptions. The extension ships no translations.
