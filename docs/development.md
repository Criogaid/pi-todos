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
running dependency lifecycle scripts. Most tests run the tool, store and overlay
against mocked Pi registration and lifecycle fixtures.
`src/persistence.integration.test.ts` also runs the pinned host's execution pipeline
and nested-call recorder, then reopens real session files to check restored state.
Tests make no model requests and do not certify every Pi release.

The checked-in dev host is `@earendil-works/pi-coding-agent@0.99.2`; the
manifest declares host-provided packages as peers with `*`, as Pi requires.
Mouse wheel scrolling in the overlay needs Pi 0.85 or later; older hosts show the
panel without it. Run a real host smoke test on your intended Pi version before
publishing. A useful smoke test is: create a list, complete one item and start
another, reload, compact, switch branches, check `/todos`, and verify that a
second `in_progress` item is rejected.

## Use the checkout in Pi

After installing dependencies in this checkout, disable any other todo provider
for the target Pi session and install the local package:

```sh
pi install .
```

Pi supports local package directories. Load one provider for the `todo` tool
and the `pi-todos` widget. Configuration is optional; see
[configuration.md](configuration.md).

## Package and distribution

The package is `@criogaid/pi-todos` and is installed from Git or a local path.
Its manifest is private, so it is not published to npm. It has no runtime
dependencies beyond the Pi host and `typebox`, which Pi provides.

## Runtime boundaries

- Lists are session-local. There is no cross-process task database, file lock
  or shared team namespace.
- Task data is persisted through Pi's custom session entries. The write completes
  before live state is replaced; durability and recovery from interrupted JSONL
  writes depend on Pi's session manager. There is no independent task database.
- Resume context is added on the next context-hook invocation and acknowledged
  by the corresponding successful assistant response. Errors or aborted
  responses preserve it for retries. Generation checks keep newer lifecycle
  events pending. There is no periodic reminder loop or guarantee that a model
  obeys task data.
- All text, UI and model-facing, is English.
