# Use the native diagram viewer

The native renderer is the default for `pathlight show` and `pathlight view`. It is the only renderer and draws interactive nodes without images.

From the repository root, run this command in a terminal:

```sh
bun run pathlight view live --project pathlight
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
Hierarchy and search navigation reveal a group's upper-left corner or center a leaf.
Press `i` to toggle the inspector. From 120 columns up it is docked beside the diagram (drag its divider to resize it) and open by default. Narrower terminals start without it; `i` (or a section number) shows it as an overlay on the right half, covering part of the diagram, and `i` hides it again. PageUp/PageDown scroll its contents. Press `?` for keyboard help.

The diagram is fitted and centred when it opens and whenever the terminal is resized, until you pan, zoom (`+`, `-`, `0`) or recentre (`r`) yourself; `f` fits it again and turns that back on. Switching views fits the new view.

Under 80 columns a diagram does not fit, so the nodes are listed instead: one row per node, indented by depth, with its kind (or its `[edit]`/`[read]`/`[run]` state while a tool runs) at the right. ↑↓ (or j k) move the selection down the list, Enter and Backspace go into a group and up to its parent, and clicking a row selects it. Search, ask, help and the inspector overlay work as usual.

Click an inspector section header once to focus it and again to fold it.

Colours are 24-bit. When `COLORTERM` does not say `truecolor` or `24bit` (and `TERM` is not a direct-colour type), every colour is snapped to the nearest xterm-256 colour; set `PATHLIGHT_COLORS=256` or `PATHLIGHT_COLORS=truecolor` to force either.

## Themes

Press `T` to choose a theme. The list previews each one live over the diagram as you move (up/down, PageUp/PageDown, Home/End); Enter keeps it and remembers it, Esc puts the previous one back. The choice is saved as `{ "theme": "name" }` in `$XDG_CONFIG_HOME/pathlight/config.json` (default `~/.config/pathlight/config.json`); nothing about any workspace is stored there. `PATHLIGHT_THEME=name` overrides it for one run.

Themes use [OpenCode's theme format](https://github.com/anomalyco/opencode), so its themes work unchanged: a JSON file with `defs` (named colours) and `theme` (roles mapped to a hex colour, a `defs` name, another role, an ANSI colour number, `transparent`, or `{ "dark": …, "light": … }`). Only the roles Pathlight draws with are read (`background`, `backgroundPanel`, `backgroundElement`, `text`, `textMuted`, `border`, `borderActive`, `borderSubtle`, `primary`, `accent`, `secondary`, `info`, `warning`, `success`, `error`); the diff, markdown and syntax roles are ignored. Pathlight's own shades (`grid`, `hot`, `pick`, `edgeDim`, `cardEdge`, `keycap`, `scrim`) are blended from those unless a theme sets them. `incoming` (live, search) is nudged away from `accent` (selection) when a theme gives them nearly the same colour. A colour with an alpha channel (`#rrggbbaa`) is laid over the theme's background.

- Built in: `pathlight` (the original look, the default) and the 32 themes bundled in `src/themes/` (copied from OpenCode, MIT, see `NOTICE.md`).
- Your own: put `name.json` in `$XDG_CONFIG_HOME/pathlight/themes/` or `<workspace>/.pathlight/themes/`. A workspace theme beats a user theme beats a bundled one of the same name. A file that does not parse is skipped; a theme that cannot be resolved (an unknown reference, a cycle) is refused with a message naming it.
- `system` takes the terminal's own background, foreground and ANSI colours. They are requested once at startup (OSC 4/10/11); the entry appears in the picker only if the terminal answers, and inside tmux that needs `set -g allow-passthrough on`. Verified only against fixed colour values so far, not against a range of terminals.
- Light or dark: themes with both variants follow the terminal's background when it reports one; `PATHLIGHT_MODE=dark|light` forces it. Many themes define only one variant.
- With `COLORTERM` unset, colours are still snapped to xterm-256 for whichever theme is active.
Resize the terminal, then click another visible node to check that mouse targets stay aligned.

