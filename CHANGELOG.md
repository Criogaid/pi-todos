# Changelog

All notable changes to `@criogaid/pi-todos` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Breaking:** the `todo` tool is replaced by Claude Code's task tools: `TaskCreate`, `TaskGet`, `TaskList` and `TaskUpdate`. Tasks have sequential ids that are never reused; `TaskUpdate` changes only the fields it names, adds two-way `blocks`/`blockedBy` edges, merges `metadata` and deletes a task with `status: "deleted"`. Tool descriptions and the text the model reads back follow Claude Code. Any number of tasks may be `in_progress`, and the 100-item limit is gone.
- **Breaking:** lists saved by the `todo` tool are not restored. Task lists are saved as `pi-todos-tasks` session entries.
- **Breaking:** `/todos` is renamed `/tasks`.
- **Breaking:** `guidance` in the config file is keyed by tool name (`{"guidance": {"TaskCreate": {...}}}`).
- The overlay heading reads `Tasks (done/total)`, and rows show task ids, owners and open blockers. Tasks with `metadata._internal: true` are hidden.
- A finished list is cleared when the next agent run starts, keeping the id counter, instead of being hidden.
- The resume summary lists task ids and open blockers.

### Added

- Tool results carry `structuredContent` and declare an `outputSchema`, so `codemode` scripts receive structured output such as a new task's id.
- Argument repair for `id`/`task_id` → `taskId`, `active_form` → `activeForm`, and ids written as numbers or with a leading `#`.
- Claude Code's task reminder: a hidden message after 10 turns without `TaskCreate` or `TaskUpdate`. Disable it with `"taskReminder": false`.

## [0.1.0] - 2026-10-08

First release.

### Added

- `todo` tool. Each call sends the complete, ordered list as `todos: [{ content, status, activeForm? }]` and replaces the previous one. At most one item may be `in_progress`; at most 100 items. Results store `details: { todos }`.
- Lists are restored from the session branch on session start, compaction and tree navigation; corrupt or failed snapshots never override the last valid list. Historical tool calls render from their own saved list.
- Live overlay above the editor. The heading counts the whole list; a finished list is dismissed at the start of the next turn.
- Overlays that overflow `maxWidgetLines` render a window over the full list with a `↑ N above · ↓ N below` footer. A changed list opens the window at the `in_progress` item (else the first unfinished one); the mouse wheel scrolls it in Pi's fullscreen renderer on Pi 0.85 or later.
- `/todos` command printing the full list grouped by status, and a collapse shortcut (`ctrl+shift+t` by default).
- One bounded unfinished-item summary in model context after session restore, compaction or branch navigation (`resumeContext`, on by default).
- Optional `pi-todos/config.json` with `maxWidgetLines`, `collapseKey`, `resumeContext` and `guidance`; read once when the extension loads.
