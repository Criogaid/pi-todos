# pi-todos

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Give the model a task list you can see. `pi-todos` adds a `todo` tool, a
`/todos` command, and a live panel above the editor to
[Pi Agent](https://github.com/badlogic/pi-mono), so you always know what the
agent is doing now, what it finished, and what is queued. The list is rebuilt
from the conversation itself, so it survives `/reload` and compaction — useful
on long research → design → implement sessions.

## Install

```sh
pi install git:github.com/Criogaid/pi-todos
```

Restart your Pi session.

For local development, install dependencies in the clone and load it directly:

```sh
cd pi-todos
npm ci
pi install .
```

The package is maintained as `@criogaid/pi-todos` and installed from Git or a local
path. It has no runtime dependencies beyond what the Pi host provides.

## Quick start

Run `/todos` after the restart to confirm the extension is loaded. On a fresh
session it prints:

```
No todos yet. Ask the agent to add some!
```

Then ask for something with several steps — "add a repository layer with tests,
and track it as todos". The model calls `todo` and the panel appears above your
input box, updating as work moves:

```
● Todos (2/5)
├─ ✓ Create DemoTodo domain entity
├─ ✓ Create IDemoTodoRepository interface
├─ ◐ Create DemoTodoRepository (creating the repository)
├─ ○ Register DI bindings
└─ ○ Add integration tests
```

Press `ctrl+shift+t` to collapse the panel to its heading plus a one-line hint,
and again to expand it. Run `/todos` at any time to print the full list grouped
by status.

## What you get

- **The plan stays on screen.** A panel above the editor shows every item with a
  status glyph, the label of whatever is in progress, and a `Todos (done/total)`
  heading — you never have to ask the agent where it is.
- **One simple contract for the model.** Each `todo` call sends the complete,
  ordered list and replaces the previous one. There are no ids, partial updates
  or dependency graphs to get wrong; at most one item is `in_progress`.
- **The list survives `/reload` and compaction.** Every result carries the full
  list, and the latest one on the session branch is restored. Moving around the
  session tree restores the list as it was at that point.
- **The transcript stays truthful.** Each historical `todo` call renders from its
  own saved list, so old entries keep showing what the list was then.
- **Resume with the current list in context.** After session restore, compaction
  or branch navigation, the next model call receives one bounded summary of
  unfinished items.
- **Finished work gets out of the way.** A fully completed list stays visible for
  the rest of the turn, then the panel disappears at the start of the next one.
- **The overlay never eats your terminal.** Past the row budget the list
  becomes a window that follows the item in progress, with a
  `↑ N above · ↓ N below` footer; turn the mouse wheel over it to scroll
  (Pi 0.85+, fullscreen renderer) or expand it with Pi's tool-output expansion.
- **Parallel sessions stay separate.** Lists are keyed by session, so a detached
  or child session can neither read nor overwrite the foreground list.

## Configuration

Optional. Create `~/.config/pi-todos/config.json` (or
`$XDG_CONFIG_HOME/pi-todos/config.json` if you set that variable):

```json
{
  "maxWidgetLines": 8,
  "collapseKey": "alt+t"
}
```

| Setting | What it does | Default |
| --- | --- | --- |
| `maxWidgetLines` | Rows the overlay may use, heading included; on overflow one row is the position footer and the rest is a scrollable window. Integer, minimum `3`. Pi's tool-output expansion mode shows all items. | `12` |
| `collapseKey` | Key that collapses and expands the panel, in Pi keybinding form (`alt+o`, `ctrl+shift+t`). Set `"off"` to register no shortcut. | `"ctrl+shift+t"` |
| `resumeContext` | Adds one bounded unfinished-item summary after restore, compaction or branch navigation. | `true` |
| `guidance` | Replaces the tool description and the instructions the extension gives the model about when and how to use the todo list. | _(built-ins)_ |

Settings are read when Pi loads the extension; run `/reload` after editing the
file. A missing or malformed file falls back to these defaults. `pi-todos` only
reads this file — it never writes one. Full semantics:
[Configuration](docs/configuration.md).

## Reference

- [`todo` tool reference](docs/tool-schema.md)
  — parameters, validation rules, the response and persistence.
- [Configuration](docs/configuration.md)
  — config file resolution, option validation rules, and the accepted keybinding
  grammar.
- [Overlay and `/todos`](docs/overlay.md)
  — overlay lifecycle, glyphs, overflow behavior and `/todos` output.
- [Development](docs/development.md)
  — validation commands, loading a checkout in Pi and runtime boundaries.

## Requirements

- A Pi Agent host. No API key, no model selection, no native dependencies.
- An interactive session for the panel and `/todos`. Headless runs still get the
  `todo` tool; nothing is rendered.
- English only.

## Development

Use Node.js 22 or newer and npm 11 or newer. Run:

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

Production TypeScript lives in `src/`, with tests beside the code they
exercise. Pi loads `src/index.ts` through the package manifest. `docs/` contains
reference documentation.
`test/helpers/` contains the shared test fixtures;
`test/setup.ts` isolates configuration files and resets the todo store between
tests. `test/ship-manifest.test.ts` checks package coverage. Tests, test helpers,
and development configuration are excluded from the installable package.

## License

MIT — see [LICENSE](LICENSE).