Press `/` to search everything: every view, every box (in any view, nested or not) and every file the mapping gives a box, with the views and files outside the one you are in included. `g` opens the same list restricted to views.
Type to narrow it. Matching ignores case. Several words must all match, the letters of a word may be spread out (`ctx` finds `context`), and a swapped or doubled letter (`hepler`) still finds `helper`. A box matches on its name and its id, a view on its title and its id, and a file on its name and its path.
Results are ranked by how well the text matches and by where the result is, added together. Match quality counts most: an exact name or id comes first wherever it is, then a prefix or a word start, then a substring, then spread-out letters. Where it is breaks ties and nudges close calls, in this order: a box in the view you are in, a file in it, a box elsewhere, a view, a file elsewhere. A row for something in your view carries a dot (`● here`); a row elsewhere says which view it opens. Files the mapping ignores (tests, generated code) are not offered. The ranking constants and their tests are in `src/search.ts` and `tests/search.test.ts`.
Up, Down, `Ctrl+N`/`Ctrl+P`, PgUp, PgDn, Home and End move; Enter goes; Escape (or a click outside) closes without changing anything. A box in the view you are in is selected where it is. Otherwise Enter opens the view of its parent, else its own view, else a view it is linked from, else the smallest view that has it, selects the box, and Back returns. A file opens its box with that file marked in the Files section. A view just opens.
The list scrolls inside its frame (the border shows `79–95 of 95`). Typing, pasted text (256 characters at most) and resizing all work while it is open, `q`, `b` and `o` are text rather than commands, and diagram clicks do not change the selection. Ctrl+C still quits.

## Open a node's files

