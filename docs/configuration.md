# Configuration reference

Every option
[`pi-todos`](https://github.com/Criogaid/pi-todos)
reads, where the file lives, and exactly what happens when a value is wrong.

## Where the file lives

The config file is optional. It is read from exactly one place:

- `$XDG_CONFIG_HOME/pi-todos/config.json` when `XDG_CONFIG_HOME` is set to an
  absolute path (a bare `~` or a leading `~/` is expanded first);
- otherwise `~/.config/pi-todos/config.json`. An empty, whitespace-only,
  relative or `~user` value of `XDG_CONFIG_HOME` is ignored.

No file means every default applies. Malformed JSON prints a
`[pi-todos] invalid config at ...` warning and the defaults apply. A JSON array
or a non-object value is treated as `{}` without a warning. Unknown keys are
ignored.

`pi-todos` never writes this file. You create and edit it yourself, and the
extension only reads it.

## Example

```json
{
  "maxWidgetLines": 8,
  "collapseKey": "alt+t",
  "resumeContext": true,
  "guidance": {
    "promptSnippet": "Use the `todo` tool to track multi-step work before starting it.",
    "promptGuidelines": [
      "Send the complete list on every call.",
      "Mark an item in_progress while working on it; completed when done."
    ]
  }
}
```

## When settings apply

Every option is read **once, when Pi loads the extension**. Run `/reload` after
editing the file. Reading once keeps the bound shortcut, the hint that names it
and the overlay budget consistent with each other.

## `maxWidgetLines`

**Default `12`.** The content-row budget for the overlay — the heading row and,
on overflow, the position footer row both count against it; the remaining rows
form the scrollable window. Only the trailing blank spacer sits outside the
budget, so `12` renders up to 13 terminal rows.

- Must be an integer of at least `3`; anything else falls back to the default.
- No ceiling.
- Pi's tool-output expansion mode (`ctrl+o` by default) temporarily overrides
  this budget and shows every item; collapsing restores the configured budget.

## `collapseKey`

**Default `"ctrl+shift+t"`.** The shortcut that collapses and expands the
overlay.

The value is trimmed and lowercased, then matched against Pi's keybinding
grammar: zero or more distinct modifiers joined by `+`, then a base key.

| Part | Accepted |
| --- | --- |
| Modifiers | `ctrl`, `shift`, `alt`, `super` — each at most once |
| Base key | one printable character (`a`, `7`, `]`, `/`, …) |
| Base key | a named key: `escape`, `esc`, `enter`, `return`, `tab`, `space`, `backspace`, `delete`, `insert`, `clear`, `home`, `end`, `pageup`, `pagedown`, `up`, `down`, `left`, `right`, `f1`–`f12` |

Examples: `alt+o`, `ctrl+shift+t`, `super+alt+f5`.

- A missing, empty, blank, non-string, or ungrammatical value falls back to the
  default. The grammar is checked strictly on purpose: Pi takes the last `+`-part
  as the base key and ignores unknown parts, so a typo like `ctr+]` would
  otherwise capture every bare `]` keypress globally.
- `"off"` disables the feature — no shortcut is registered at all.

## Guidance

`guidance.description`, `guidance.promptSnippet` (strings) and
`guidance.promptGuidelines` (array of strings) replace the tool description and
prompt copy the `todo` tool advertises to the model. All are absent by default,
in which case the built-in text is used.

- `description` and `promptSnippet` must be non-empty strings; an empty string or
  a wrong type falls back to the default.
- `promptGuidelines` must be a non-empty array of non-empty strings. A non-array,
  or an array containing an empty string, falls back to the default — the array
  is all-or-nothing, not merged item by item.
- Custom guidance should describe the full-list replacement model; calls in
  any other shape fail schema validation.

## `resumeContext`

Defaults to `true`; only boolean `false` disables it. After `session_start`,
`session_compact` or `session_tree`, the next model-context hook for that
session adds one summary of unfinished items. It is transient context, not
another stored transcript entry, and also runs during a continuation immediately
after auto-compaction. No summary is added for an empty or fully completed list.

A successful assistant response acknowledges the summary. Error or aborted
responses keep it so a session-level retry receives it again. A later lifecycle
event creates a new generation that an earlier request cannot acknowledge.

Summaries contain at most 20 unfinished items and 6,000 UTF-16 characters; each
item's content is limited to 160 Unicode code points. The footer states how many
unfinished items were omitted and how many completed items exist, so the model
knows to keep them when it resends the list. Saved text is quoted as data, and
current user instructions take precedence.

## Environment variables

| Variable | Effect |
| --- | --- |
| `XDG_CONFIG_HOME` | Relocates the config directory, as described above. |
| `HOME` | Anchors `~/.config` when `XDG_CONFIG_HOME` does not apply. |

`pi-todos` reads no other environment variables.
