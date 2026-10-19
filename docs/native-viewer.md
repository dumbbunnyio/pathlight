# Use the native diagram viewer

The native renderer is the default for `pathlight show` and `pathlight view`. It is the only renderer and draws interactive nodes without images.

From the repository root, run this command in a terminal:

```sh
bun run pathlight view live --project viewer
```

Click a node. Its border becomes white, and the details panel lists its incoming and outgoing relationships.
Connections are made of horizontal and vertical lines with rounded bends. Quiet ones are dotted, and the selected node's are solid: cyan for incoming, amber for outgoing.
The details use the same colors, node names, and full relationship labels. Scroll over the details to read wrapped labels without panning the diagram.
Press Tab or Shift+Tab to cycle through nodes. `h`, `j`, `k` and `l` select the nearest node left, down, up or right of the selection (siblings are preferred; ancestors and descendants are reached with Backspace and Enter). The camera only moves if the new node would be off screen. Arrow keys pan the camera without changing the selection, and Shift+`hjkl` pans too. Press `v` to swap the roles: arrows select, `hjkl` pan.
Select a group and press Enter to select its first child. Press Backspace to select the parent group.
The inspector identifies linked views with `o opens`. Press `o` to open one. Enter also opens links on leaf nodes.
Press `b` to return to the previous view, selection, zoom, and scroll position. Backspace navigates the group hierarchy, not view history.
Press `f` to fit the diagram, `r` to center the selection, and `q` to quit.
Press `+` or `=` to zoom in, `-` to zoom out, and `0` to return to 100%.
Zoom keeps the viewport center in place. Keyboard pan, reveal, and zoom ease into position using a Three orthographic camera.
Search snapshots the current camera position. Hierarchy and search navigation reveal a group's upper-left corner or center a leaf.
Press `i` to toggle the inspector. From 120 columns up it is docked beside the diagram (drag its divider to resize it) and open by default. Narrower terminals start without it; `i` (or a section number) shows it as an overlay on the right half, covering part of the diagram, and `i` hides it again. PageUp/PageDown scroll its contents. Press `?` for keyboard help.

The diagram is fitted and centred when it opens and whenever the terminal is resized, until you pan, zoom (`+`, `-`, `0`) or recentre (`r`) yourself; `f` fits it again and turns that back on. Switching views fits the new view.

Under 80 columns a diagram does not fit, so the nodes are listed instead: one row per node, indented by depth, with its kind (or its `[edit]`/`[read]`/`[run]` state while a tool runs) at the right. ↑↓ (or j k) move the selection down the list, Enter and Backspace go into a group and up to its parent, and clicking a row selects it. Search, ask, help and the inspector overlay work as usual.

Click an inspector section header once to focus it and again to fold it.

Colours are 24-bit. When `COLORTERM` does not say `truecolor` or `24bit` (and `TERM` is not a direct-colour type), every colour is snapped to the nearest xterm-256 colour; set `PATHLIGHT_COLORS=256` or `PATHLIGHT_COLORS=truecolor` to force either. The viewer paints its own dark background and does not follow the terminal's theme yet.
Resize the terminal, then click another visible node to check that mouse targets stay aligned.

Press `/` to search the current view by node name or full ID. Matching ignores case and finds literal substrings, not regular expressions.
Type `commerce` to find the group and its children, or `Checkout API` to match the displayed name.
Use Up, Down, Tab, or Shift+Tab to cycle through matches. The selected match is revealed in the diagram.
Press Enter to keep the selected match. This Enter does not open a linked view or enter a group.
Press Escape to cancel and restore your original selection and scroll position.
An empty query or a query with no matches restores the original selection. Enter stays in search until a match exists.
Search accepts pasted text and limits queries to 256 characters. While typing, `q`, `b`, and `o` are text rather than commands, and diagram clicks do not change the selection.
Ctrl+C still quits. Search does not include nodes that are absent from the current view.

## Open a node's files

Set `VISUAL` or `EDITOR` before starting the viewer. The viewer prefers a nonempty `VISUAL` value.
For example, use `EDITOR=nvim bun run pathlight view live --project viewer`.
For a GUI editor, include its wait flag, such as `VISUAL='code --wait'`.
These variables are trusted shell commands. Never populate them from untrusted model content.
When an agent starts the viewer, the viewer inherits that agent process's environment.