Set `VISUAL` or `EDITOR` before starting the viewer. The viewer prefers a nonempty `VISUAL` value.
For example, use `EDITOR=nvim bun run pathlight view live --project pathlight`.
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
bun run pathlight view live --project pathlight --session SESSION_ID
```

This command only reads activity. It does not enable recording in the agent plugin.
Read or edit a mapped file in the bound session. The card carries a tag in its top border while the tool runs (`■ edit`, `◦ read`, `▸ ⠋` for a command), then `✓ done` or `✗ failed` for 30 seconds, or `~ no result` for a call that started and never reported. A narrow card keeps only the glyph.
Fast tools may show only their final state. White borders identify selection independently of activity labels and backgrounds.
Unselected borders pulse gently while a tool is active. Outcome states do not pulse. Connections do not animate or imply observed traffic.
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

The look is quiet: no bold, no all-caps, three text levels (bright for the selection and titles, normal for body, dim for everything else), and the only filled block on screen is the mode badge. The header reads `◆ pathlight / <view title>` with `● live source:session` on the right (cyan; a spinner while a tool runs) and a dim line with the workspace, project/view, node and relationship counts and the Back depth. The latest call, while recent, sits at the right of that line (`now`/`last`, glyph, verb, file, component, age).

Cards have one rounded border, a dim kind line and the title, with the live tag set into the top border; the selected card's border is amber, its neighbours' borders are a step brighter, and the card chosen by the Connections cursor gets a dashed amber border. Connectors are thin orthogonal lines: each leaves the vertical middle of the source's right side, runs horizontally, turns vertically at the middle of the gap (edges leaving the same node share that trunk) and enters the vertical middle of the target's left side, with rounded corners and an arrowhead. The selected node's edges are solid amber (outgoing) or cyan (incoming); all others are dim and dotted. Cards are kept inside their group's frame so group titles stay readable at low zoom.

The bottom row is the only status line: an amber mode badge in lowercase (`diagram`, `connections`, `files`, `search`…), `Selected: <id>`, and, at the right, `zoom N%  │  ? help` (the version is in help). Key hints appear only inside a mode that needs them (section focus, search, files); in the diagram the footer stays quiet and `?` lists the keys. The header's second row is `project/view · N nodes` (plus `back N` once there is history) with one activity line at its right: the latest call, or `● working in VIEW · w to go` when the newest work is in another view. The activity line is shortened to fit and dropped on very narrow terminals. Notices (`Model reloaded`, errors) replace the hints for about two seconds; the ask confirmation stays for about three and a half. Help (`?`), the session summary (`c`), ask (`t`) and go-to-view (`g`) share one frame: a single rounded border centred in the terminal over a backdrop dimmed to about a fifth, with the title (and, at the right, a status such as `in diagram` or the live session) set into the top border and the key hints set into the bottom border. Clicking the backdrop or pressing Esc closes a dialog, and every other key is ignored while one is open. In help, `v` swaps hjkl and the arrows; the group for where the keys are now is in the accent colour. Empty states are one dim line saying what to do next.
A one-line `loading the architecture…` shows while LikeC4 loads the model.

The inspector ranks what it shows. At the top, the component's name with its kind at the right, then what the model says it is for (and, in a dim line, its technology, and `o opens VIEW` when a view is linked). Under that come cards with hairline headers (`▾ 1 Now ───── count`), most important first:

- **Now** (`1`): the selected component's own recent calls, newest first, up to three rows (`✓ read  pay.ts  ×2  4m`; repeats collapse), and `N earlier · c session` when there are more. It is shown only when a session is attached, and says `nothing observed here yet` rather than anything that could contradict the count. Work on other components is the header's line, `w`, `a` and `c`.
- **Connects** (`2`): one row per relationship, who calls it first (`← Login page  sends credentials`), then what it calls (`→`). The row under the cursor shows its relationship in full, wrapped.
- **Files** (`3`): shown only while you ask for it (`e`, or `3`), as a nested tree; files touched this session are bright with an amber `●`.

Pinned under the cards, always the same two lines: what is one key away (`e files 6   c session   p replay`, each only when it applies) and the question field (`› ask about Auth service…  t`), which opens the ask dialog.

Press `1`–`4` to focus a card (its header turns amber and the mode badge names it); the movement keys belong to it until `Esc`, `h` or left (or the same number again). From the right-most node of the diagram, `l` or right focuses Now, so the two panes are one row of keys. Inside a focused card `↑↓`/`jk` move a cursor (in Now they scroll) and `Enter` acts: in Connects it selects that node in the diagram (and the focus stays, so you can walk the graph edge by edge) and in Files it opens the file in your editor. `Tab` moves to the next card and `Space` folds the focused one; clicking a header folds it and focuses it. Clicking the diagram hands the keys back.
Cards are sized to their content, capped at a fair share of the panel; only the focused card scrolls, with a thin scrollbar that is visible only while it is focused. When the inspector is too short for every open card, the least important untouched ones fold themselves.
Press `g` for a list of every view in the project. Type to narrow it (fuzzy: the letters of each word in order, so `hlp mid` finds `helper / middleware`), `↑`/`↓` or `Ctrl+N`/`Ctrl+P` choose, `PgUp`/`PgDn`/`Home`/`End` move further, Enter goes and `Back` returns. The list scrolls inside its frame and the border shows which rows (`79–95 of 95`) you are looking at. This is a user's choice of view, not an inferred link.

## Live reload

The viewer watches the workspace for changes to `.c4`/`.likec4` files, LikeC4 configuration and `pathlight.activity.json`, and rebuilds the diagram about half a second after the last change. Your selection, pan and zoom stay where they are, and a short notice lists added and removed nodes (`Model reloaded: + Billing service`).
If the new model has errors (for example an agent is mid-edit), the viewer keeps the last good diagram and says so; it recovers on the next valid save. A new or removed view you are looking at is reported rather than dropped. Mapped files refresh with the mapping. `node_modules`, `.git` and `.cache` are ignored.

## Follow mode and the live display

`--follow` binds to the newest recorded session in the workspace and re-binds when another session writes later.
Until a session records, the header reads `live waiting for a session`.
The header shows a spinner while a tool runs. Its activity line says `now` while a tool runs and `last` once it has an outcome, then what it did, to which file and in which component (`now ■ edit src/auth/verify.ts in Auth service 4s`). The Now card lists the selected component's own calls, one short line each: a status glyph (spinner while running, `✓` done, `✗` failed, `~` no result), `read`/`edit`/`run`, the file name (`+N` more files, `×N` repeats) and a coarse age. Calls that name no file (a subagent launch, a search) and reads of files no component claims are not listed; they stay in the journal and in replay. Edits to files no component claims, which show where the mapping has a gap, are in the session summary (`c`) under `not in the model`; files the mapping lists under `ignore` are never shown, as they are deliberately outside the model. In the file list, files touched in the retained journal are bright with an amber `●`.
Nodes show `r` and `e` counts for retained reads and edits (groups append them to the title). Counts describe the retained journal, not totals.
Nodes that saw work in the last 90 seconds carry a faint tint (warm for edits, cool for reads) that cools in three coarse steps, so you can see where the agent has been.
Shell commands (`Bash`) are tracked too: the journal keeps only the existing workspace files the command names, never its text. A running command shows `[run]` on those nodes and counts as `c`. That means "a command referred to this file", not that it read or edited it.
Press `w` to select the node the agent is working on (the newest observed call that maps to a component; if it is not in this view, `w` offers the view that has it). Press `c` for a summary of the session: components touched with read, edit and command counts and recency, and the files edited with their owning component. Both are computed from the retained journal and make no claim beyond what was observed.

`p` replays the bound session from its retained journal. Each step is one call, shown as it ended (a call that never finished stays `started`). The diagram, counts and activity list show the session as it stood after that step, the newest call flashes, and the camera follows its component, switching view when the component is only in another one. Steps are grouped into turns: a turn begins at the first call after a prompt (Claude's `UserPromptSubmit` hook and OpenCode's session run write a bare marker, never the prompt), or, in a journal without markers, after a pause of more than 90 seconds. `←` `→` step, `[` `]` move between turns, `Home` `End` jump, `space` plays and pauses (stopping at the end), `s` cycles 1x, 2x and 4x, `esc` or `p` returns to live. Live updates are held back while replaying; zoom, pan, search and `?` still work.
Press `t` to ask the agent about the selected node. The dialog shows what it is about and an include row of three toggles: files, connections (both on) and recent activity (off). Type a question and press Enter: the viewer types it into your agent's tmux pane (the one it was opened beside), with the chosen context, and submits it, for example `About the "Orders" component (parcel.orders): why is this slow? [files: ...; connects: ...]`. An empty question is not sent. Alt+Enter adds a line (the field grows to four rows, then scrolls). Tab moves to the include row (← → or h l choose, Space toggles, or click an item) and back. A confirmation replaces the key hints in the status row for about three and a half seconds.

### Behavior views

A state diagram an agent wrote (see the `pathlight-behavior` skill) is an ordinary LikeC4 view, in a `*.behavior.c4` file beside the generated model. A state tagged `#bug` has a red outline and one tagged `#fixed` a green one (the tag also shows beside its kind in the inspector); selection and live activity still take precedence. Arrows carry no text, so the relationship titles (the events) are in the inspector under Connections. These views are the agent's reading of the code, not a scan. `pathlight flows` checks only what can be shown wrong or old: files a state names that no longer exist or changed since the commit in the view's `Synced at` note, arrows with no event, decisions with fewer than two answers, states nothing reaches, and states that name no file. A clean report is not a claim that the flow is right.

