# Development

## Validate a checkout

From the repository root, with Node.js 22+ and npm 11+:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm pack --dry-run --ignore-scripts --json
git diff --check
```

`--ignore-scripts` installs dependencies without changing local Git hooks or
running dependency lifecycle scripts. Most tests run the tools, store and overlay
against mocked Pi registration and lifecycle fixtures.
`src/persistence.integration.test.ts` also runs the pinned host's execution pipeline
and nested-call recorder, then reopens real session files to check restored state.
Tests make no model requests and do not certify every Pi release.

The checked-in dev host is `@earendil-works/pi-coding-agent@0.99.2`; the
manifest declares host-provided packages as peers with `*`, as Pi requires.
Mouse wheel scrolling in the overlay needs Pi 0.85 or later; older hosts show the
panel without it. Run a real host smoke test on your intended Pi version before
publishing. A useful smoke test is: create three tasks, make one block another,
start and complete a task, delete one, then reload, compact, switch branches and
check `/tasks`; finish the list and confirm it clears when the next run starts.

## Use the checkout in Pi

After installing dependencies in this checkout, disable any other extension that
registers `TaskCreate`, `TaskGet`, `TaskList` or `TaskUpdate` for the target Pi
session, and install the local package:

```sh
pi install .
```

Pi supports local package directories. Load one provider for the task tools
and the `pi-todos` widget. Configuration is optional; see
[configuration.md](configuration.md).

## Package and distribution

The package is `@criogaid/pi-todos` and is installed from Git or a local path.
Its manifest is private, so it is not published to npm. It has no runtime
dependencies beyond the Pi host and `typebox`, which Pi provides.

## Runtime boundaries

- Lists are session-local. Unlike Claude Code, there are no task files on disk,
  no file lock and no list shared between sessions or teammates.
- Task data is persisted through Pi's custom session entries. The write completes
  before live state is replaced; durability and recovery from interrupted JSONL
  writes depend on Pi's session manager. There is no independent task database.
- Resume context is added on the next context-hook invocation and acknowledged
  by the corresponding successful assistant response. Errors or aborted
  responses preserve it for retries. Generation checks keep newer lifecycle
  events pending.
- The task reminder is computed from the session branch at the end of each
  turn; there is no timer. Nothing guarantees that a model obeys task data or
  reminders.
- All text, UI and model-facing, is English.