Select a node and press `e`. The inspector opens and scrolls to its file list; the heading becomes a path filter.
Type to filter paths. Use Up, Down, Tab, Shift+Tab, Page Up, or Page Down to select a file.
You can also click a visible file row to highlight it; click the highlighted row again, or press Enter, to open it in your editor. Clicking the diagram leaves file browsing and selects that node, so a stray click never traps the keyboard. Text in the panels is not mouse-selectable.
Exit the editor to return to the same file selection and diagram position.
Press Escape to return to diagram controls, or Ctrl+C to quit the viewer while browsing files.
While the editor runs, it owns terminal input and handles its own shortcuts.

The list uses direct mappings in `pathlight.activity.json`, including overlapping glob patterns.
It works without an activity session. A group does not inherit its children's files.
Mappings must name the selected project. Files are sorted and deduplicated, not inferred from recent activity.
Press Ctrl+R in the file list to find added, removed, or renamed files.
The mapping reloads automatically (see Live reload).

The scan includes hidden files but skips symlinks and directories named `.git`, `.cache`, or `node_modules`.
It does not apply `.gitignore` rules. Scans exceeding 50,000 directory entries report an error rather than a partial file list.
The viewer checks that a file still exists inside the workspace before opening it.
Missing editors, deleted files, and nonzero editor exits leave an error in the file-list footer.

## Explore groups and linked views

Try the nested Parcel architecture:

```sh
bun run pathlight view services --workspace examples/parcel --project parcel
```

Select the Parcel group, then the Commerce or Fulfillment group inside it. Click a child node to select it independently.
Use `view checkout` for a narrower diagram with two levels of groups.

To try navigation, start with `view index`. Select Parcel and press Enter to open services.
Select Commerce and press `o` to open checkout. Press `b` to return to Commerce in services.
The viewer follows explicit LikeC4 `navigateTo` links. It does not guess a destination from shared elements.
History retains the latest 32 visits. Opening a missing or empty view leaves the current diagram intact.
Changing views replaces only the diagram widgets. The viewer process, activity binding, and activity polling stay running.

To observe an already-recording OpenCode session, supply its session ID:

```sh
bun run pathlight view live --project viewer --session SESSION_ID
```

This command only reads activity. It does not enable recording in the agent plugin.
Read or edit a mapped file in the bound session. The node displays READ or EDIT while the tool runs, then DONE or FAILED for five seconds.
Fast tools may show only their final state. White borders identify selection independently of activity labels and backgrounds.
Unselected READ and EDIT borders pulse gently while the tool is active. Outcome states do not pulse. Connections do not animate or imply observed traffic.
Groups show their own mapped activity in their title. A child's activity does not automatically mark its parent active.

## Appearance

Leaf nodes are borderless flat cards, so their whole area is available for the label, which wraps and ends in `…` rather than showing a fragment. The ring is painted on the canvas just outside the card, only for selection (white), neighbours (cyan incoming, amber outgoing) and observed activity (amber edit, cyan read, violet command), so emphasis is never confused with decoration. Groups are outlines with titles on the canvas colour.
Connections are orthogonal: thin box-drawing lines (`─ │ ╭ ╮ ╰ ╯ ├ ┤ ┬ ┴ ┼`) with rounded bends and no diagonals. Each is routed once per layout on a coarse grid that steers around other nodes and prefers few bends (`src/routes.ts`); the endpoints are LikeC4's, only the path between them is ours. Quiet connections are dotted where they run straight (`┈ ┊`), the selected node's are solid and tinted by direction, shared runs merge into junctions, and every arrowhead (`▶ ◀ ▲ ▼`) sits on the cell next to its node.
A faint dot grid is fixed to the diagram's coordinates, so panning and zooming read as camera motion.
When the first view opens, nodes bloom in from left to right and connectors extend from source to target for about 0.6 seconds. This is a one-time reveal; it does not run on navigation and connectors never animate to suggest traffic. The ready signal waits for the reveal to finish.

To check how a change looks without a screenshot, render a pane to an image:

```sh
tmux capture-pane -e -p -N -t %PANE | python3 scripts/ansi2png.py out.png
```

The inspector shows the selected element's `kind`, `technology` and its LikeC4 `description` (markdown flattened to plain text, clipped at 420 characters), so the model is the one place that says what a component is for.
Each card carries a faint tint of its LikeC4 `color`, so databases, queues, services and externals read apart at a glance. Shapes are not drawn: edge treatments for storage and queues looked like stray fragments beside group outlines.

## Interface

