# Visualize work

Show LikeC4 architecture diagrams beside an agent conversation in tmux.
LikeC4 owns the model and layout. OpenTUI renders interactive terminal nodes, groups, and connectors by default.
An explicit PNG renderer preserves LikeC4's image appearance with zoom and pan controls.
The viewer can show live tool activity mapped to architecture elements. It does not infer test status or runtime service traffic.

See [project intent](docs/project-intent.md) for the goals, accepted design and
scope boundaries, and [AGENTS.md](AGENTS.md) for engineering guidance.

## Set up

Use Bun 1.4.2 or later, Node.js 22 or later, tmux, and util-linux `flock` on Linux.
The OpenCode plugin targets V2 and is pinned to SDK 2.0.31.

```sh
bun install
```

Native mode needs no browser installation or terminal image protocol. For PNG mode, also run `bunx --no-install playwright install chromium`.
The PNG exporter enables Chromium sandboxing. Do not disable it to work around a host configuration problem.
Only open trusted LikeC4 workspaces. LikeC4 can load executable JavaScript or TypeScript project configuration.

## Open a diagram

Inside tmux, list the example diagrams, then show one:

```sh
bun run c4view list --workspace examples/parcel
bun run c4view show services --workspace examples/parcel
```

Select nodes with the mouse or Tab. Arrow keys pan the Three camera; connectors use projected Braille. Press `/` to search the current view by name or ID.
Selected connections are thicker, with cyan incoming lines and amber outgoing lines. Scroll over the relationship details to read long labels.
Press `e` to browse the selected node's mapped files, then Enter to open one in your external editor.
Set `VISUAL` or `EDITOR` before starting the viewer. File browsing does not require live recording.
Enter selects a group's first child or opens a leaf's linked view. Press `o` to open a group's linked view, `b` for view history, or Backspace for the parent group.
Use `h`, `j`, `k`, and `l` to pan, `f` to fit, `r` to center the selection, and `q` to quit. Press `i` for the responsive inspector or `?` for help. Ctrl+C quits even while search is active.
See [native viewer controls and limits](docs/native-viewer.md) for search, activity, and navigation details.

To run in the current terminal instead of opening a pane:

```sh
bun run c4view view services --workspace examples/parcel
```

## PNG fallback

Select `--renderer png` explicitly. Graphics protocol options apply only to PNG mode.
For Ghostty with tmux passthrough already enabled, select cell-anchored images:

```sh
bun run c4view show services --workspace examples/parcel --renderer png --protocol kitty-unicode
```

`kitty-unicode` uses Kitty virtual placements and Unicode cells that tmux can move, clip, and hide.
It requires a terminal with Kitty Unicode-placeholder support. Indexed colors preserve image IDs even when tmux does not advertise truecolor output.
The raw protocol prototype was visually verified on Ghostty 1.2.3 with tmux 3.5a.
The integrated OpenTUI renderer was also visually confirmed on that setup.
Keep the target window visible until loading finishes. With `allow-passthrough on`, tmux discards image uploads from hidden windows even though it retains their placeholder cells.
The launcher rejects Unicode image requests targeting a window that no attached client is viewing. Switch to that window and retry, or pass the pane ID from your current window.
`auto` remains a coarse block preview inside tmux. Small labels may be unreadable.
Ordinary `kitty` and `sixel` remain disabled inside tmux because their images are not pane-relative.
The launcher does not change passthrough settings. During replacement it temporarily retains the owned pane until cleanup finishes, then restores its exit setting.
Unicode images preserve aspect ratio using reported cell dimensions, or a 1:2 cell ratio when unavailable.
Their zoom stops at the protocol's 297-cell coordinate limit on either axis.

In PNG mode, press `+` or `-` to zoom, arrow keys to pan, `f` to fit, and `q` to close the viewer.
Showing another diagram reuses the viewer pane and resets zoom.
If you repurpose that pane for another command, the launcher leaves it alone and opens a new pane.

Outside tmux, run the viewer directly in an interactive terminal:

```sh
bun run c4view view index --workspace examples/parcel --renderer png --protocol kitty
```

Use `--project NAME` when multiple projects have the same view ID.
Pass `--pane %ID` to select the parent pane explicitly, and `--socket PATH` for a non-default tmux server.
Run `tmux display-message -p '#{pane_id}'` in the intended parent terminal to obtain its ID.

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
The tool defaults to `renderer: "native"`. Request `renderer: "png"` with `protocol: "kitty-unicode"` for the image fallback.
Both modes share pane ownership and reuse. A new `show` request resets the view, selection, and scroll position.

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
The layout stays fixed as activity arrives. PNG mode updates only the text panel, not the image.
Unmapped paths remain visible as `unmapped`. Long-running calls become `unconfirmed` after 30 seconds without an outcome.
This is an observation-age indicator, not proof that the agent disconnected or the tool stopped.
Selection and pan remain unchanged as activity arrives. PNG zoom is also preserved. Reopening the viewer reads retained activity.

For Claude Code, copy the hooks from `plugins/claude/hooks.example.json` into your project settings and replace the absolute plugin path.
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

Tests require Python 3 for the pseudo-terminal check.
They exercise the real CLI, native interaction, PNG export, and isolated tmux servers.
They cover pane reuse, protecting a repurposed pane, zoom, fit, quit, indexed image IDs, and delayed pixel-resolution replies.
The PNG tests require the installed Chromium browser. Native interaction tests do not. Terminal image appearance still needs a check in your actual terminal.

PNG exports and per-request readiness files remain under the selected workspace's `.cache/c4view` directory.
Native requests create readiness files but no PNG exports. Close viewers before removing old cache directories.
Concurrent requests for the same parent pane and workspace return a busy error. Retry after the active request finishes.