### Flow mode

A flow is a reading of the code that pathlight draws on the architecture, never an observation. There are two kinds, both found in the workspace on their own: a **journey** (a LikeC4 `dynamic view`: the components a request passes through, in order, each hop titled) and a **state diagram** an agent wrote in a `*.behavior.c4` file (its states are placed on components through the files their descriptions name and the activity mapping). They are read in the background after the first frame and again when the model changes or a check finishes, so a view never waits for them.

When the selected component is in a flow, an **In flows** card (`4`) lists which flows and which steps, with `◇ reading` at its right. Nothing is shown for a component no flow touches. Press `F` to trace one (the flows through the selection first; `F` again goes to the next, and after the last it leaves; `esc` leaves too):

- Cards on the path carry their step number in the top border, on the left (`╭─ 2 ───╮`; `▶` marks where a journey starts; a component several steps reach shows `2·5`), in the violet that means the agent's reading. A journey's connectors between the steps' components are violet too. Cards off the path step back (dimmed); nothing moves, and the camera only goes where you step.
- The inspector's Connects card becomes **Steps** (`2`): `◇ a reading of the code, not observed`, when the flow was synced and whether the files it names changed since, then one row per step with the component it lands on. `●` at the right of a row says the agent touched that component's files (from the journal, not that the step happened). The current step also shows the latest call on its component, `≠ no relationship in the model` when the model has no relationship for a journey hop, and `✗ marked as broken in the diagram` / `✓ marked as fixed` for a state tagged `#bug` / `#fixed`. `N to check · pathlight flows` appears when the check has findings.
- `[` and `]` (or `↑` `↓` in the focused card) step; each step selects its component and brings it into view, and says so when the component is in another view. Choosing a component yourself moves the reader to that component's next step. The footer says `flow` and the position (`◇ Placing an order · 3/5`).