The look is quiet: no bold, no all-caps, three text levels (bright for the selection and titles, normal for body, dim for everything else), and the only filled block on screen is the mode badge. The header reads `◆ pathlight / <view title>` with `● live source:session` on the right (cyan; a spinner while a tool runs) and a dim line with the workspace, project/view, node and relationship counts and the Back depth. The latest call, while recent, sits at the right of that line.

Cards have one rounded border, a dim kind line and the title; the selected card's border is amber, its neighbours' borders are a step brighter, and the card chosen by the Connections cursor gets a dashed amber border. Connectors are thin orthogonal lines: each leaves the vertical middle of the source's right side, runs horizontally, turns vertically at the middle of the gap (edges leaving the same node share that trunk) and enters the vertical middle of the target's left side, with rounded corners and an arrowhead. The selected node's edges are solid amber (outgoing) or cyan (incoming); all others are dim and dotted. Cards are kept inside their group's frame so group titles stay readable at low zoom.

The bottom row is the only status line: an amber mode badge in lowercase (`diagram`, `connections`, `files`, `search`…), `Selected: <id>`, then key hints (key bright, label dim) as many as fit; zoom and the version sit at the right and drop out when the left side needs the room. Notices (`Model reloaded`, errors) replace the hints for about two seconds; the ask confirmation stays for about three and a half. Help (`?`), the session summary (`c`), ask (`t`) and go-to-view (`g`) share one frame: a single rounded border centred in the terminal over a backdrop dimmed to about a fifth, with the title (and, at the right, a status such as `in diagram` or the live session) set into the top border and the key hints set into the bottom border. Clicking the backdrop or pressing Esc closes a dialog, and every other key is ignored while one is open. In help, `v` swaps hjkl and the arrows; the group for where the keys are now is in the accent colour. Empty states are one dim line saying what to do next.
A one-line `loading the architecture…` shows while LikeC4 loads the model.

The inspector is four numbered sections with hairline headers: `▾ 1 Overview ───── count`. Press `1`–`4` to focus a section (its header turns amber and the mode badge names it); the movement keys belong to it until `Esc` (or the same number again). Inside a focused section `↑↓`/`jk` move a cursor and `Enter` acts: in Connections it selects that node in the diagram (and the focus stays, so you can walk the graph edge by edge), in Files it opens the file in your editor, in Activity it selects the component the call touched, and in Overview the arrows scroll. `Tab` moves to the next section and `Space` folds the focused one; clicking a header folds it and focuses it. Clicking the diagram hands the keys back.
Sections are sized to their content, capped at a fair share of the panel; only the focused section scrolls, with a thin scrollbar that is visible only while it is focused. Connections lists `→ Title` / `← Title` with the relationship label beneath; Files is a nested tree (files touched this session are bright with an amber `●`); Activity is a grid of `├─ ✓ read  file  +n ×n  age` rows grouped by component. When the inspector is too short for every open section, the least important untouched ones fold themselves.
Press `g` for a numbered list of every view in the project; `1`–`9` jumps, arrows and Enter choose, and `Back` returns. This is a user's choice of view, not an inferred link.

## Live reload

The viewer watches the workspace for changes to `.c4`/`.likec4` files, LikeC4 configuration and `pathlight.activity.json`, and rebuilds the diagram about half a second after the last change. Your selection, pan and zoom stay where they are, and a short notice lists added and removed nodes (`Model reloaded: + Billing service`).
If the new model has errors (for example an agent is mid-edit), the viewer keeps the last good diagram and says so; it recovers on the next valid save. A new or removed view you are looking at is reported rather than dropped. Mapped files refresh with the mapping. `node_modules`, `.git` and `.cache` are ignored.

## Follow mode and the live display

