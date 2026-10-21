# Engineering guide

## Purpose and reading order

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

Pathlight lets an engineer follow what an AI harness is doing, understand their app, and trust an accurate picture of the code and its architecture, simply and intuitively. Show the few things that matter at a glance and keep the rest one deliberate step away (a key, a section, a command). Every new signal (badges, counts, tags, panels) must justify the space it takes, say nothing when there is nothing to say, and never crowd the line or panel it shares. The sidebar's sections, their behaviour and where each piece of information lives are due a deliberate redesign (not started, requested by the user on 2026-10-21): do not add more sections or lines to the current layout in the meantime unless a feature cannot work without it, and treat anything added now as provisional.

## Code ownership

| Area | Files |
| --- | --- |
| CLI, model/view selection, workspace setup | `src/cli.ts`, `src/catalog.ts`, `src/init.ts` |
| Owned tmux pane launch/replacement, readiness | `src/tmux.ts`, `src/ready.ts` |
| Native UI and camera | `src/native-viewer.ts` |
| Themes: OpenCode-format JSON, derived palette, live recolouring | `src/theme.ts`, `src/retheme.ts`, `src/themes/` (vendored OpenCode themes, see `NOTICE.md`), palette in `src/ui.ts` |
| Orthogonal connector routing and rasterization | `src/routes.ts` |
| Static scan and model/mapping check (`pathlight scan`, `pathlight check`) | `src/scan.ts`, `src/scan-imports.ts`, `src/check.ts` (`compareImports`, shared with `src/diff.ts`: changes since a git commit), `src/draft.ts`, `src/stale.ts` (the out-of-date stamp), `src/plan.ts` (the agent's plan, ids only) |
| Mapped files, editor and subprocess ownership | `src/node-files.ts`, `src/editor.ts`, `src/process.ts` |
| Activity journals, subscriptions, Claude adapter | `src/activity.ts`, `src/activity-subscriptions.ts`, `src/claude.ts` |
| Agent integrations | `plugins/` (`plugins/opencode` targets OpenCode V2: `index.ts` is the server plugin (hooks, recording, tools, the skill), `tui.ts` the CLI plugin that holds the slash commands because only the terminal process knows the tmux pane; `tests/opencode-live.test.ts` drives the real binary; `plugins/claude` is a Claude Code plugin validated with `claude plugin validate --strict`; `.claude-plugin/marketplace.json` lists it). Every folder in `plugins/claude/skills/` is a skill for both hosts (`pathlight` and `pathlight-behavior`): `pathlight init` copies them all, the OpenCode plugin registers them all, and `tests/skill.test.ts` checks every command and flag the main one names against the CLI help (and that the behavior skill's example compiles), so update them with the CLI. `plugins/claude/open-hook.sh` handles `/pathlight:open` as a `UserPromptSubmit` hook that stops the prompt with `continue: false` (no model turn); `commands/open.md` is only the picker entry and fallback. Bump `version` in `plugins/claude/.claude-plugin/plugin.json` whenever the plugin or skill changes, or `claude plugin update` will report the old copy as current. |
| Flat and nested fixtures | `tests/fixtures/viewer/` (frozen test layout), `examples/parcel/` |
| This repo's own architecture diagram | `examples/viewer/`, mapped by `pathlight.activity.json` |

## Contracts to preserve

1. **LikeC4 is authoritative.** Keep its identities, hierarchy, layout and
   explicit `navigateTo` links. Do not infer navigation from shared elements.
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
   OpenCode recording requires opt-in: `pathlight init` writes `record: true` on the plugin entry (the counterpart of the Claude hooks), or one session asks with `live: true`.
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
   command strings, results or error text in activity journals. A turn marker records only that a prompt began (never its text), and replay reads the same journal (up to 2048 events per session). For shell commands keep only existing workspace files the command names (state `command`, never read/edit). Preserve bounded
   queues/history and local-only storage; this is not an audit log.

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

Map quality is measured, not judged: see [docs/eval.md](docs/eval.md) for the independent scan comparison (`tests/eval/facts.ts`), the model scorer and the authors' rules (`tests/eval/run.ts`). Any change to the scanner, the draft or the skill should be re-scored.

Keep README and the native controls document aligned with shipped behavior.
Update project intent when an approved product decision changes, distinguishing
implemented behavior from desired or unverified behavior. Bump `scanRevision` in `src/scan.ts` whenever a scanner change can alter its output for the same files: `pathlight diff` caches the base commit's scan and trusts it only for the same revision.

Do not commit or push
unless the governing session instructions explicitly permit it.
