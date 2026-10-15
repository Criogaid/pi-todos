# Panel and /tasks

The panel is a projection of the foreground session's task state, mounted above
the editor as `pi-todos`. The first terminal UI session owns it. Child and
headless sessions retain their own task state and cannot replace that panel.

## Visibility and lifecycle

A panel is visible while at least one task is unfinished. It includes completed
rows alongside unfinished rows, so its heading counts all tasks. When every task
is completed, the panel disappears without deleting anything. `/tasks` and
TaskRead's all scope still expose the completed plan; reopening a task brings the
panel back. Metadata never hides a task.

Session start, compaction, and branch navigation restore snapshots from the
selected branch. Successful TaskWrite calls refresh the panel. Foreground
shutdown releases the widget; a child shutdown leaves it alone. The module loads
on demand and is prewarmed only after a foreground UI session starts.

## Rows

```text
● Tasks (1/3)
├─ ✓ #1 Reproduce the failure
├─ ◐ #2 Fix the parser (Fixing the parser)
└─ ○ #3 Verify all cases › blocked by #2
```

Rows show the ID, subject, and status glyph: `○` pending, `◐` in progress, and
`✓` completed. Completed subjects are muted and struck through. An activeForm
label appears in parentheses only during progress. Owner labels appear with
`@`. Blockers are derived from unfinished prerequisites, exactly as in tool
results and model context. Task text is sanitized before terminal rendering.

## Overflow and collapsing

`maxWidgetLines` limits content rows, including the heading and the overflow
footer. The final blank spacer is extra. On overflow, a window follows the first
in-progress task or, if none, the first pending task. The footer reports rows
above and below. An unchanged list retains the current window.

In fullscreen mode, the mouse wheel moves the window; at its edges, the host
receives the wheel event. Pi's tool-output expansion provides a keyboard path to
all rows. `/tasks` also exposes the complete list. No fallback for hosts missing
MouseRegion is installed.

The configured `collapseKey` toggles a heading and shortcut hint. Its default is
defined in [`config.ts`](../src/config.ts) and documented in
[configuration](configuration.md#settings). A disabled shortcut registers no key.

## /tasks and tool results

`/tasks` prints all tasks grouped into in-progress, pending, and completed
sections, with a count header. Empty sections are omitted. An empty plan reports
that there are no tasks; non-interactive invocation reports that interactive
mode is required.

Tool calls show their tool name. Successful results show the returned task or
operation count; expansion shows the call's JSON result. Error results render as
errors. Rendering uses the result of that call rather than live state. No
renderer for the old four-tool contract is retained.
