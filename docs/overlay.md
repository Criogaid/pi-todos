# Overlay and `/todos` display

How
[`pi-todos`](https://github.com/Criogaid/pi-todos)
renders the todo list — when the overlay appears, what each glyph means, how
overflow is trimmed.

## When the overlay exists

The widget is mounted above the Pi editor under the key `pi-todos`.

| Stage | Condition |
| --- | --- |
| Loaded | The overlay module is loaded lazily, the first time the foreground session has a non-empty list. Headless sessions never load it. |
| Registered | Only while the list is non-empty and not dismissed. |
| Bound | Only the foreground session — the first session started with a UI — drives the overlay. A detached or child session has its own list and never repaints the foreground panel. |
| Disposed | On the foreground session's shutdown. A child session shutting down leaves the overlay alone. |

Lists are kept per session id, so parallel sessions cannot read or overwrite
each other's lists. Nothing is written to disk by the extension: on session
start, compaction and session-tree changes the list is restored from the last
`todo` result on the branch.

## Anatomy

```
● Todos (2/5)
├─ ✓ Create DemoTodo domain entity
├─ ✓ Create IDemoTodoRepository interface
├─ ◐ Create DemoTodoRepository (creating the repository)
├─ ○ Register DI bindings
└─ ○ Add integration tests
```

- **Heading** — `Todos (completed/total)`, counted over the whole list. Accent
  `●` while anything is unfinished; dim `○` once everything is completed.
- **Glyphs** — `○` pending, `◐` in_progress, `✓` completed. Completed items
  render muted and struck through.
- **activeForm** — appended in parentheses while the item is `in_progress`.
- **Prefixes** — `├─` on each row, `└─` on the last. A blank spacer line is
  appended so the panel is not flush against the input box.

Rows longer than the terminal width are truncated with `…`.

## Overflow

The content-row budget is `maxWidgetLines` (default `12`); the heading counts
against it. When the list does not fit, it becomes a window over the full list:

1. one row is reserved for the position footer (`↑ N above · ↓ N below`);
2. the remaining rows show the window at its current offset;
3. turning the mouse wheel over the panel moves the window; at its edges the
   event stays unhandled so the host keeps its default wheel behavior;
4. a changed list opens the window at the `in_progress` item — or, with none,
   the first unfinished item — so the current work stays in view; near the end
   of the list the window stops at the last item instead. Resending the same
   list keeps the window where it is.

Mouse wheel scrolling requires Pi's fullscreen renderer, which is the only one
that captures mouse events, and Pi 0.85 or later; older hosts show the window
without wheel scrolling. Otherwise use Pi's tool-output expansion shortcut
(`ctrl+o` by default), which expands the widget to show every item, or
`/todos`.

## Finished lists

When every item is completed, the list stays on screen for the rest of that
turn. At the start of the next agent turn it is dismissed and the panel
disappears. It reappears as soon as the model writes a different list. A
restarted Pi session shows the restored list again until the next turn starts.

## Collapsing

Press `ctrl+shift+t` to collapse the panel to the heading plus a dim
`└─ ctrl+shift+t to expand` hint, and again to expand it. Rebind or disable the
shortcut with the `collapseKey` option; see
[configuration.md](./configuration.md#collapsekey).

## `/todos`

`/todos` prints the whole list grouped by status, independent of the overlay's
row budget and dismissal:

```
2/7 completed · 1 in progress · 4 pending
── Pending ──
  ○ Register DI bindings
  ○ Add integration tests
  ○ Wire up the HTTP endpoint
  ○ Update the API docs
── In Progress ──
  ◐ Create DemoTodoRepository (creating the repository)
── Completed ──
  ✓ Create DemoTodo domain entity
  ✓ Create IDemoTodoRepository interface
```

The header omits any count that is zero; sections appear only when they have
items.

- With no items: `No todos yet. Ask the agent to add some!`
- In a non-interactive session: `/todos requires interactive mode`

## Language

All text is English: the overlay, `/todos`, tool responses, errors and schema
descriptions. The extension ships no translations.
