# Changelog

All notable changes to `@criogaid/pi-todos` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Breaking:** replace TaskCreate, TaskGet, TaskList, and TaskUpdate with TaskRead and atomic batched TaskWrite. No aliases or argument repair remain.
- **Breaking:** store only `dependsOn`; derive current blockers. Reject missing references, self-dependencies, and final cycles. Arrays and metadata use whole-field replacement; null clears optional fields.
- **Breaking:** snapshot format 2 is the only supported format. Unsupported or malformed task snapshots block task access rather than falling back. Existing session files are not converted or rewritten.
- **Breaking:** replace resumeContext and taskReminder with taskContext. Configuration rejects unknown fields, removed keys, and malformed values instead of applying fallback defaults.
- Requirements and latest progress have separate fields. Every write returns final-state feedback, while reads paginate bounded summaries or complete details.
- Completed tasks stay readable and reopenable; the panel hides completed-only plans. Remove automatic clearing and metadata-based hiding.
- Replace one-shot resume summaries and periodic reminders with a bounded view of carried-over unfinished tasks, added only while the snapshot behind it is hidden (for example after compaction). The view is fixed in place, so it never breaks the prompt-cache prefix; visible TaskWrite results already carry the current summary.
- No-op writes save nothing; a failed batch changes nothing. Nested writes use the same commit path.
- Remove the older-host MouseRegion fallback. Prewarm UI modules only after a foreground session starts.
- Add execution-pipeline tests that can target an installed Pi host without changing checkout dependencies.
- Require Node.js 22.19 or newer.

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