Observed activity and the flow are kept apart on purpose: the flow never changes what the journal shows, and a step is never marked passed or failed because a command ran. `pathlight flows` reports the same findings on the command line, and `pathlight see VIEW --keys F,]` prints this mode as text.

### Changing the map from the viewer

Two more keys on the selected box, each with its own meaning. They need a map made by `pathlight draft`, which records each element's overlay key in `.cache/pathlight/keys.json`; on a model you wrote the viewer says so and does nothing.
- `m` asks the agent to improve the map. Same dialog shape as `t`, no toggles. The request typed into the agent's pane carries the overlay key, files and connections, and the rules: read the files, answer in chat, set the name and note in `pathlight.overlay.json` with `"by":"agent"`, run `pathlight draft`, never change a `"by":"human"` entry, and propose a merge or split in chat and wait for a yes. Use it for a box such as "loose files" whose purpose is not obvious.
- `d` asks the agent to trace a flow. Same dialog shape as `m`. The request typed into the agent's pane carries the component's files and connections and the rules: follow the `pathlight-behavior` skill, confirm each hop in a file, record it with `pathlight flow add` (which checks the components against the model and stamps the commit), leave out any hop it cannot point to in the code, and change no product code. Nothing appears until the agent has written the journey; then `F` traces it. With no flows yet, `F` says to press `d`.
- `n` is your own edit, with no agent: a name, Enter, a note, Enter. The viewer writes `pathlight.overlay.json` with `"by":"human"` (a pin) and reruns the draft; the model reloads on its own. A name left as the generated one is not stored, so the box keeps following its folder; leaving both empty removes your entry.
This needs the viewer to have been opened with `pathlight show` (which records the parent pane); text is sent literally and the pane is checked to still exist.
Press `a` to follow the work: while a tool runs, the viewer selects the node it belongs to (or the nearest enclosing component that is in this view) and glides the camera there, so the inspector shows that component's activity and files. It is off until you press `a`. Selecting something yourself, or panning or zooming, pauses it ("Follow paused · a to resume"); `a` again resumes, and once more turns it off. It never switches views. When the newest work is in a component this view does not show, the header offers "working in VIEW · w to go"; pressing `w` goes to the view that has it (one this view links to via `navigateTo` first, else the smallest containing view) and selects the component, and Back returns. When the inspector is short, the Activity card is the last to fold.

An element the mapping lists under `planned` that has no files yet (nor anything inside it) is designed but not built: its border is dashed, its box carries a `[planned]` tag, the header counts the planned elements in the view (`3 nodes · 1 planned`), and the inspector says "planned: no files yet" under its title. It looks like any other element as soon as it has files. `pathlight check` reports the same plan.

