# pi-todos

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A session task system for [Pi](https://github.com/earendil-works/pi). The model
keeps requirements, current progress, and dependencies in one plan. You inspect
the same plan through a panel above the editor or `/tasks`.

`TaskWrite` applies an ordered batch atomically. `TaskRead` returns bounded
summaries or complete selected tasks. Every change saves one branch snapshot
before publishing live state; reads and net no-ops save nothing. Tasks survive
reload, compaction, and branch navigation, including writes inside codemode.

## Install

```sh
pi install git:github.com/Criogaid/pi-todos
```

Start a new session. This contract has **no backward compatibility**: old task
tools, argument aliases, snapshots, and removed configuration keys are rejected.
There are no import or conversion handlers. Existing session files are not
rewritten or deleted. Use configuration conforming to the
[new schema](docs/configuration.md) or omit the configuration file.

For a local checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
pi install .
```

The private package `@criogaid/pi-todos` is distributed through Git or a local
path. Runtime packages are supplied by Pi; no new runtime dependency is required.

## Use the plan

Ask the model to track work whose requirements or progress would otherwise be
lost. Initial planning can create several tasks in one call:

```json
{
  "operations": [
    { "action": "create", "task": { "subject": "Reproduce the failure", "description": "Find a failing input and retain it as a regression check", "status": "in_progress" } },
    { "action": "create", "task": { "subject": "Implement the fix", "description": "Preserve supported behavior and pass the regression check" } }
  ]
}
```

The result returns assigned IDs. Complete one task and start another in the same
`TaskWrite` call:

```json
{
  "operations": [
    { "action": "update", "id": "1", "set": { "status": "completed", "progress": "Regression reproduced" } },
    { "action": "update", "id": "2", "set": { "status": "in_progress", "dependsOn": ["1"] } }
  ]
}
```

Keep requirements in `description` and the latest checkpoint in `progress`.
Supplied fields replace their values; omitted fields stay unchanged. `null`
clears an optional field. `dependsOn: []` removes dependencies, and an explicit
`delete` operation removes a task and references to it. IDs referenced in a batch
must exist before that batch. Missing IDs or invalid final dependencies reject
all operations. There is no enforced scheduling or single-active-task rule.

`TaskRead({})` shows unfinished work. Use `{"scope":"all"}` to include completed
tasks, or `{"view":"details","ids":["1","2"]}` for full records. Follow
`nextAfterId` or `nextIds` to inspect omitted records. Write results already
include a bounded active summary and a next-ready suggestion when available.

## Continuity and inspection

Direct TaskWrite results carry the current active summary. For writes inside
codemode or another wrapper, return or print the write result to retain that
summary in the conversation; use TaskRead if the wrapper omitted it.

When `taskContext` is enabled, requests receive a bounded view of tasks carried
over from before the visible conversation, such as after compaction. The view
uses the last snapshot before the first write whose direct or outer tool result
is still visible. Pi's nested call IDs identify the owning wrapper even when its
diagnostic call list is incomplete. The view sits after the last compaction
summary, or first when there is none, and stays fixed while new messages are
appended, preserving the shared prefix.
In-progress tasks include requirements and progress; pending tasks use summaries.
Shortened fields and omissions are disclosed. There are no periodic reminders or
stored reminder messages.

Completed tasks remain readable and can be reopened. A completed-only plan hides
the panel; `/tasks` still shows it. Starting another run never clears tasks.
Metadata has no hidden-task semantics. Child and headless sessions have separate
state and do not control the foreground panel.

Press `ctrl+shift+t` to collapse or expand the panel. Long lists have a scrolling
window; Pi's tool-output expansion shows the full list. `/tasks` prints all tasks
grouped by status. See [display behavior](docs/overlay.md).

## Configuration and limits

The optional config file is `~/.config/pi-todos/config.json`, or
`$XDG_CONFIG_HOME/pi-todos/config.json` when XDG_CONFIG_HOME is an absolute path:

```json
{
  "taskContext": true,
  "maxWidgetLines": 8,
  "collapseKey": "alt+t"
}
```

Reload after editing. Missing fields use defaults; malformed JSON, unknown keys,
and invalid values stop loading. The extension never rewrites the config file.
See [configuration](docs/configuration.md) for defaults and guidance overrides.

Input limits and output budgets have one owner, [`LIMITS`](src/schema.ts).
[The tool reference](docs/tool-schema.md#bounds) documents those values and
continuation behavior. Change both together when adjusting the contract.
Programmatic arrays must have an element at every index and no extra enumerable
string keys; invalid inputs are rejected before any task changes are saved.

## Development and requirements

Use Node.js 22.19+ and npm 11+. The development host is pinned to Pi 0.99.2;
the installed Pi 1.3.0 execution pipeline and codemode sandbox are also exercised in the
[validation record](docs/validation.md). There are no older-host fallback paths.
The panel requires terminal UI; headless sessions retain task functionality.
Do not load another extension registering the same tool names.

```sh
npm run check
npm test
npm pack --dry-run --ignore-scripts --json
git diff --check
```

See [development](docs/development.md) for module ownership, isolated test
fixtures, and testing another installed host. Live model compliance and billed
token costs require a separate provider evaluation; local tests do not prove them.

## License

MIT — see [LICENSE](LICENSE).
