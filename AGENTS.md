# Engineering guide

## Purpose and reading order

The latest working handoff (state, uncommitted work, decisions waiting on the user) is `docs/internal/handoff-*.md` (ignored, local), newest date first. `docs/internal/board.md` (ignored, local) says where each phase of the current plan stands, who does what next (Fable plans and reviews, Opus builds, David merges), and holds the prompt for the next session.

Pathlight puts an interactive architecture explorer beside an AI coding
conversation in tmux. It connects architecture, mapped source files, and observed
agent tool activity without pretending to observe runtime traffic.

Read [project intent](docs/project-intent.md) for the product contract,
[README](README.md) for setup/integration, and
[native viewer](docs/native-viewer.md) for controls and rendering limits.

## Current baseline

- The production default is `src/native-viewer.ts`: native OpenTUI widgets,
  an eased Three orthographic camera, orthogonal thin-line connectors, and a
  responsive, draggable inspector. The user approved this camera and appearance.
- The Three candidate has been promoted. `.cache/three-probe/` and
  `.cache/pre-promotion/` are local historical artifacts, not production sources
  or required build inputs. Do not restore the rejected ScrollBox camera.
- The PNG/image renderer was removed; native is the only renderer.
- Linux/tmux is the verified target. Do not claim macOS or broader terminal
  compatibility without checking it. Connectors, cards and the inspector are drawn by OpenTUI; Three only provides the camera projection (no GPU backend is initialised).

The inspector is docked from 120 columns and an overlay below that; under 80 columns the diagram is replaced by a node list. The diagram auto-fits on load and resize until the user pans or zooms.

Preserve the approved camera and visual design during maintenance. Propose
intentional redesigns separately; do not quietly substitute another camera.

## Design principle: informative, not a data dump

Pathlight lets an engineer follow what an AI harness is doing, understand their app, and trust an accurate picture of the code and its architecture, simply and intuitively. Show the few things that matter at a glance and keep the rest one deliberate step away (a key, a section, a command). Every new signal (badges, counts, tags, panels) must justify the space it takes, say nothing when there is nothing to say, and never crowd the line or panel it shares. The sidebar was redesigned on 2026-10-24 (Phase 1, from the Claude Design project): a ranked inspector with the component's name and purpose, then Now (its own recent calls), Connects (one row per relationship) and, on request, Files, with the actions and the question field pinned beneath, plus a status tag in each card's top border and a `now`/`last` line in the header. Phase 2 (2026-10-24) added flow mode: `F` draws a flow (a LikeC4 dynamic view, or an agent-written `*.behavior.c4` state diagram) as numbered steps on the diagram with a step reader in the sidebar, dims cards off the path and shows `≠` where a journey hop has no model relationship (a hop back over a pair an earlier step opened is its answer, `↩`, and repeated hops over one pair are one finding); flows are readings, drawn in the agent colour and kept apart from observed activity (`src/flow-view.ts`, data from `src/flows.ts`). The end-of-turn review (2026-10-26) asks for a decision only when there is one: new dependencies since the last commit that the model lacks (`pathlight diff`), shown in the header and reviewed under `c` with `y`/`n`/`e` (`src/review.ts`, `src/viewer/review-view.ts`); it adds no card and no top-level key. Do not add sections or lines to this layout unless a feature cannot work without it, and treat anything added now as provisional.

## Code ownership

