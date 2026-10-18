# Use the native diagram viewer

The native renderer is the default for `c4view show` and `c4view view`. It is the only renderer and draws interactive nodes without images.

From the repository root, run this command in a terminal:

```sh
bun run c4view view live --project viewer
```

Click a node. Its border becomes white, and the details panel lists its incoming and outgoing relationships.
Curves and diagonals use Braille dots. Fully horizontal and vertical connections use solid lines.
Selected connections use bold text. Incoming connections are cyan, and outgoing connections are amber.
The details use the same colors, node names, and full relationship labels. Scroll over the details to read wrapped labels without panning the diagram.
Press Tab or Shift+Tab to cycle through nodes. `h`, `j`, `k` and `l` select the nearest node left, down, up or right of the selection (siblings are preferred; ancestors and descendants are reached with Backspace and Enter). The camera only moves if the new node would be off screen. Arrow keys pan the camera without changing the selection, and Shift+`hjkl` pans too. Press `v` to swap the roles: arrows select, `hjkl` pan.
Select a group and press Enter to select its first child. Press Backspace to select the parent group.
The inspector identifies linked views with `o opens`. Press `o` to open one. Enter also opens links on leaf nodes.
Press `b` to return to the previous view, selection, zoom, and scroll position. Backspace navigates the group hierarchy, not view history.
Press `f` to fit the diagram, `r` to center the selection, and `q` to quit.
Press `+` or `=` to zoom in, `-` to zoom out, and `0` to return to 100%.
Zoom keeps the viewport center in place. Keyboard pan, reveal, and zoom ease into position using a Three orthographic camera.
Search snapshots the current camera position. Hierarchy and search navigation reveal a group's upper-left corner or center a leaf.
Press `i` to toggle the inspector. Drag its divider to resize it; narrow terminals place it below the diagram. PageUp/PageDown scroll its contents. Press `?` for keyboard help.
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
For example, use `EDITOR=nvim bun run c4view view live --project viewer`.
For a GUI editor, include its wait flag, such as `VISUAL='code --wait'`.
These variables are trusted shell commands. Never populate them from untrusted model content.
When an agent starts the viewer, the viewer inherits that agent process's environment.

Select a node and press `e`. The inspector opens and scrolls to its file list; the heading becomes a path filter.
Type to filter paths. Use Up, Down, Tab, Shift+Tab, Page Up, or Page Down to select a file.
You can also click a visible file row. Press Enter to open the selected file in your editor.
Exit the editor to return to the same file selection and diagram position.
Press Escape to return to diagram controls, or Ctrl+C to quit the viewer while browsing files.
While the editor runs, it owns terminal input and handles its own shortcuts.

The list uses direct mappings in `c4view.activity.json`, including overlapping glob patterns.
It works without an activity session. A group does not inherit its children's files.
Mappings must name the selected project. Files are sorted and deduplicated, not inferred from recent activity.
Press Ctrl+R in the file list to find added, removed, or renamed files.
Restart the viewer after changing the mapping configuration itself.

The scan includes hidden files but skips symlinks and directories named `.git`, `.cache`, or `node_modules`.
It does not apply `.gitignore` rules. Scans exceeding 50,000 directory entries report an error rather than a partial file list.
The viewer checks that a file still exists inside the workspace before opening it.
Missing editors, deleted files, and nonzero editor exits leave an error in the file-list footer.

## Explore groups and linked views

Try the nested Parcel architecture:

```sh
bun run c4view view services --workspace examples/parcel --project parcel
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
bun run c4view view live --project viewer --session SESSION_ID
```

This command only reads activity. It does not enable recording in the agent plugin.
Read or edit a mapped file in the bound session. The node displays READ or EDIT while the tool runs, then DONE or FAILED for five seconds.
Fast tools may show only their final state. White borders identify selection independently of activity labels and backgrounds.
Unselected READ and EDIT borders pulse gently while the tool is active. Outcome states do not pulse. Connections do not animate or imply observed traffic.
Groups show their own mapped activity in their title. A child's activity does not automatically mark its parent active.

## Appearance

