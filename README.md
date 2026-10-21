# Pathlight

Show LikeC4 architecture diagrams beside an agent conversation in tmux.
LikeC4 owns the model and layout. OpenTUI renders interactive terminal nodes, groups, and connectors by default.
The viewer can show live tool activity mapped to architecture elements. It does not infer test status or runtime service traffic.

See [project intent](docs/project-intent.md) for the goals, accepted design and
scope boundaries, and [AGENTS.md](AGENTS.md) for engineering guidance.

## Set up

Use Bun 1.4.2 or later, Node.js 22 or later, tmux, and util-linux `flock` on Linux.
The OpenCode plugin targets V2 and is pinned to SDK 2.0.31.

```sh
bun install
```

Native mode needs no browser, GPU backend or terminal image protocol.
Only open trusted LikeC4 workspaces. LikeC4 can load executable JavaScript or TypeScript project configuration.

## Install as a Claude Code plugin

Put the command on your PATH once, then install the plugin from this repository:

```sh
bun install && bun link          # provides the pathlight command
claude plugin marketplace add /path/to/pathlight
claude plugin install pathlight@pathlight
```

The plugin adds the recording hooks and the `/pathlight` skill. Hooks do nothing in a project without `pathlight.activity.json`, so enabling the plugin globally is safe. Create the mapping with `pathlight init --workspace . --no-claude-hooks` (the flag keeps `init` from also writing project-local hooks, which would record every event twice).
Use either this route or the project-local route below, not both.

## Quick start (Claude Code and OpenCode)

From the project you work in, with its LikeC4 model:

```sh
bun run --cwd /path/to/pathlight pathlight init --workspace /path/to/project
```

`init` adds the Claude Code hooks to `.claude/settings.local.json` (per-user), copies the `pathlight` skill (the `/pathlight` command),
registers the OpenCode plugin, and creates `pathlight.activity.json` if absent. It maps only elements whose name matches
a directory or file that exists; review it and add globs for the rest. Re-running `init` is safe and never overwrites an existing mapping.

To reopen the viewer yourself, with no agent involved:

| Where you are | Command | Result | Inference |
| --- | --- | --- | --- |
| A shell prompt in a tmux pane | `pathlight open [VIEW]` | That pane becomes the viewer | none |
| Inside Claude Code | `/pathlight:open [VIEW]` | A viewer pane is split beside the conversation | none (a plugin hook handles it and blocks the prompt, so the model is never called) |
| Inside OpenCode | `/pathlight-open [VIEW]` | A viewer pane is split beside the conversation | none (the CLI plugin handles it) |
| Inside Claude Code or OpenCode | `! pathlight open [VIEW]` | The same split | none (a shell escape) |

