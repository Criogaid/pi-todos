# Development

## Checks

Use Node.js 22.19+ and npm 11+ from the repository root:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run format
npm run check
npm test
npm pack --dry-run --ignore-scripts --json
git diff --check
```

Tests make no model requests. `test/setup.ts` isolates HOME and USERPROFILE,
removes inherited Pi/XDG configuration locations, and cleans its temporary home.
Real session tests use their own temporary session directory. Never point
fixtures at personal configuration or existing sessions.

The default development host is pinned to Pi 0.99.2. The persistence integration
suite exercises its argument preparation, execution pipeline, nested-call
recorder, session files, branch navigation, and compaction. To run the same suite
against another installed host, set `PI_TODOS_TEST_HOST_ROOT` to that host's
package directory (the directory containing its package.json), then run:

```sh
npm test -- src/persistence.integration.test.ts
```

The test resolves that package's SessionManager, wrapper, nested runner, and
agent execution pipeline. Tool implementation imports and UI fixtures still use
the checkout's dependencies. This probes the selected execution pipeline; it is
not a complete interactive UI or live-provider certification. See the
[validation record](validation.md).

## Local installation

Install the checkout with `pi install .`, then start a new session. Disable any
other extension registering TaskRead or TaskWrite. Use only the new
[configuration](configuration.md). The extension deliberately rejects old task
snapshots; no test or installation step converts existing sessions.

The package is private and distributed through Git or a local path. No runtime
dependencies are bundled beyond the host-provided peers. `npm pack --dry-run`
checks packaging without publishing anything.

## Ownership and invariants

| Owner | Responsibility |
| --- | --- |
| `src/schema.ts` | Input/result schemas, derived types, limits, raw-input validation, and task errors. |
| `src/model.ts` | Immutable batch evaluation, graph validation, status/dependency semantics, and bounded selectors. |
| `src/persistence.ts` | One snapshot format; strict branch restoration, never conversion or fallback. |
| `src/store.ts` | Session-keyed live state, restoration-failure state, and foreground selection. |
| `src/tool.ts` | Two tool registrations, persist-before-publish commit, result adaptation, and `/tasks`. |
| `src/context.ts` | Bounded current-state projection on every context hook. No persistent state. |
| `src/index.ts` | Configuration and lifecycle wiring; UI resource cleanup. |
| `src/config.ts` | One strict configuration schema and resolved defaults. |
| `src/format.ts`, `src/sanitize.ts`, `src/overlay.ts` | Terminal presentation of task facts. |
| `src/host.ts`, `src/overlay-loader.ts` | Host lifecycle and module-loading error boundaries. |

Only a committed TaskWrite or branch restoration replaces live task state.
No await occurs between evaluating a batch, appending its snapshot, and
publishing it, so nested writes cannot interleave those steps. Pi owns JSONL
write durability. A persistence error may leave an uncertain durable outcome;
reload before retrying creates. There is no exactly-once protocol.

Raw tool arguments are validated before Pi's coercion. The host then supplies
typed input to execute. Snapshot decoding validates the new format and graph.
Downstream selectors trust these boundaries. Metadata is JSON data, never a
carrier for private visibility or execution rules.

When changing the contract, update schemas, consumers, tests, README, and the
relevant reference together. Remove replaced paths in the same change. New
snapshot versions do not imply support for reading older versions.

## Behavioral evaluation

Unit and integration tests establish task semantics, isolation, and restoration.
The two-request recovery probe includes a successful non-task tool round trip;
requirements and progress must still appear in the next request's context.

A live provider evaluation should use a fixed model and repeated workflows,
record actual requests and token/cache-read usage, and distinguish task-only
requests from substantive work. Message or tool-call counts alone are not billing
data. Do not claim cost reduction or improved model compliance from local tests.
The bounded view adds recurring input while tasks remain active.
