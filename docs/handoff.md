# Handoff (2026-10-18, branch `relook`)

## State
- The designer's refinement is implemented and **uncommitted** (commit was blocked by the permission classifier): orthogonal H-V-H routing (`src/routes.ts`), single-border cards clamped inside their group frame, no bold/all-caps, three text levels, one bottom status row, content-sized inspector sections, nested files tree, activity grid.
- `bun run check` is clean; `TMPDIR=/tmp/opencode bun run test` passes (50). `docs/native-viewer.md` Interface/live sections are updated; README and AGENTS.md are not yet.
- The user has seen it running and loves it.

## Next: modals
- Modals are built with `makeModal` in `src/native-viewer.ts` (help `?`, session summary `c`, ask `t`, go-to-view `g`).
- The user has updated modal designs in Claude Design (the `claude-design` MCP is available, read-only use; `/design-login` may be needed).
- Still all-caps/old style in modals: help headings (`NAVIGATE`, `INSPECT AND ACT`), summary (`COMPONENTS TOUCHED`/`FILES EDITED` are now lowercase), check the rest.
- Tests that assert modal text: `tests/ask.test.ts`, `tests/goto.test.ts`, `tests/follow.test.ts`.

## Remaining designer items
- Fit and centre on load and resize (auto-fit until the user pans/zooms).
- Width < 120: inspector as an overlay toggled by `i`; width < 80: node-list mode.
- Mouse: first click focuses a section header, second folds.
- Respect terminal background; 256-colour fallback.
- Update README and AGENTS.md for the new look.

## After that
Write the c4view skill (installed by `c4view init`), then try it in a fresh repo.

## Gotchas
- Quiet, low-contrast, amber accent; accent bar stays off; no diagonals.
- Tests run in narrow tmux panes: status text can clip. Assert on stable text, press `4` to open the Activity section before checking its rows, and wait after `Escape`.
- Kill leftover tmux servers (`/tmp/c4f-*.sock`) after failed runs; they slow the suite.
- Visual checks: `scripts/ansi2png.py`. Show the viewer with `bun src/cli.ts show live --project viewer --workspace . --follow --pane <claude pane>`.
- Do not commit unless the user says so.