`open` follows the most recent recorded session and shows `VIEW`, else the view named `index`, else the first view. Typed at a prompt it takes over that pane; run by an agent (anything between the pane's shell and the command) it splits beside it. `--here` always uses the current terminal and `--split` always splits. Without a `pathlight.activity.json` it still opens, but cannot follow an agent. The hook needs the Claude plugin; `/pathlight:open` is not installed by `pathlight init`.

Then, in tmux, run `/pathlight` in Claude Code (or `/pathlight VIEW_ID`). The viewer opens beside the conversation and
follows the most recently active recorded session with `--follow`, so you need no pane or session IDs. You can also run it yourself:

```sh
bun run pathlight show VIEW --workspace /path/to/project --follow
```

Installing the Claude hooks is the opt-in for Claude recording; remove them to stop. For OpenCode the opt-in is `record: true` on the plugin entry (what `init` writes) or a `live: true` request.
`--follow` only reads journals: it never starts recording, and it switches to whichever recorded session wrote last. A Claude subagent's calls share the conversation's session and carry a label; OpenCode child sessions are not recorded.
The header shows `LIVE source:session` with a spinner while a tool runs, the header's second row shows the latest call, and the inspector lists recent calls with their age.
Nodes show `r`/`e` counts of retained reads and edits. Press `t` to ask the agent about the selected node (typed into your agent's pane, with the component's files, connections and, if you choose, recent activity; Enter sends and submits it, Alt+Enter adds a line). Press `1`–`4` to fold inspector sections, `g` to jump to any view and `T` to choose a theme (OpenCode-format JSON themes, previewed live). Press `w` to select the node the agent is working on; when that work is in a component this view does not show, the header says "working in VIEW · w to go" and `w` goes there (a view this one links to with `navigateTo` first, else the smallest view containing it), never on its own (or click its row in the activity list), and `c` for a one-screen summary of what the session touched. Press `a` to follow the work: the viewer selects the node of the newest tool call, running or finished, and glides the camera to it. Only work that happens after you turn it on (or resume it) counts; `w` jumps to the last work done. It is off by default, never changes the view, and pauses when you select, pan or zoom (`a` resumes). Calls made inside a Claude subagent are recorded with its type (never its id or prompt) and shown with that label, for example `·Explore`; they land in the same journal as the conversation's own calls. Press `s` to hide or show them.

Press `p` to replay the session: the viewer steps through the recorded calls in order, one call per step, with the component of each step selected and the counts building up as they did. `←`/`→` step, `[`/`]` jump between turns (a turn is one prompt and the work after it), `space` plays and pauses, `s` sets the speed, `esc` returns to live. Replay covers what the journal retained (the last 2048 events of a session) and only the calls, never the prompts.

## Open a diagram

Inside tmux, list the example diagrams, then show one:

```sh
bun run pathlight list --workspace examples/parcel
bun run pathlight show services --workspace examples/parcel
```

Select nodes with the mouse, Tab, or `h` `j` `k` `l`, which move to the nearest node in that direction. Arrow keys pan the Three camera (press `v` to swap the two). Connections are orthogonal thin lines with rounded bends. Press `/` to search the current view by name or ID.
The selected node's connections are solid, cyan for incoming and amber for outgoing; the rest are dotted. Scroll over the relationship details to read long labels.
Press `e` to browse the selected node's mapped files, then Enter to open one in your external editor.
Set `VISUAL` or `EDITOR` before starting the viewer. File browsing does not require live recording.
Enter selects a group's first child or opens a leaf's linked view. Press `o` to open a group's linked view, `b` for view history, or Backspace for the parent group.
Use `f` to fit, `r` to center the selection, and `q` to quit. Press `i` to show or hide the inspector (docked from 120 columns, an overlay below that; under 80 columns the nodes are a list) or `?` for help. The diagram refits on resize until you pan or zoom; `f` fits again. Set `PATHLIGHT_COLORS=256` if your terminal lacks 24-bit colour and is not detected. Ctrl+C quits even while search is active.
See [native viewer controls and limits](docs/native-viewer.md) for search, activity, and navigation details.

To run in the current terminal instead of opening a pane:

```sh
bun run pathlight view services --workspace examples/parcel
```

## Scan a codebase

`pathlight scan --workspace . --out scan.json` reads the TypeScript and JavaScript source statically and writes the files, the imports between them, the packages they use, and what it could not read. It is a fact sheet for an agent (or you) drafting a LikeC4 model of a codebase that has none; it never writes the model itself. See [scan format](docs/scan.md).

The `pathlight` skill (`plugins/claude/skills/pathlight/SKILL.md`) teaches an agent this workflow: scan, draft the model and mapping, check until clean, show. The Claude plugin ships it, and `pathlight init` copies it into the workspace (`.claude/skills/pathlight`, or `.agents/skills/pathlight` with `--no-claude-hooks`); OpenCode documents reading both locations.

`pathlight check --workspace .` compares that scan with your LikeC4 model and `pathlight.activity.json`: mapping globs that match no files, source files no mapping claims, relationships with no import between their mapped files, and imports between elements that no relationship declares. These are questions, not verdicts (a relationship can run over a network call that no import shows); `--json` gives the same facts as data and `--strict` exits 1 when anything is found.

## Outside tmux

Use `--pane %ID` to choose the parent pane explicitly (run `tmux display-message -p '#{pane_id}'` in it), and `--socket PATH` for a non-default tmux server.
Use `--project NAME` when multiple projects have the same view ID.

## Use from OpenCode

Targets OpenCode V2 (verified against 2.0.32). `pathlight init` registers `plugins/opencode` in the workspace's `opencode.json` with `"options": { "record": true }`; restart the OpenCode service after adding it.
The plugin has two halves, both loaded from that one entry:

- **Server plugin** (`plugins/opencode/index.ts`): records tool calls through OpenCode's `tool.hook` events, offers the `pathlight` skill to the agent (unless the workspace already has one), and provides the `pathlight_list`, `pathlight_show` and `pathlight_stop` tools.
- **CLI plugin** (`plugins/opencode/tui.ts`): runs in your terminal process, the only place that knows your real tmux pane, and adds the slash commands below.

| In OpenCode (inside tmux) | Claude Code equivalent | What it does |
| --- | --- | --- |
| `/pathlight-open [VIEW]` (also `/pathlight:open`) | `/pathlight:open [VIEW]` | Splits the viewer beside the conversation and follows the newest recorded session. No model turn. |
| `/pathlight [VIEW]` | `/pathlight [VIEW]` | Asks the agent to use the pathlight skill (draft, check, show), telling it your pane and tmux socket so it passes `--pane`. |
| `! pathlight open [VIEW]` | the same | Shell escape. |

Recording: with `record: true` every root session in the workspace is recorded without a request, the counterpart of installing the Claude hooks. Subagent sessions and sessions in other workspaces are never recorded, and `pathlight_stop` stops one session. Without the option, recording starts only when an agent calls `pathlight_show` with `live: true`.
Each tool requests permission before loading a workspace or opening a pane. `pathlight_show` needs an explicit pane (`%2`) because OpenCode's background service may not share your terminal's environment; the slash commands supply it for you.
It uses the plugin location as the workspace and passes only identifiers to the CLI, not diagram geometry through model context. A new `show` request reuses the owned viewer pane and resets the view, selection, and scroll position.

OpenCode status: `tests/opencode-live.test.ts` runs the real OpenCode binary (`--standalone`, isolated config) against a fake OpenAI-compatible model: its hooks record a plain session, `/pathlight-open` opens a viewer bound to it, and the skill reaches the model. `tests/opencode-plugin.test.ts` covers the permission, `live`, `record` and `stop` rules against a stubbed context. The `/pathlight` command's model turn (that an agent follows the skill with a real model) is not covered, and tool names and arguments from providers other than the built-in ones are unverified.

## Observe live activity

Place `pathlight.activity.json` in the agent's workspace. This repository includes a mapping to its own `viewer` LikeC4 project.
Mappings use workspace-relative path globs and exact LikeC4 element IDs:

```json
{
  "version": 1,
  "project": "my-project",
  "mappings": [{ "glob": "services/payments/**", "element": "platform.payments" }],
  "ignore": ["tests/**", "vendor/**"],
  "shared": ["platform.types"]
}
```

`ignore` lists files deliberately outside the model, and `shared` lists elements anything may import (so `pathlight check` expects no relationship to them). Only `check` reads either.

In OpenCode with `record: true`, just run `/pathlight-open live`. Without it, ask the agent to show the `viewer` project's `live` view with `live: true` and your current pane ID.
The plugin binds the panel to the session. It records that session's subsequent tool starts, completions, and failures automatically.
Call `pathlight.stop` to stop recording. Closing the viewer alone does not stop recording.
Plugin reloads stop recording; call `show` with `live: true` again to resume.
Subagent sessions are separate and are not automatically included.

The inspector groups recent mapped calls by component (up to four components, three rows each; repeats collapse to `×N`) and lists edits to files no component claims under `not in the model` (files in the mapping's `ignore` list are skipped). Calls that name no file (a subagent launch, a search) are recorded but not shown, and reads of unclaimed files are left out.
Native nodes also show active READ or EDIT labels, followed by DONE or FAILED for five seconds. Groups display their own mapped activity in their title.
The layout stays fixed as activity arrives.
In the header line a call on a file no component claims shows without a component. Long-running calls become `unconfirmed` after 30 seconds without an outcome.
This is an observation-age indicator, not proof that the agent disconnected or the tool stopped.
Selection, pan and zoom remain unchanged as activity arrives. Reopening the viewer reads retained activity.

For Claude Code, `pathlight init` installs these hooks. To do it by hand, copy the hooks from `plugins/claude/hooks.example.json` into your project settings and replace the absolute plugin path.
Merge the hooks with existing settings; do not replace unrelated configuration.
The hook runs asynchronously and exits successfully even if observation fails.
The adapter accepts `PreToolUse`, `PostToolUse`, and `PostToolUseFailure`; it has been tested with hook payloads, not an interactive Claude session.
With the Claude session ID, open a bound viewer:

```sh
bun run pathlight show VIEW --workspace /path/to/project --project PROJECT --pane %ID --source claude --session SESSION_ID
```

Only tool names, call/session IDs, workspace-relative paths, operation categories, timestamps, and lifecycle states are retained.
Tool arguments, command strings, source contents, tool results, and error text are not stored.
Records live under `.cache/pathlight/activity` in directories created with private permissions.
Each source/session retains at most 256 event files after writers settle; readers reduce these to the latest 128 calls.
The OpenCode observer uses a bounded 128-event queue and supports eight opted-in sessions per plugin instance.
Collection is best-effort: overload or disk failures may lose events, and old history is pruned. It is not an audit log.
All activity remains local. No background service or network endpoint is installed.

## Verify changes

```sh
bun run check
bun run test
```

They exercise the real CLI, native interaction, and isolated tmux servers; the file-browser test needs Neovim.
They cover pane reuse, protecting a repurposed pane, zoom, fit, quit and activity isolation. Appearance still needs a check in your actual terminal.

Per-request readiness files remain under the selected workspace's `.cache/pathlight` directory. Close viewers before removing old cache directories.
Concurrent requests for the same parent pane and workspace return a busy error. Retry after the active request finishes.
