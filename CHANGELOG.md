# Changelog

All notable changes to `@criogaid/pi-todos` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
