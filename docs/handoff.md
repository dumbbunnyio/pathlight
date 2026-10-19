# Handoff (2026-10-18, branch `relook`)

## State (all uncommitted)
- Designer refinement, modal redesign, responsive layouts (auto-fit on resize until pan/zoom, inspector overlay below 120 columns, node list below 80), header click focus-then-fold and the 256-colour fallback are implemented and documented in `docs/native-viewer.md`.
- `pathlight scan` and `pathlight check` are built (`src/scan.ts`, `src/scan-imports.ts`, `src/check.ts`; format and limits in `docs/scan.md`). This repository's own model (`examples/viewer`) and `pathlight.activity.json` pass `check --strict`, and a test keeps them that way.
- The `pathlight` skill is `plugins/claude/skills/pathlight/SKILL.md`; `pathlight init` copies it. `tests/skill.test.ts` guards it against CLI drift.
- `bun run check` is clean; `TMPDIR=/tmp/opencode bun run test` passes (62).

## Next
1. Try the whole flow in a fresh repo: `/home/david/Projects/github/camenae` and `camenae-sdk`. Work in a scratch copy (the repos stay untouched): scan, draft a model and mapping following the skill, run `pathlight check` until clean, open the viewer. Note what the skill fails to teach.
2. Cleanup pass in Effect (skill at `~/.claude/skills/effect`): `src/ui.ts` reads `process.env` at import time (should be `Config`), service layers for tmux/editor/catalog, activity polling and live reload as `Stream`/`Schedule`. Leave the viewer's render and camera internals imperative.
3. Open decisions: following the terminal's own background/theme (the viewer paints a fixed dark palette), `g` picker grouping, project switching, collapsible groups, an optional codebase-memory-mcp adapter for non-TypeScript languages, routes and infrastructure files (trialled: its import edges had 45-62% recall and its clusters were noise, so it is not a replacement for the scan).

## Gotchas
- Quiet, low-contrast, amber accent; accent bar stays off; no diagonals; key labels are words, not glyphs.
- Terminal tests run in narrow panes: the viewer is in list mode under 80 columns and the inspector is an overlay under 120. Assert on stable text, wait after `Escape`, and after a `resize-window` wait for the frame to settle before sending keys.
- Kill leftover tmux servers (`/tmp/c4f-*.sock`) after failed runs; they slow the suite.
- Visual checks: `scripts/ansi2png.py`. Show the viewer with `bun src/cli.ts show live --project viewer --workspace . --follow --pane <claude pane>`.
- Do not commit unless the user says so.