| Area | Files |
| --- | --- |
| CLI, model/view selection, workspace setup (`pathlight setup` is the first run: checks, then draws a first model with `--yes`; `init` wires hooks and recording, `init --global` the OpenCode plugin for every project). Distribution: `install.sh`, `scripts/build-npm.sh` (the `@dumbbunnyio/pathlight` npm package is `npm/launcher.cjs` plus one package per platform holding its binary, and unscoped `pathlight` is `npm/pointer.cjs`, which runs it; the launcher passes its parent so `atShellPrompt` in `src/tmux.ts` still sees the shell), `tests/npm-package.test.ts` | `src/cli.ts`, `src/catalog.ts`, `src/init.ts`, `src/setup.ts`, `src/layout.ts` (the one place that names the `.pathlight/` folder and the files in it) |
| Owned tmux pane launch/replacement, readiness | `src/tmux.ts`, `src/ready.ts` |
| Native UI and camera | `src/native-viewer.ts` (wiring, widgets, the update loop, the resource scope); `src/viewer/camera.ts` (the eased Three camera, fit, reveal), `keys.ts` (what a key means in each mode, and the table `?` and the footer read), `state.ts` (selection, Back history, focus, cursors, the first selection), `compact.ts` (compact fit: one card size per view); `src/viewer/` holds what it shows as pure functions: `cards.ts` (Connects, In flows, Steps, Files), `activity-view.ts` (Now, the session summary, the header line, card tags), `help.ts`, `text.ts` (clipping, wrapping, colour fades), `card-view.ts` (a card's border and label), `inspector-view.ts` (the head, card headers and their share of the panel), `header.ts` and `footer.ts`, `pickers.ts` (search and themes), `where.ts` (which node or view has an element), and `widgets.ts` (every widget, built once); `ask-dialog.ts` (the talk and `n`), `theme-picker.ts` and `flow-mode.ts` are small controllers with their own state, and `world.ts` reads the model, mapping and checks. New screen text goes in `src/viewer/`, taking what it shows as arguments |
| Themes: OpenCode-format JSON, derived palette, live recolouring | `src/theme.ts`, `src/retheme.ts`, `src/themes/` (vendored OpenCode themes, see `NOTICE.md`), palette in `src/ui.ts` |
| Orthogonal connector routing and rasterization | `src/routes.ts` |
| Static scan and model/mapping check (`pathlight scan`, `pathlight check`). One front end per language in `src/languages/` (`index.ts` is the seam: `frontEndFor`, and what every front end gives the scan; `typescript.ts` wraps the measured tokenizer in `scan-imports.ts`; `python.ts` and `go.ts` parse with tree-sitter grammars vendored in `src/languages/grammars/` and compiled into the binary, see `NOTICE.md`). Each language is measured against its own tools: `tests/eval/facts.ts` (TypeScript, oxc-resolver), `tests/eval/facts-python.ts` with `facts_python.py` (CPython's resolver; run it on the Python the project declares), `tests/eval/facts-go.ts` (`go list`) | `src/scan.ts`, `src/scan-imports.ts`, `src/languages/`, `src/brief.ts` (`pathlight brief` lists each box's files, imports and contents for an agent to name it; `pathlight name` saves what the agent worked out as `by: "agent"`, never over a person's name), `src/check.ts` (`compareImports`, shared with `src/diff.ts`: changes since a git commit), `src/draft.ts`, `src/stale.ts` (the out-of-date stamp), `src/plan.ts` (the agent's plan, ids only), `src/review.ts` (verdicts on new dependencies, kept in `.cache/pathlight/decisions.json`) |
| Flow check (`pathlight flows`: agent-written `*.behavior.c4` against the files they name and their sync commit), flow capture (`pathlight flow add/remove`: writes a journey the agent worked out, never decides one), headless screen (`pathlight see`) | `src/flows.ts`, `src/flow-write.ts`, `src/see.ts` |
| Mapped files, editor and subprocess ownership | `src/node-files.ts`, `src/editor.ts`, `src/process.ts` |
| Activity journals, subscriptions, Claude adapter; the session pointer (where a session's conversation file is, a waiting flag, when its turn ended: `.cache/pathlight/sessions/`, written by the hooks and the OpenCode plugin) | `src/activity.ts`, `src/activity-subscriptions.ts`, `src/claude.ts`, `src/sessions.ts` |
| The talk: the inspector's second face, reading the host's conversation (Claude Code's transcript, OpenCode's `session_message` rows) into prompts and the agent's text, kept in memory only | `src/conversation.ts` (the readers), `src/viewer/talk-view.ts` (what the talk shows, pure), `src/viewer/ask-dialog.ts` (its controller, and `n`'s modal) |
| Agent integrations | `plugins/` (`plugins/opencode` targets OpenCode V2: `index.ts` is the server plugin (hooks, recording, tools, the skills, the `pathlight-tracer` subagent and `pathlight_models`), `tracer-model.ts` the pure choice of the tracer's model (pin only a tested Sonnet-class model, suggest the rest), `tui.ts` the CLI plugin that holds the slash commands because only the terminal process knows the tmux pane; `tests/opencode-live.test.ts` drives the real binary, `tests/opencode-tracer.test.ts` and `tests/opencode-package.test.ts` read the registered agent and skills back from it (the second from the packed npm package, `scripts/build-opencode.sh`, which must carry no path from the checkout); the plugin runs the `pathlight` binary from the PATH and never a checkout; `plugins/claude` is a Claude Code plugin validated with `claude plugin validate --strict`; `.claude-plugin/marketplace.json` lists it). Every folder in `plugins/claude/skills/` is a skill for both hosts (`pathlight` and `pathlight-behavior`): `pathlight init` copies them all (not into `.claude/skills` when the Claude plugin is installed: a project copy outranks the plugin's, goes stale on every update, and `init` removes the ones it wrote earlier; `pathlight doctor` flags them), the OpenCode plugin registers them all, and `tests/skill.test.ts` checks every command and flag the main one names against the CLI help (and that the behavior skill's example compiles), so update them with the CLI. `plugins/claude/agents/pathlight-namer.md` is a Sonnet subagent that names every box of a fresh draft (the `/pathlight` first run hands it the job; the OpenCode plugin registers it beside the tracer; tests/eval/names.ts scores its notes). `plugins/claude/agents/pathlight-tracer.md` is a subagent pinned to `model: sonnet` that the `d` request asks the agent to hand a trace to (the model is the point: tests/eval measured Haiku-class models failing it); `plugins/claude/open-hook.sh` handles `/pathlight:open` as a `UserPromptSubmit` hook that stops the prompt with `continue: false` (no model turn); `commands/open.md` is only the picker entry and fallback. Bump `version` in `plugins/claude/.claude-plugin/plugin.json` whenever the plugin or skill changes, or `claude plugin update` will report the old copy as current. |
| Flat and nested fixtures | `tests/fixtures/viewer/` (frozen test layout), `examples/parcel/` |
| This repo's own architecture diagram | `examples/viewer/` (LikeC4 project `pathlight`; the frozen test fixture is the project `viewer`, and two projects must not share a name), mapped by `.pathlight/pathlight.activity.json` |

## Contracts to preserve

1. **LikeC4 is authoritative.** Keep its identities, hierarchy and explicit
   `navigateTo` links; keep its arrangement (order, ranks, nesting, which side
   an edge leaves); the spacing and card sizes are Pathlight's (compact fit,
   `src/viewer/compact.ts`). Do not infer navigation from shared elements.
2. **Interaction is native.** Nodes are interactive widgets, not highlights
   over an image. Hit targets must match visible terminal cells, including group
   titles after projection, pan, zoom and resize.
3. **State survives workflows.** Search cancellation and Back restore camera and
   selection. Linked-view navigation stays in one process. Editor return retains
   the diagram and file selection. Activity updates must not move the camera or the selection unless the user turned on follow (`a`, off by default); the user's own selection or camera movement pauses it.
4. **Observation is truthful and isolated.** Bind events to workspace, project,
   source and session. Show only observed tool lifecycle states; never infer
   service traffic, test success, or parent activity from a child's event.
   Only actual active operations pulse; connectors do not imply live traffic.
5. **Recording and viewing are separate.** A bound CLI viewer consumes journals.
   OpenCode recording requires opt-in: `pathlight init` (or `init --global`) writes `record: true` on the plugin entry (the counterpart of the Claude hooks), or one session asks with `live: true`. Like the Claude hooks, `record: true` writes nothing in a workspace without a mapping.
   Automatic recording covers root sessions of the plugin's workspace only; closing a viewer does not stop recording.
   Do not silently enable recording. Claude reports a subagent's tool calls under the conversation's own `session_id`; they are recorded in that journal with the subagent's type as an `agent` label (never its id, prompt or results), shown with that label, and can be hidden with `s`. A label must never make a subagent's call look like the conversation's own, and a call that names no file is not shown as activity. OpenCode child sessions are not recorded yet; when they are, each keeps its own journal with a `parent` link and the viewer merges them under the root at read time, labelled. `--follow` is an explicit viewing choice: it tracks only the single most recently active recorded session and never starts recording. Claude hook installation by `pathlight init` is the Claude opt-in.
6. **Resource ownership is scoped.** Use Effect-returning module functions and
   scoped acquisition/finalization for renderers, polling and processes. Preserve
   signal cancellation, editor process-group cleanup, initialization/draw ordering,
   and readiness only after usable rendering. Zod remains at the OpenCode schema
   boundary; follow existing Effect schema/error conventions elsewhere.
7. **Respect the terminal and filesystem.** Never replace a repurposed pane or
   guess the user's pane from a background service. Ask-about-node types only into the pane `pathlight show` was given (`--parent`), verifies it exists, and sends literal text. Validate mapped file paths
   before editing. Treat editor commands and executable LikeC4 configuration as
   trusted-workspace inputs.
8. **Keep activity minimal.** Do not store source contents, tool arguments,
   command strings, results or error text in activity journals. A turn marker records only that a prompt began (never its text), and replay reads the same journal (up to 2048 events per session). For shell commands keep only existing workspace files the command names (state `command`, never read/edit). The talk's conversation is read from the host's own file while it is showing and never copied: the session pointer holds a path, a flag and a time only. Preserve bounded
   queues/history and local-only storage; this is not an audit log.
9. **Everything Pathlight writes into a workspace goes in `.pathlight/`** (`src/layout.ts`): the draft's model and `likec4.config.json`, the file mapping, the overlay of names and notes, and agent-written `*.behavior.c4` flows. Nothing is written loose in the root of someone's repository. Ignored, regenerated state (journals, the out-of-date stamp, overlay keys, the fingerprints `pathlight name` records so `brief --changed` can list just the boxes whose files changed) stays in `.cache/pathlight`. There is no fallback that reads the old root location. A model a person wrote elsewhere stays where it is, but its mapping still lives in `.pathlight/`.

## Development and validation

Dependencies are pinned in `package.json` and `bun.lock`; use Bun. See README
for prerequisites. Full verification needs tmux and Neovim.
Native checks need a working OpenTUI/Three backend but no browser or terminal image protocol. `src/doctor.ts` is `pathlight doctor`; `scripts/build.sh` compiles the single binary, which `tests/binary.test.ts` builds and drives. Anything read from the repository at run time (skills, themes) must be compiled in, because the binary has no checkout beside it.

```sh
bun install
bun run check
TMPDIR=/tmp/opencode bun run test
```

Create the temporary directory first if it is absent. Start with affected tests,
then run the full suite for renderer/lifecycle changes. The terminal tests use
isolated tmux servers. Do not manipulate unrelated user panes or viewers.

Test observable behavior through the real CLI/terminal where feasible. Keep
assertions on exact selected IDs, visible file rows, connector cells, and camera
position—not just footer text that can appear before layout settles. Preserve
coverage for mouse wheel handling separately from keyboard scrolling, and pan
preservation separately from zoom preservation. Avoid test-only production seams.

For a manual check, use a real terminal:

```sh
bun run pathlight view services --workspace examples/parcel --project parcel
```

For a pane beside the user, obtain their actual tmux pane ID and use `show` with
`--pane`; include `--socket` for a non-default server. Exercise both flat and nested
views, wide/narrow layouts, search/Back, editor return and activity isolation.
ANSI reconstructions are useful diagnostics, not screenshots of the user's terminal.

`scripts/ansi2png.py` renders `tmux capture-pane -e -p -N` output to a PNG so appearance changes can be inspected; it approximates your terminal's font.

Screens are kept as text: `tests/golden/*.txt` are what `pathlight see` prints for the frozen fixture at several sizes, and `tests/golden.test.ts` compares them. A change to the diagram, header, footer or inspector fails there with a readable diff; when it is meant, look at the new screen and bless it with `UPDATE_GOLDEN=1 TMPDIR=/tmp/opencode bun test tests/golden.test.ts`. `pathlight see` runs the viewer in a private tmux server, so it never touches the user's panes; it is also how an agent can check what a person would see (`--cols`, `--rows`, `--select ELEMENT`, `--keys`).

Map quality is measured, not judged: see [docs/eval.md](docs/eval.md) for the independent scan comparison (`tests/eval/facts.ts`), the model scorer and the authors' rules (`tests/eval/run.ts`). Any change to the scanner, the draft or the skill should be re-scored. Flows have their own score (`tests/eval/flows.ts`, answers in `tests/eval/references/flows.json`): re-run it after a change to `pathlight flow`, the `d` request or the behavior skill.

Keep README and the native controls document aligned with shipped behavior.
Update project intent when an approved product decision changes, distinguishing
implemented behavior from desired or unverified behavior. Bump `scanRevision` in `src/scan.ts` whenever a scanner change can alter its output for the same files: `pathlight diff` caches the base commit's scan and trusts it only for the same revision.

Do not commit or push
unless the governing session instructions explicitly permit it.
