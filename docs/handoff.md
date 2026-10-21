# Handoff (2026-10-21, branch `main`)

## State
- Native viewer, scan/check, themes, `w` off-view hint, replay (`p`), the OpenCode V2 plugin and Claude subagent labels (`agent` field, `s` toggle) are built. Everything since `6ed4311` is uncommitted unless the user says otherwise.
- **Map quality is the launch gate** and is measured: see `docs/eval.md`. The scan is checked against an independent reference (`tests/eval/facts.ts`), models are scored (`tests/eval/run.ts`, authors' rules in `tests/eval/references/opencode.json`), and planted-defect tests (`tests/eval.test.ts`) keep the scorer honest. The pinned repo is `.cache/eval/opencode-installed` (opencode at 5fa426f68d, `bun install --ignore-scripts`); rebuild it from `docs/eval.md`.
- `pathlight draft` (`src/draft.ts`) writes a deterministic first picture from the imports: packages, components (small folders and loose files in two collections), relationships with import counts, and views for the landscape, each package, each component's neighbourhood and import cycles. Views are capped (about 16 boxes in an overview, 20 in any readable view, line counts bounded so the layout stays fast) with complete listings declared under `entries` in the mapping. Ids and names come from the code only; there is no overlay file yet.
- `planned` in `pathlight.activity.json` marks elements designed but not built; `check` reports the plan, the viewer draws them dashed with `[planned]`, and the skill (plugin 0.1.10) teaches it.
- Scanner: `package.json` `exports`/`imports` (patterns and runtime conditions) are resolved with `resolve.exports`; the 400-token cap on an import's name list was a real bug and is fixed. No native dependency ships.
- codebase-memory-mcp and SCIP were trialled on opencode `packages/core`: neither replaces the scan (see `memory/map-pipeline-direction.md`).

## Done since the last handoff (2026-10-21, uncommitted)
- Overlay (`pathlight.overlay.json`) keyed by what the code is, so ids can move: titles, notes, merges, splits, relationship titles, each with `by: human|agent`. Entries that contradict the code are skipped and reported; a human entry that differs from the last commit is reported (git, not enforcement).
- `diff` keeps the base commit's scan (`.cache/pathlight/base`, latest commit only, scanner revision checked): about 1 s saved of 4.6 s on opencode.
- Agent-written baseline on `camenae` and `camenae-sdk` and pass marks: `docs/eval.md`. The scorer cannot judge grouping or descriptions.
- Out-of-date badge: every `check` writes `.cache/pathlight/stale.json`; the Stop hook runs `check --quiet`; the viewer shows the counts and their age.
- `pathlight diff [--base REV]` (relationships backed or lost since a commit, new undeclared pairs), drawn in the viewer: added solid green, lost dotted red. `check`'s import logic is shared as `compareImports`.
- `pathlight plan ELEMENT ...` (ids only): outlined purple, activity outside it marked `off plan`.
- Plugin 0.1.14 (new hooks.json `Stop`, skill sections for overlay, diff, plan). Run `claude plugin update` after publishing.

## Redesign, to do (user asked, not started)
The user finds the sidebar, its sections, their behaviour and where information appears too much of a data dump. Rework them so the viewer is informative but simple, with detail one step away. Plan it with the user before building. Until then, add nothing to the layout beyond what a feature needs (see AGENTS.md, design principle).

### Editing the map from the viewer (built 2026-10-21: `m`, `n`)
Three separate actions on a selected box, each with its own key and its own meaning. No toggles inside a dialog.
- **Ask a question** (`t`, exists): the answer comes back in chat; nothing is edited.
- **Ask the agent to change the map** (`m`, own dialog): the prompt carries the box's overlay key, files and connections, and tells the agent to read the files, answer in chat, then edit `pathlight.overlay.json` with `"by":"agent"` and run `pathlight draft`. Names and notes are applied directly; merges and splits are proposed in chat first and wait for a yes.
- **Edit it yourself** (`n`, small form, prefilled Name and Note): the viewer writes the overlay with `"by":"human"` (a pin) and regenerates. No agent.
- Needs `draft` to write each element's overlay key into the generated model so the viewer can read it. Applies to generated drafts only; a hand-written LikeC4 model needs `.c4` edits.
- Marking several boxes (merge candidates) is a later step: marks tint boxes, Esc clears, invalid marks (different packages, loose files) are greyed.
- Provenance ("set by you" / "set by agent", pin, revert) shows only in the inspector Overview.

### Behavior views (built 2026-10-21)
Skill `pathlight-behavior`; `*.behavior.c4` files survive `draft`, which keeps their `#behavior` flows out of the flat top views; `#bug`/`#fixed` colour a box. Not built: state-to-file activity lighting (a file maps to one element, so it would need multi-mapping), arrow text, an automatic stale check (the skill has the agent diff against the commit in the view description).

## Next (in order)
1. Packaging, in progress. Done 2026-10-21: `flock` replaced by a pid lockfile (`acquireLock` in `src/tmux.ts`, `tests/lock.test.ts`); `scripts/build.sh` (`bun run build`) compiles `dist/pathlight-OS-ARCH` (124 MB, Linux x64 verified); the compiled binary drafts, checks, inits (skills are compiled in), opens its own viewer pane (`tests/binary.test.ts`); `pathlight doctor`. Not done: build and test on macOS and arm64 (OpenTUI's native library is a package per platform, so build each on its own runner; cross-compiling fails); GitHub Releases and a CI matrix; the Claude plugin's hooks still run `bun src/cli.ts` or need `pathlight` on PATH, so they must fetch or call the binary; `init` skips hooks and OpenCode registration when it has no checkout (the plugins supply them); the OpenCode npm package; a no-`init` first run.
2. Python/Go scanners after the TypeScript gate; languages without one show "relationships unverified".
3. OpenCode child-session recording, the read-time rollup, and the OpenCode Stop-equivalent for the badge, diff and plan: parked until the Claude side is finished.
4. Sidebar/information redesign (see above), planned with the user first.
5. Known: `tests/file-click.test.ts` (about 1 in 9) and `follow-work` are timing flakes; one readable draft view can exceed its box budget by a couple; a selected node's connector hides its added/lost tint; the Stop hook does two full scans per turn (about 6 s on the 5,000-file opencode repo, under 1 s on small repos); human pins are reported when they change, not enforced.

## Gotchas
- Quiet, low-contrast, amber accent; accent bar stays off; no diagonals; key labels are words, not glyphs.
- Terminal tests run in narrow panes: the viewer is in list mode under 80 columns and the inspector is an overlay under 120. Assert on stable text, wait after `Escape`, and after a `resize-window` wait for the frame to settle before sending keys.
- Kill leftover tmux servers (`/tmp/c4f-*.sock`) after failed runs; they slow the suite.
- `tests/file-click.test.ts` is flaky (about 1 in 8) and `follow-work` is timing-sensitive.
- Visual checks: `scripts/ansi2png.py`. Show the viewer with `bun src/cli.ts show live --project viewer --workspace . --follow --pane <claude pane>`.
- codebase-memory-mcp was trialled and rejected as a scan source (45-62% import-edge recall, noisy clusters). `pathlight scan` stays the source of truth for TypeScript/JavaScript.
- Do not commit unless the user says so.
