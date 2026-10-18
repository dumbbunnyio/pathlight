# Visualize work

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

Native mode needs no browser installation or terminal image protocol, only a working OpenTUI/Three (WebGPU) backend.
Only open trusted LikeC4 workspaces. LikeC4 can load executable JavaScript or TypeScript project configuration.

## Quick start (Claude Code and OpenCode)

From the project you work in, with its LikeC4 model:

```sh
bun run --cwd /path/to/visualize-work c4view init --workspace /path/to/project
```

`init` adds the Claude Code hooks to `.claude/settings.local.json` (per-user), writes a `/c4view` slash command,
registers the OpenCode plugin, and creates `c4view.activity.json` if absent. It maps only elements whose name matches
a directory or file that exists; review it and add globs for the rest. Re-running `init` is safe and never overwrites an existing mapping.

Then, in tmux, run `/c4view` in Claude Code (or `/c4view VIEW_ID`). The viewer opens beside the conversation and
follows the most recently active recorded session with `--follow`, so you need no pane or session IDs. You can also run it yourself:

```sh
bun run c4view show VIEW --workspace /path/to/project --follow
```

Installing the Claude hooks is the opt-in for Claude recording; remove them to stop. OpenCode still records only after a `live: true` request.
`--follow` only reads journals: it never starts recording, and it switches to whichever recorded session wrote last, so subagent sessions are not merged.
The header shows `LIVE source:session` with a spinner while a tool runs, the footer shows the latest call, and the inspector lists recent calls with their age.
Nodes show `r`/`e` counts of retained reads and edits. Press `a` to make the camera glide to the node of the newest running tool; it is off by default and never changes your selection.

## Open a diagram

Inside tmux, list the example diagrams, then show one:

```sh
bun run c4view list --workspace examples/parcel
bun run c4view show services --workspace examples/parcel
```

Select nodes with the mouse, Tab, or `h` `j` `k` `l`, which move to the nearest node in that direction. Arrow keys pan the Three camera (press `v` to swap the two);  connectors use projected Braille. Press `/` to search the current view by name or ID.
Selected connections are thicker, with cyan incoming lines and amber outgoing lines. Scroll over the relationship details to read long labels.
Press `e` to browse the selected node's mapped files, then Enter to open one in your external editor.
Set `VISUAL` or `EDITOR` before starting the viewer. File browsing does not require live recording.
Enter selects a group's first child or opens a leaf's linked view. Press `o` to open a group's linked view, `b` for view history, or Backspace for the parent group.
Use `f` to fit, `r` to center the selection, and `q` to quit. Press `i` for the responsive inspector or `?` for help. Ctrl+C quits even while search is active.
See [native viewer controls and limits](docs/native-viewer.md) for search, activity, and navigation details.

To run in the current terminal instead of opening a pane:

```sh
bun run c4view view services --workspace examples/parcel
```

## Outside tmux

Use `--pane %ID` to choose the parent pane explicitly (run `tmux display-message -p '#{pane_id}'` in it), and `--socket PATH` for a non-default tmux server.
Use `--project NAME` when multiple projects have the same view ID.

## Use from OpenCode

The repository's `opencode.json` registers `plugins/opencode`.
Restart the OpenCode background service after adding the plugin if its tools do not appear:

```sh
opencode service restart
```

This briefly disconnects active clients. The plugin provides `c4view_list` and `c4view_show`.
Each tool requests permission before loading a workspace or opening a pane.
Ask the agent to list the views, then show the selected view in your tmux pane.

For example, supply your actual pane ID:

```text
Show the parcel project's services diagram in tmux pane %2.
```

The plugin requires an explicit parent pane because OpenCode's background service may not share the current terminal's environment.
It uses the plugin location as the workspace and passes only identifiers to the CLI, not diagram geometry through model context.
Other agents can invoke the same CLI without the OpenCode plugin.
A new `show` request reuses the owned viewer pane and resets the view, selection, and scroll position.

## Observe live activity

Place `c4view.activity.json` in the agent's workspace. This repository includes a mapping to its own `viewer` LikeC4 project.
Mappings use workspace-relative path globs and exact LikeC4 element IDs:

```json
{
  "version": 1,
  "project": "my-project",
  "mappings": [{ "glob": "services/payments/**", "element": "platform.payments" }]
}
```

In OpenCode, ask the agent to show the `viewer` project's `live` view with `live: true` and your current pane ID.
The plugin binds the panel to the calling session. It records that session's subsequent tool starts, completions, and failures automatically.
Call `c4view.stop` to stop recording. Closing the viewer alone does not stop recording.
Plugin reloads stop recording; call `show` with `live: true` again to resume.
Subagent sessions are separate and are not automatically included.

The panel shows the latest four tool calls and their mapped components.
Native nodes also show active READ or EDIT labels, followed by DONE or FAILED for five seconds. Groups display their own mapped activity in their title.
The layout stays fixed as activity arrives.
Unmapped paths remain visible as `unmapped`. Long-running calls become `unconfirmed` after 30 seconds without an outcome.
This is an observation-age indicator, not proof that the agent disconnected or the tool stopped.
Selection, pan and zoom remain unchanged as activity arrives. Reopening the viewer reads retained activity.

For Claude Code, `c4view init` installs these hooks. To do it by hand, copy the hooks from `plugins/claude/hooks.example.json` into your project settings and replace the absolute plugin path.
Merge the hooks with existing settings; do not replace unrelated configuration.
The hook runs asynchronously and exits successfully even if observation fails.
The adapter accepts `PreToolUse`, `PostToolUse`, and `PostToolUseFailure`; it has been tested with hook payloads, not an interactive Claude session.
With the Claude session ID, open a bound viewer:

```sh
bun run c4view show VIEW --workspace /path/to/project --project PROJECT --pane %ID --source claude --session SESSION_ID
```

Only tool names, call/session IDs, workspace-relative paths, operation categories, timestamps, and lifecycle states are retained.
Tool arguments, command strings, source contents, tool results, and error text are not stored.
Records live under `.cache/c4view/activity` in directories created with private permissions.
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

Per-request readiness files remain under the selected workspace's `.cache/c4view` directory. Close viewers before removing old cache directories.
Concurrent requests for the same parent pane and workspace return a busy error. Retry after the active request finishes.