A view written by `pathlight draft` for one component (`<component>_near`, reached with enter on that component) opens with that component selected, so the picture says what it is about.

Calls made inside a Claude subagent carry its type and show it after the file name in the Now card (`·Explore`) and in the header line (`[Explore]`). Press `s` to hide them and leave only the conversation's own calls, and again to show them; the choice lasts for the viewer's run and applies to replay too.

`pathlight view VIEW --select ELEMENT` opens with that element selected, and `pathlight see` prints the screen as text (see the README); the tests compare it with the snapshots in `tests/golden/`.

Run the repeatable terminal check:

```sh
TMPDIR=/tmp/opencode bun test tests/interactive.test.ts
```

## Out-of-date badge

Every `pathlight check` records its counts in `.cache/pathlight/stale.json`, and the Claude plugin's `Stop` hook runs `pathlight check --quiet` at the end of each agent turn. The viewer reads that file every few seconds (it never scans itself) and, when the model and the code disagree, shows `▲ out of date: 3 files not in the model · 2 imports no relationship covers · checked 4m ago` at the right of the heading (shortened to `▲ out of date` in a narrow pane). The counts are `check`'s: source files no mapping claims, imports between mapped elements with no relationship, relationships no import backs, and mappings matching no file. They are static evidence that the two disagree, not which one is wrong, and they are as old as the last check: edits since then are not counted until the next turn ends or `pathlight check` runs. No stamp shows nothing; a clean one shows a muted `✓ in sync · checked 4m ago`, so you can tell the hook is running. When the check cannot run because the model or the mapping is broken (it does not compile, or a mapping names a box that is gone), that is recorded too and the badge says `▲ out of date: the model can't be read · checked 2m ago` instead of keeping the last good result; the next check that runs clears it. The viewer itself keeps drawing the last good diagram and says the model has errors.

## Changes since a commit

`pathlight diff [--base REV]` (default `HEAD`) compares the relationships the imports support in the working tree with those at a git commit, using the current model and mapping on both, and records the result in `.cache/pathlight/diff.json` (the `Stop` hook runs it after `check`). The base commit's scan is kept in `.cache/pathlight/base/<commit>.json` (only the latest commit) so later runs skip unpacking and scanning it; it is used only for the same commit and `scanRevision`, and rebuilt otherwise. The viewer reads it like the out-of-date stamp. Connectors whose imports were added since the base are solid green; ones that lost every import behind them are dotted red; the selected node's connectors keep their own tints and win. The breadcrumb (the second line, under the heading) adds `vs HEAD (static) +2 −1 1 undeclared` (relationships gained, relationships lost, pairs importing each other with no relationship); with no change it says nothing. `undeclared` counts pairs of elements that now import each other with no relationship in the model: they have no connector to colour, so run `pathlight diff` to list them. Everything here is a change in static imports, not in what the program does, and it is as old as the last diff.

## Plan

`pathlight plan ELEMENT ...` records the elements an agent is about to work on in `.cache/pathlight/plan.json` (ids only, at most 64, each checked against the model; no ids clears it). The viewer outlines those nodes (and their containers) in purple, adds `plan N` to the breadcrumb, and tags any node with observed activity that is outside the plan `off plan`. It is intent, not observation: it never changes what the activity shows, and a stale plan stays until replaced or cleared.

## Rendering limits

Pass a view ID and use `--workspace` and `--project` to select its model.
Empty views are rejected. Native mode does not support collapsing groups, relationship-link navigation, or editing the model.
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
Search tests exercise the ranking (an exact match beats the current view, the current view beats the rest on equal matches, typos, several words), shortcut isolation, pasted text, mouse isolation, resize, going to a view, and closing back to the original diagram cells.
Routing tests check that routes are only horizontal and vertical, avoid nodes in the way, merge into junctions and end in an arrowhead outside the target. The relationship test checks selection colors and long labels that scroll without moving the diagram.
The interactive prototype was manually tried and approved before integration into the CLI. macOS and broader terminal compatibility remain unverified.
