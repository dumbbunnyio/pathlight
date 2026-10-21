# Pathlight: design notes & roadmap

Oct 20, 2026 · @David Levy

## Using this doc in Claude Code

This doc condenses a claude.ai planning conversation about Pathlight so a Claude Code session can pick up the context. It was last checked against the repo at commit `ff20a58` ("working toward opencode integration", Oct 20, 2026). Export it as Markdown into the repo (it lives there as `docs/pathlight-session.md`) and point Claude Code at it. Statements marked *unverified* were not confirmed against source code or a live run.

## Where Pathlight stands

Pathlight already has the right core: LikeC4 owns model and layout, an OpenTUI viewer runs in a tmux pane beside the agent, and `pathlight check` acts as the mapping verifier. The pieces in the [public repo](https://github.com/lennox-davidlevy/pathlight):

- **Mapping:** `pathlight.activity.json` maps path globs to LikeC4 element IDs, with `ignore` and `shared` lists.
- **Scan:** `pathlight scan` reads TypeScript and JavaScript statically and writes files, imports, packages and unreadable files to `scan.json`.
- **Check:** compares scan, model and mapping. It reports globs matching no files, unclaimed source files, relationships with no import behind them, and imports with no declared relationship.
- **Recording:** Claude Code hooks (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit`) and an OpenCode V2 plugin write local journals under `.cache/pathlight/activity`, retaining 2048 events per session. Prompt submissions are recorded as turn markers with no prompt content.
- **Viewer:** lights nodes on read and edit, shows an activity inspector, `a` follows the work, `w` jumps to it, `t` asks the agent about the selected node, `T` picks one of 33 OpenCode-format themes.
- **Off-view work:** when work lands outside the open view, the header says "working in VIEW · w to go", choosing a linked view first, else the smallest view containing it. It never switches on its own.
- **Replay (shipped):** `p` steps through the session's calls; `←`/`→` step, `[`/`]` jump by turn, `space` plays, `s` sets speed.
- **OpenCode V2 (verified against 2.0.32):** a server plugin records via `tool.hook` and offers the skill and `pathlight_list`/`show`/`stop`; a CLI plugin adds `/pathlight-open` and `/pathlight`, passing the real tmux pane. `record: true` on the plugin entry is the workspace opt-in. Tested against the real OpenCode binary with a fake model.
- **Skill:** `/pathlight` teaches the agent to scan, draft the model and mapping, check until clean, then show.

## Mapping a codebase to architecture

"Perfect" means checkable: complete, every claim backed by evidence, stable across runs, and respectful of human decisions. There is no single correct architecture, so the gains come from constraining the agent with a verifier, not from a smarter agent.

**Split mechanical from judgment.** Derive deterministically: containers from deployment units (Dockerfiles, k8s deployments, build targets), datastores and queues from IaC and connection config, and file membership from rules. Leave the agent only component grouping, naming, descriptions and ambiguous cases. Seed grouping from directory and package structure plus the scan's import graph, and have the agent accept, merge, split or rename groups with reasons.

**Evidence layers**, each covering what the others miss:

| Layer | Source | Catches |
| --- | --- | --- |
| Symbol graph | pathlight scan, per-language scanners or SCIP | Component internals, call and import edges |
| Runtime | OpenTelemetry traces | Real service-to-service and DB calls, dynamic dispatch |
| Declared infra | Terraform/Pulumi/CDK state, k8s manifests | Resources, deployment topology |
| Actual infra | Cartography, Steampipe, AWS Config, Azure Resource Graph | What exists now, drift |

The hard part is identity linking: matching a code-level service to its image, k8s deployment, trace service name and cloud resources via env vars, connection strings, IAM roles and tags. That is the right job for the agent, with the graphs as ground truth.

**Gaps to close in `check`:**

- `scan` is TypeScript and JavaScript only, file-level imports. Add per-language scanners (or SCIP indexers) emitting the same `scan.json` shape, making `check` language-agnostic. Not codebase-memory-mcp: its edge recall was 45–62% in your trial.
- Network edges show no import. Let each relationship declare evidence of a kind (HTTP route plus client call site, queue topic, env var or connection string, IaC resource) and have `check` verify it exists.
- Anything unprovable gets an explicit per-edge suppression with a reason, stored like `ignore`/`shared`, so the agent loop converges and cannot re-litigate human decisions.

**Stability:** persistent element IDs; never regenerate from scratch; the agent emits diffs against the existing model; human corrections become pinned constraints the verifier enforces. Run grouping several times, keep what is consistent, and surface only disagreements. Keep an eval set of hand-curated repos and score every prompt, model or clustering change against it.

## Indexers beyond TypeScript

**Correction:** an earlier version of this doc recommended [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) as the working graph and as a `scan` adapter. Your own trial (recorded in `docs/handoff.md`) found 45–62% recall on its import edges and noise in its clusters, so drop that recommendation. `pathlight scan` stays the source of truth for TypeScript and JavaScript, and Leiden clustering on that graph is not a usable seed for grouping.

[SCIP](https://github.com/scip-code/scip) is Sourcegraph's compiler-grade index format, now under the scip-code org, with indexers for Java/Scala/Kotlin, TypeScript/JavaScript, Rust (rust-analyzer), C/C++, Ruby, Python, C#/VB, Dart and PHP. It needs a working build per language.

**For other languages:** add per-language scanners, or SCIP indexers, that emit the same `scan.json` shape (files, file-to-file edges, packages, unreadable files), so `check` stays language-agnostic. Before relying on any new source, measure it the way you measured codebase-memory-mcp: recall of import edges against a known-good scan on a real repo.

## Live updates and greenfield growth

The hot loop is a lookup, and reparsing happens only when a change alters structure.

1. **Hot path, every event:** resolve the path through the glob mapping (a path-prefix trie) to an element ID and highlight it. No parsing.
2. **Structural path, on write, debounced 300–500 ms:** reparse only the changed file with tree-sitter's incremental parser, diff its import and call summary against the cache, and stop if no element-crossing edge changed. Otherwise patch the relationship and relayout only the dirty views.
3. **Layout:** compute LikeC4 layouts once and cache coordinates and edge paths; never run Graphviz per event.
4. **Unmapped new files:** assign to the nearest ancestor's element and flag for later batch classification by the agent.

**Greenfield repos:** make growth rule-driven and call a model only at structural events: a new top-level package, a new Dockerfile or deployment manifest, a new datastore, queue or external-API dependency, or unassigned files past a threshold. Use a small model to classify files into existing components and a larger one for occasional regrouping.

Two cheap levers:

- **Stop hook check:** run `pathlight check --json` in the Claude Code `Stop` hook (and the OpenCode equivalent) and feed findings back, so the agent updates the mapping while intent is still in its context. Most turns produce no findings and cost zero model calls.
- **Architecture first:** for new repos, write the LikeC4 model as the intended architecture, have the agent build against it, and let the verifier flag code that adds relationships the model doesn't allow.

## Views and follow-mode camera

Define every view with LikeC4 predicates (`include *`, `include -> backend ->`, kinds, tags) rather than listing elements, so views can never drift from the model. The set to generate: a system landscape, a container view per system, a component view per container, a deployment view per environment from IaC, and dynamic views for main execution flows. Seed dynamic views from entry points (HTTP routes, CLI commands, queue consumers) traced through the symbol graph, confirmed against traces when available.

**Choosing the view to follow:** decide per batch, not per element.

- Pick the smallest view that contains every element touched in the batch as a node.
- If none covers them all, fall back to the view of their lowest common ancestor.
- Hysteresis: stay in the current view while it still covers the new batch.
- If the harness exposes the agent's plan or todo list, resolve the files ahead of time and pick the view before the edits start.
- Batch events over a short window and pan to fit the batch, rather than chasing each write.

**Pop-out:** the embedded viewer should be detachable into a tmux split, terminal split or separate window. Write the current view, selection and camera position to a small state file first, so the detached viewer opens where the user was looking.

## What engineers should see

The goal is to move from showing where the agent is to showing what it is doing to the architecture. Encode on the diagram itself (edge styles, outlines, glyphs) rather than adding panel text. In priority order:

1. **Architectural diff of the session:** new cross-element edges drawn dashed and bright, removed ones faded, undeclared ones flagged. Reuse it as a CI check or PR comment for reviewers who never watched live.
2. **Plan overlay:** outline the nodes the agent intends to touch and show the current plan item in the header; a highlight landing outside the outline means the agent has wandered.
3. **Rules at edit time:** a `PreToolUse` hook warns or blocks (by config) when an edit would introduce an undeclared dependency, naming the relationship it violates.
4. **Blast radius:** dimly tint the dependents of a node being edited.
5. **Trouble glyphs:** edit/fail thrash on the same files, tool failures, and new `check` findings.
6. **Change magnitude:** lines added and removed, or heat, instead of raw read/edit counts.
7. **Parallel agents:** several sessions on one view, each in its own color, surfacing collisions.
8. **Timeline strip:** replay shipped (p). Still open: a one-row strip of session activity over time, colored by node, as a visual scrubber for it.
9. **Zero-to-diagram onboarding:** a `pathlight bootstrap` that scans, proposes containers and components, has the agent refine them, and loops on `check` until clean.

Build the edge diff and plan overlay first.

## Subagent visibility

Subagent work goes missing because of Pathlight's own code, not the harnesses. Both harnesses expose what's needed; as of `ff20a58` Pathlight discards it.

- **OpenCode (`plugins/opencode/index.ts`):** auto-recording writes only when `known.root || !pending.auto`. Child sessions are never watched, so with `record: true` every subagent call is discarded. Subagents are child sessions with `parentID` ([issue #15403](https://github.com/anomalyco/opencode/issues/15403) notes hooks don't carry the parent identity, but walking `parentID` works).
- **Claude Code (`src/claude.ts`):** the hook schema decodes neither `agent_id` nor `agent_type`, which the [hooks reference](https://code.claude.com/docs/en/hooks) says tool events carry inside subagents. *Unverified:* whether a subagent's `session_id` equals the parent's. If it does, subagent calls merge invisibly into the parent journal; if not, they form a separate session that `--follow` jumps to.
- **Fix, both harnesses:** add an optional `agent` field to `ActivityEvent`. Claude: fill it from `agent_type`. OpenCode: resolve child sessions to their root via `parentID`, record under the root, and set `agent` to the child's agent name. The viewer can then show subagent work in a second color.

Next step: log one raw Claude hook payload from inside a subagent to settle the `session_id` question, then implement the fix.

## Distribution

Target: Claude Code setup is two commands plus `/pathlight`; OpenCode is one config line. Today a user needs Bun, Node, tmux, `flock`, `bun link`, a local-path marketplace, a plugin install and a per-project `init`.

**Fix now, before distribution work:**

- **`opencode.json` leaks a home path and double-registers.** It lists the plugin as `./plugins/opencode` and again as `/home/david/Projects/github/visualize-work/plugins/opencode` with `record: true`. Locally that likely records every call twice; for anyone else the path doesn't exist. Keep one relative entry and put `record: true` in a local or user config.
- **Hooks still depend on `bun link`.** `plugin.json` says so, and every hook checks `command -v pathlight`, so on a machine without the link the hooks silently record nothing. `pathlight doctor` should catch this until the binary ships.
- **`docs/handoff.md` is stale:** dated Oct 18, says all work is uncommitted and lists 62 tests. Refresh it or fold it into this doc, since agents read it as current.

1. **One compiled binary:** `bun build --compile` bundles the Bun runtime and cross-compiles for macOS and Linux on x64 and arm64. Publish on GitHub Releases, with a Homebrew tap or `curl | sh`. Test first that OpenTUI's native library loads from a compiled binary and that LikeC4's layout dependencies bundle.
2. **Plugin fetches the binary:** host the marketplace on GitHub (`owner/repo`). A SessionStart hook checks `${CLAUDE_PLUGIN_DATA}` and downloads the right binary on a miss; hooks call that path instead of relying on PATH.
3. **No required `init`:** hooks already no-op without a mapping; make `/pathlight` detect a missing model or mapping and run the bootstrap.
4. **OpenCode on npm:** one package name in the `plugin` array of `opencode.json`, downloading the same binary on first load.
5. **Drop `flock`:** use an in-process lock (exclusive-create lockfile or `mkdir`).
6. **`pathlight doctor`:** checks tmux, binary, hooks, mapping and workspace and prints the fix for each failure; the skill runs it on any error.

Start with the compiled binary; everything else depends on having one artifact to fetch.

## Surfaces beyond tmux

Aim for one core (model, layout, activity, view state) with thin renderers on top, so each new surface is a few hundred lines rather than a port.

&#91;embedded content: renderer architecture · 1 core, 4 renderers\]

- **Pane backends:** tmux becomes one backend among Kitty (`kitty @ launch --location=vsplit`), WezTerm (`wezterm cli split-pane`), Zellij (`zellij run`), iTerm2 and Windows Terminal (`wt -w 0 sp`), detected by env vars. Fallback: tell the user to run `pathlight view --follow` in another window.
- **OpenCode TUI:** v2 plugins render OpenTUI elements in Solid JSX into slots, including `session.panel`, opened with `context.ui.panel.open(name)` ([docs](https://opencode.ai/v2/docs/build/plugins/cli/)). The viewer must become a mountable component. Importing `@opentui/solid` from plugins has been fragile ([issue #42338](https://github.com/anomalyco/opencode/issues/42338)); pin versions.
- **Claude Code terminal:** a mod opens a pane with `$.ui.open`; it docks beside the transcript in fullscreen from 110 columns, inline above the prompt otherwise. The terminal surface has `Raster` (a cell grid up to 512×256, repainted with `$.ui.blit`) and `Client` (a surface module with its own input and state). Run OpenTUI headless and copy its cell buffer into a Raster.
- **Claude Code desktop, VS Code, mobile:** no Raster, but an `Svg` element (up to 131,072 characters, script-less sandbox with hover and SMIL when `interactive`). Draw SVG from LikeC4's cached layout. LikeC4's React renderer cannot run there.
- **Browser pop-out:** use LikeC4's own web renderer (`likec4 serve`, `likec4 codegen react`, Vite plugin) with lit-node styles overlaid. *Unverified* whether OpenCode desktop renders v2 plugin surfaces; if not, this covers it.

## Brand and website

The mark is a pen-and-ink lamppost: one lit lamp in the foreground beside a curving path, with unlit lamps receding along it. The lamps are nodes and the path is the work moving through them, which is follow mode in one image. A [design canvas](https://claude.ai/artifact/Gjtg1FhZcpRdd1ZbeH6TC1) holds the logo sheet and a landing-page draft.

- **Drawing:** ink it by hand (paper or Procreate), then vectorize (Illustrator Image Trace, vtracer or potrace) for the SVG; keep the raster for the hero.
- **Small sizes:** the lantern alone, lit, for favicon and avatar.
- **Wordmark:** lowercase "pathlight" in IM Fell English; body in EB Garamond; code and TUI in JetBrains Mono.
- **Palette:** ink #1C1B19, paper #FBFAF7, lamp #E0A43A (glow only), ember #9A6512 for accent text.
- **Site:** a sticky hero with the scene in three layers that scale from the vanishing point as you scroll, lamps lighting one by one, then How it works, an animated TUI demo, install, footer. Swap the demo's placeholder service names for the parcel example before launch.

## Suggested order and open questions

1. Clean up `opencode.json` (one relative entry, `record: true` moved to local config) and refresh `docs/handoff.md`.
2. Log a raw Claude hook payload from a subagent; add the `agent` field and record subagent work in both harnesses.
3. Evidence declarations and per-edge suppressions in `check`; `check` in the `Stop` hook.
4. Compiled binary, GitHub-hosted marketplace, self-fetching plugin, `pathlight doctor`.
5. Architectural edge diff and plan overlay in the viewer.
6. Split the viewer into core plus renderers; OpenCode `session.panel`.
7. Claude Code Raster spike; SVG renderer for desktop; browser pop-out on LikeC4's renderer.
8. Per-language scanners for repos beyond TypeScript, each measured for edge recall before use.

**Open questions**

- [ ] Does a Claude Code subagent's hook `session_id` match the parent's?
- [ ] Do OpenCode v2 plugin hooks fire for child-session tool calls? Likely yes: the plugin already receives them and filters them out by parentID; confirm with a live subagent run.
- [ ] Does OpenTUI's native library load inside a `bun build --compile` binary?
- [ ] Can the viewer mount as a component, or does the camera code assume it owns the renderer?
- [ ] Is a Raster repaint fast enough for camera glides in Claude Code?
- [ ] Do OpenCode v2 plugin surfaces render in OpenCode desktop?