Leaf nodes are borderless flat cards, so their whole area is available for the label, which wraps and ends in `…` rather than showing a fragment. The ring is painted on the canvas just outside the card, only for selection (white), neighbours (cyan incoming, amber outgoing) and observed activity (amber edit, cyan read, violet command), so emphasis is never confused with decoration. Groups are outlines with titles on the canvas colour.
Connections are continuous Braille strokes, medium when quiet and heavy when selected. Quiet connections brighten slightly toward their arrowhead, a static direction cue.
A faint dot grid is fixed to the diagram's coordinates, so panning and zooming read as camera motion.
When the first view opens, nodes bloom in from left to right and connectors extend from source to target for about 0.6 seconds. This is a one-time reveal; it does not run on navigation and connectors never animate to suggest traffic. The ready signal waits for the reveal to finish.

To check how a change looks without a screenshot, render a pane to an image:

```sh
tmux capture-pane -e -p -t %PANE | python3 scripts/ansi2png.py out.png
```

## Follow mode and the live display

`--follow` binds to the newest recorded session in the workspace and re-binds when another session writes later.
Until a session records, the header reads `LIVE waiting for a session`.
The header shows a spinner while a tool runs. The footer starts with the latest call, and the inspector groups recent mapped calls under their component, one short line each: a status glyph (spinner while running, `✓` done, `✗` failed, `?` unconfirmed), `READ`/`EDIT`/`RUN`, the file name (`+N` more files, `×N` repeats) and a coarse age. Unmapped calls collapse into one `+N unmapped` line. Files that were edited but belong to no component are listed under `NO COMPONENT` (up to three), which shows where the mapping has a gap. A component touched but absent from the current view is labelled `other view`. In the file list, files touched in the retained journal are bold and coloured by operation.
Nodes show `r` and `e` counts for retained reads and edits (groups append them to the title). Counts describe the retained journal, not totals.
Nodes that saw work in the last 90 seconds carry a faint tint (warm for edits, cool for reads) that cools in three coarse steps, so you can see where the agent has been.
Shell commands (`Bash`) are tracked too: the journal keeps only the existing workspace files the command names, never its text. A running command shows `[RUN]` in violet on those nodes and counts as `c`. That means "a command referred to this file", not that it read or edited it.
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
Connectors sample LikeC4's Bézier curves into a two-by-four dot grid per terminal cell. Overlapping curves combine their dots.
Unselected connections remain dim. Selected connections draw last, then arrowheads draw above the lines.
Arrowheads occupy exposed cells outside node boxes. The native renderer distinguishes absent, dot, and diamond markers but simplifies other arrowhead shapes to triangles.
Relationship labels wrap in the scrollable selection panel rather than covering the diagram.
At 100%, coordinates use 16 horizontal pixels per terminal cell. Vertical scale follows the reported terminal cell aspect ratio, falling back to 32 pixels. Nodes and connectors share the camera projection.
Resizing changes the viewport, not the graph layout. Native boxes and scrolling still move at terminal-cell boundaries during easing.
The activity journal is best-effort. Calls without outcomes stop showing as active after 30 seconds, and the activity panel marks them unconfirmed.

## Implementation and verification

Native node boxes, group outlines, and a connector framebuffer share a clipped viewport. Hit testing uses displayed cell bounds, including rounded group titles.
Camera interpolation uses OpenTUI frame callbacks and Three. The renderer initializes OpenTUI's WebGPU backend; the default connectors are projected Braille, not GPU strokes. Linux is the verified platform.
`g` toggles experimental GPU strokes and `s` toggles sampling for comparison. Braille remains the supported default.
LikeC4 parent and child IDs drive hierarchy navigation. Renderable boxes remain siblings with absolute coordinates to avoid nested border offsets.
The isolated tmux tests exercise the flat view and both nested Parcel views, including clicks before and after pan and resize, independent group and child activity, and normal process exit.
The file-browser test requires `nvim` and checks an actual save, resizing during editing, editor failure recovery, file filtering, refresh, and preserved zoomed diagram position.
The Linux editor lifecycle test checks launcher environment forwarding and shutdown of an editor wrapper with a child process.
Navigation tests verify explicit links, rejected empty destinations, restoration of zoomed diagram cells and selection, an unchanged process, and activity updates after returning.
Search tests exercise shortcut isolation, case-insensitive names and IDs, pasted text, match cycling, mouse isolation, resize, accepting linked nodes without opening them, and cancellation back to the original diagram cells.
Relationship tests check curve sampling, exposed arrowheads, marker direction, selection colors, and long labels that scroll without moving the diagram.
The interactive prototype was manually tried and approved before integration into the CLI. macOS and broader terminal compatibility remain unverified.
