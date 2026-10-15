# Replacement validation

The baseline is commit `1dae76e8102e7e75ba141163595b9cf3e7630fbd`.
Its type/lint checks and 395 tests passed before replacement. The new suite
removes assertions for deliberately removed behavior and adds checks for the
new contract; test totals are not a measure of coverage equivalence.

## Executed checks

Local execution uses Node.js 26.11.1 and TypeBox 1.3.27.

| Check | Result |
| --- | --- |
| Formatter, lint, and TypeScript | Passed |
| New unit and integration suite on the pinned Pi 0.99.2 dependencies | Passed: 173 tests in 16 files |
| Selected execution-pipeline suite on installed Pi 1.2.0 | Passed: 9 tests |
| Package dry-run | Passed: 23 entries; runtime modules and references included, test files excluded; nothing published |

The installed-host run uses that host's SessionManager, wrapper, nested runner,
and agent-core execution pipeline. It covers direct and concurrent nested
writes, structured results, raw numeric-ID rejection, removed tool names,
argument rejection, batch rollback, no-op storage, omitted wrapper diagnostics,
deletion cleanup, completed-task retention, branching, compaction, and session
isolation. The progress/clear-fields case checks that host normalization preserves
status and optional-field semantics.

Other regressions cover final-graph validation, no partial publication, write
failure, strict configuration, unsupported snapshots, immutable read results,
combining-character input limits, explicit undefined values, quoted bounded
context, foreground/child separation, and terminal sanitization.

The continuity probe invokes the context hook, completes a non-task tool round
trip, and invokes it again. Requirements and progress remain present. It verifies
request-context assembly, not whether a real model follows that information.

## Local workflow and input footprint

Reproduce the synthetic workflow with `PI_TODOS_REPORT_COST=1` and:

```sh
npm test -- test/workflow-evaluation.test.ts --silent=false --reporter=verbose
```

The fixture creates five tasks, then completes one and starts another. It runs
seven operations through two tool calls and writes two snapshots. The old
single-operation tools would require seven tool calls for those same operations;
those calls could still share a model response. This comparison does not imply
five fewer provider requests.

| Measured quantity | UTF-16 characters |
| --- | ---: |
| Serialized two-tool declarations, including schemas and guidance | 4,092 |
| Initial current-task view | 740 |
| View after handing off to the next task | 709 |
| Repeating that unchanged view for 100 provider requests | 70,900 |

The last row is a repeated-input scenario, not billed tokens. The old one-shot
resume policy could stop contributing task context after one successful
response; the new policy deliberately pays recurring input for continuity.
Tokenization, cache behavior, provider serialization, model compliance, and the
number of real requests were not measured. No live-provider savings claim is
made. The hard per-request context bound remains documented in
[the tool reference](tool-schema.md#bounds).

## Not executed

No live model requests, paid provider evaluation, interactive terminal smoke
session, package installation into personal Pi settings, push, or publication
was performed. The implementation is locally verified; these results do not
certify every host, model, or terminal. Release evaluation should measure task
correctness and actual input/cache usage on the intended provider.
