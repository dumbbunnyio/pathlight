# Handoff (2026-10-20, branch `main`)

## State
- Native viewer, scan/check, themes, `w` off-view hint, replay (`p`) and the OpenCode V2 plugin (verified against 2.0.32) are built and committed up to `ff20a58`. See `AGENTS.md` for the contracts and `docs/native-viewer.md` for controls.
- `docs/pathlight-session.md` is the planning doc for the release push. Where it and this file differ, it wins.
- `opencode.json` lists only the relative `./plugins/opencode` entry. It used to carry a second, absolute-path entry with `record: true` (written by `pathlight init`), which double-registered the plugin and leaked a home directory. Recording in this repo is opt-in again: `live: true` on a request, or a local override that is not committed.

## Agreed plan (in order)
1. Clean up `opencode.json`, refresh this file. (done)
2. Log one raw Claude hook payload from inside a subagent (is `session_id` the parent's?). In parallel, spike `bun build --compile`: does OpenTUI's native library load, and does LikeC4's layout bundle?
3. Subagents: add `agent` and `parent` to `ActivityEvent`; OpenCode records child sessions to their own journals with `parent`; Claude fills `agent` from `agent_type` (and `agent_id`). The viewer merges children under the root at read time, with labels, as a toggle; `--follow` resolves to the root. This amends AGENTS.md contract 5 (no subagent aggregation): do that with the code, with the user's approval.
4. Drop `flock` (it breaks macOS: `src/tmux.ts` spawns it unconditionally), then packaging (compiled binary, self-fetching plugin, no required `init`), `pathlight doctor`, and a real macOS check. `pathlight init` writes an absolute plugin path into `opencode.json`; fix that with packaging.
5. `check` upgrades (evidence declarations, per-edge suppressions with reasons), `check --json` in the `Stop` hook, a stale-model badge in the viewer.
6. Edge diff (labelled static), then plan overlay (node IDs only, never plan text).
7. After launch: renderer split, OpenCode `session.panel`, Raster/SVG surfaces, browser pop-out, per-language scanners (measure edge recall first).

## Gotchas
- Quiet, low-contrast, amber accent; accent bar stays off; no diagonals; key labels are words, not glyphs.
- Terminal tests run in narrow panes: the viewer is in list mode under 80 columns and the inspector is an overlay under 120. Assert on stable text, wait after `Escape`, and after a `resize-window` wait for the frame to settle before sending keys.
- Kill leftover tmux servers (`/tmp/c4f-*.sock`) after failed runs; they slow the suite.
- `tests/file-click.test.ts` is flaky (about 1 in 8) and `follow-work` is timing-sensitive.
- Visual checks: `scripts/ansi2png.py`. Show the viewer with `bun src/cli.ts show live --project viewer --workspace . --follow --pane <claude pane>`.
- codebase-memory-mcp was trialled and rejected as a scan source (45-62% import-edge recall, noisy clusters). `pathlight scan` stays the source of truth for TypeScript/JavaScript.
- Do not commit unless the user says so.
