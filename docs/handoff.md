# Handoff (2026-10-21, branch `main`)

## State
- Native viewer, scan/check, themes, `w` off-view hint, replay (`p`), the OpenCode V2 plugin and Claude subagent labels (`agent` field, `s` toggle) are built. Everything since `6ed4311` is uncommitted unless the user says otherwise.
- **Map quality is the launch gate** and is measured: see `docs/eval.md`. The scan is checked against an independent reference (`tests/eval/facts.ts`), models are scored (`tests/eval/run.ts`, authors' rules in `tests/eval/references/opencode.json`), and planted-defect tests (`tests/eval.test.ts`) keep the scorer honest. The pinned repo is `.cache/eval/opencode-installed` (opencode at 5fa426f68d, `bun install --ignore-scripts`); rebuild it from `docs/eval.md`.
- `pathlight draft` (`src/draft.ts`) writes a deterministic first picture from the imports: packages, components (small folders and loose files in two collections), relationships with import counts, and views for the landscape, each package, each component's neighbourhood and import cycles. Views are capped (about 16 boxes in an overview, 20 in any readable view, line counts bounded so the layout stays fast) with complete listings declared under `entries` in the mapping. Ids and names come from the code only; there is no overlay file yet.
- `planned` in `pathlight.activity.json` marks elements designed but not built; `check` reports the plan, the viewer draws them dashed with `[planned]`, and the skill (plugin 0.1.10) teaches it.
- Scanner: `package.json` `exports`/`imports` (patterns and runtime conditions) are resolved with `resolve.exports`; the 400-token cap on an import's name list was a real bug and is fixed. No native dependency ships.
- codebase-memory-mcp and SCIP were trialled on opencode `packages/core`: neither replaces the scan (see `memory/map-pipeline-direction.md`).

## Done since the last handoff (2026-10-21, uncommitted)
- Overlay (`pathlight.overlay.json`, titles and notes keyed by what the code is, so ids can move) applied by `pathlight draft`; unknown keys are reported. Merges, splits and pinned relationship decisions are not built.
- Agent-written baseline on `camenae` and `camenae-sdk` and pass marks: `docs/eval.md`. The scorer cannot judge grouping or descriptions.
- Out-of-date badge: every `check` writes `.cache/pathlight/stale.json`; the Stop hook runs `check --quiet`; the viewer shows the counts and their age.
- `pathlight diff [--base REV]` (relationships backed or lost since a commit, new undeclared pairs), drawn in the viewer: added solid green, lost dotted red. `check`'s import logic is shared as `compareImports`.
- `pathlight plan ELEMENT ...` (ids only): outlined purple, activity outside it marked `off plan`.
- Plugin 0.1.14 (new hooks.json `Stop`, skill sections for overlay, diff, plan). Run `claude plugin update` after publishing.

## Next (in order)
1. Pinned human decisions in the overlay (merges, splits, relationship titles) and a check that rejects an overlay entry that contradicts the code.
2. Base-commit scan cache for `diff` (the Stop hook now does two scans per turn; about 3 s on the whole opencode repo).
3. Packaging: drop `flock` (breaks macOS), compiled binary (works on Linux x64; the dependency now has no native code), `pathlight doctor`, macOS check.
4. Python/Go scanners after the TypeScript gate; languages without one show "relationships unverified".
5. OpenCode child-session recording, the read-time rollup, and the OpenCode Stop-equivalent for the badge, diff and plan: parked until the Claude side is finished.
6. Known: `tests/file-click.test.ts` (about 1 in 9) and `follow-work` are timing flakes; one readable draft view can exceed its box budget by a couple; a selected node's connector hides its added/lost tint.

## Gotchas
- Quiet, low-contrast, amber accent; accent bar stays off; no diagonals; key labels are words, not glyphs.
- Terminal tests run in narrow panes: the viewer is in list mode under 80 columns and the inspector is an overlay under 120. Assert on stable text, wait after `Escape`, and after a `resize-window` wait for the frame to settle before sending keys.
- Kill leftover tmux servers (`/tmp/c4f-*.sock`) after failed runs; they slow the suite.
- `tests/file-click.test.ts` is flaky (about 1 in 8) and `follow-work` is timing-sensitive.
- Visual checks: `scripts/ansi2png.py`. Show the viewer with `bun src/cli.ts show live --project viewer --workspace . --follow --pane <claude pane>`.
- codebase-memory-mcp was trialled and rejected as a scan source (45-62% import-edge recall, noisy clusters). `pathlight scan` stays the source of truth for TypeScript/JavaScript.
- Do not commit unless the user says so.
