# Configuration

The extension reads one optional JSON file when it loads. `$XDG_CONFIG_HOME`
selects the directory when it is an absolute path; `~` and a leading `~/` expand
to the user's home. Otherwise the directory is `~/.config`. The file beneath it
is `pi-todos/config.json`. A valid XDG directory never falls through to the home
config, even if its file is absent.

A missing file or omitted field uses its default. Malformed JSON, unknown keys,
wrong types, and invalid values prevent loading and identify the field or file.
No configuration is repaired, translated, ignored, or rewritten. Run `/reload`
after editing. `resumeContext`, `taskReminder`, and guidance entries for the old
four tools are unsupported.

## Settings

Defaults are defined in [`config.ts`](../src/config.ts); change this table and
that schema together.

| Field | Rule | Default |
| --- | --- | --- |
| `taskContext` | Boolean. When the snapshot behind the conversation's starting task state is no longer visible (for example after compaction), add a fixed view of that carried-over unfinished work to provider requests. | `true` |
| `maxWidgetLines` | Integer of at least 3. Panel content rows including heading and overflow footer; the blank spacer is extra. | `12` |
| `collapseKey` | Lowercase Pi key specification, or `"off"` to disable the shortcut. | `"ctrl+shift+t"` |
| `guidance` | Optional overrides keyed only by `TaskRead` and `TaskWrite`. | Built-in guidance |

```json
{
  "taskContext": true,
  "maxWidgetLines": 8,
  "collapseKey": "alt+o",
  "guidance": {
    "TaskWrite": {
      "promptGuidelines": [
        "Keep requirements and progress current; complete work only after verification."
      ]
    }
  }
}
```

## Collapse key

Use distinct modifiers (`ctrl`, `shift`, `alt`, `super`) joined by `+`, followed
by one printable key or a named key. Supported named keys are `escape`, `esc`,
`enter`, `return`, `tab`, `space`, `backspace`, `delete`, `insert`, `clear`,
`home`, `end`, `pageup`, `pagedown`, `up`, `down`, `left`, `right`, and `f1`–`f12`.

Examples: `ctrl+]`, `alt+o`, `super+alt+f5`. Values are not trimmed or lowercased.
Typos such as `ctr+]` fail validation instead of capturing an unintended key.

## Guidance

Each tool entry accepts `description`, `promptSnippet`, and `promptGuidelines`.
Strings must be nonempty. Guidelines are an array of nonempty strings; an empty
array deliberately removes that tool's built-in guideline bullets. Each supplied
field replaces the corresponding built-in field. Unknown tool names and fields
are rejected. Guidance changes wording, not schemas or execution rules.

## Task context

The view is rebuilt at the `context` hook from the session's current state.
In-progress tasks appear first with requirements and progress, followed by
pending summaries. Metadata and completed tasks are excluded. Quoted text is
explicitly task data; the user's current instructions take precedence.

Limits live in [`LIMITS`](../src/schema.ts) and are documented in
[tool bounds](tool-schema.md#bounds). `truncatedFields` identifies shortened
requirements or progress; the footer counts omitted tasks and directs the model
to TaskRead. No response acknowledges the view away. Nothing is persisted or
injected when no unfinished tasks remain. This policy has a recurring input
cost; disabling it does not alter task storage or tool results.