`--follow` binds to the newest recorded session in the workspace and re-binds when another session writes later.
Until a session records, the header reads `live waiting for a session`.
The header shows a spinner while a tool runs. The footer starts with the latest call, and the inspector groups recent mapped calls under their component, one short line each: a status glyph (spinner while running, `✓` done, `✗` failed, `?` unconfirmed), `read`/`edit`/`run`, the file name (`+N` more files, `×N` repeats) and a coarse age. Unmapped calls collapse into one `+N unmapped` line. Files that were edited but belong to no component are listed under `no component` (up to three), which shows where the mapping has a gap. A component touched but absent from the current view is labelled `other view`. In the file list, files touched in the retained journal are bright with an amber `●`.
Nodes show `r` and `e` counts for retained reads and edits (groups append them to the title). Counts describe the retained journal, not totals.
Nodes that saw work in the last 90 seconds carry a faint tint (warm for edits, cool for reads) that cools in three coarse steps, so you can see where the agent has been.
Shell commands (`Bash`) are tracked too: the journal keeps only the existing workspace files the command names, never its text. A running command shows `[run]` on those nodes and counts as `c`. That means "a command referred to this file", not that it read or edited it.
Click a component's row in the activity list, or press `w`, to select the node the agent is working on (the newest observed call that maps to this view). Press `c` for a summary of the session: components touched with read, edit and command counts and recency, and the files edited with their owning component. Both are computed from the retained journal and make no claim beyond what was observed.
Press `t` to ask the agent about the selected node. The dialog shows what it is about and an include row of three toggles: files, connections (both on) and recent activity (off). Type a question and press Enter: the viewer types it into your agent's tmux pane (the one it was opened beside), with the chosen context, and submits it, for example `About the "Orders" component (parcel.orders): why is this slow? [files: ...; connects: ...]`. An empty question is not sent. Alt+Enter adds a line (the field grows to four rows, then scrolls). Tab moves to the include row (← → or h l choose, Space toggles, or click an item) and back. A confirmation replaces the key hints in the status row for about three and a half seconds.
This needs the viewer to have been opened with `pathlight show` (which records the parent pane); text is sent literally and the pane is checked to still exist.
Press `a` to let the camera glide to the node of the newest running tool. It never changes the selection, and it is off until you press `a`.

Run the repeatable terminal check:

```sh
TMPDIR=/tmp/opencode bun test tests/interactive.test.ts
```

## Rendering limits

Pass a view ID and use `--workspace` and `--project` to select its model.
Empty views are rejected. Native mode does not support collapsing groups, project-wide search, relationship-link navigation, or editing the model.
The framebuffer follows the terminal viewport rather than allocating a full-diagram canvas. Manual zoom ranges from 12.5% to 800%; fit can scale further to show the whole diagram.
Leaf shapes become filled boxes. Groups become transparent outlines with titles, ordered behind their children.
Labels wrap at cell boundaries and can be clipped on small nodes. Leaf labels hide below six columns or two rows.
Connectors are routed orthogonally around leaf nodes and rasterized onto terminal cells each frame; where no clear route exists they fall back to a plain horizontal-vertical-horizontal path. Unselected connections remain dim; selected ones draw last. Arrowheads occupy the cell next to the target node; dot and diamond markers are drawn as plain arrowheads.
Relationship labels wrap in the scrollable selection panel rather than covering the diagram.
At 100%, coordinates use 16 horizontal pixels per terminal cell. Vertical scale follows the reported terminal cell aspect ratio, falling back to 32 pixels. Nodes and connectors share the camera projection.
Resizing changes the viewport, not the graph layout. Native boxes and scrolling still move at terminal-cell boundaries during easing.
The activity journal is best-effort. Calls without outcomes stop showing as active after 30 seconds, and the activity panel marks them unconfirmed.

## Implementation and verification

Native node boxes, group outlines, and a connector framebuffer share a clipped viewport. Hit testing uses displayed cell bounds, including rounded group titles.
Camera interpolation uses OpenTUI frame callbacks and Three's orthographic camera for the projection. Nothing is drawn by Three or the GPU, so no WebGPU backend is needed. Linux is the verified platform.
LikeC4 parent and child IDs drive hierarchy navigation. Renderable boxes remain siblings with absolute coordinates to avoid nested border offsets.
The isolated tmux tests exercise the flat view and both nested Parcel views, including clicks before and after pan and resize, independent group and child activity, and normal process exit.
The file-browser test requires `nvim` and checks an actual save, resizing during editing, editor failure recovery, file filtering, refresh, and preserved zoomed diagram position.
The Linux editor lifecycle test checks launcher environment forwarding and shutdown of an editor wrapper with a child process.
Navigation tests verify explicit links, rejected empty destinations, restoration of zoomed diagram cells and selection, an unchanged process, and activity updates after returning.
Search tests exercise shortcut isolation, case-insensitive names and IDs, pasted text, match cycling, mouse isolation, resize, accepting linked nodes without opening them, and cancellation back to the original diagram cells.
Routing tests check that routes are only horizontal and vertical, avoid nodes in the way, merge into junctions and end in an arrowhead outside the target. The relationship test checks selection colors and long labels that scroll without moving the diagram.
The interactive prototype was manually tried and approved before integration into the CLI. macOS and broader terminal compatibility remain unverified.
