---
name: pathlight
description: Use when the user wants to see the architecture beside the conversation (open the live viewer), or needs a LikeC4 architecture model of a codebase and its pathlight.activity.json file mapping created, extended or checked. Covers pathlight list, show, scan, check and init.
---

# pathlight

pathlight shows a LikeC4 architecture diagram in a tmux pane beside the conversation and lights up the components whose mapped files you read or edit. LikeC4 owns the model; `pathlight.activity.json` maps file globs to element ids.

## Truthfulness

- Say only what the tools reported. A scan or check is **static evidence** (imports in TypeScript and JavaScript). It does not show what runs, what is called over a network, or that a test passes.
- Never describe the diagram from memory. Open it, or run `pathlight list`, and report what happened.
- Do not invent elements or relationships to make a check pass. A relationship needs a reason you can state from the code you read.
- The viewer shows only observed tool calls. Never imply traffic between components.

## Commands

Run `pathlight --help` for every flag. If `pathlight` is not on the PATH, ask the user how it is installed (the repository's `bun link`, or `bun <repo>/src/cli.ts`).

- `pathlight list --workspace .` lists the views (id, title, project) as JSON.
- `pathlight show VIEW --workspace . --follow` opens the viewer in the user's tmux window and follows this session. Inside tmux it finds the pane itself; from a background service pass the user's actual pane with `--pane %ID` (and `--socket PATH` for a non-default tmux server). Never guess a pane.
- `pathlight scan --workspace . --out scan.json` writes the static facts: files, imports (with lines), external packages, what could not be resolved, and `coverage`.
- `pathlight check --workspace .` compares the model and mapping with a fresh scan. `--json` gives data; `--strict` exits 1 when anything is found.
- `pathlight init --workspace .` wires Claude Code hooks (`.claude/settings.local.json`, per user), the OpenCode plugin, this skill, and proposes a mapping by matching element names to files on disk. It turns on recording, so tell the user what it will write and get their agreement first. `--no-claude-hooks` skips the project-local hooks when the Claude plugin is installed.

## Show the architecture

1. `pathlight list --workspace .` and pick the overview view.
2. `pathlight show VIEW --workspace . --follow`.
3. Report only whether it opened.

## Draft a model for a codebase that has none

Aim for a diagram a person can read in one glance: roughly 8 to 25 elements, grouped by what the code is for, not by every folder. A small codebase gives a small diagram; do not pad it. For a large component, add a second view that opens it up (a view per component beats one crowded view), and link the two with `navigateTo`.

1. **Scan.** `pathlight scan --workspace . --out scan.json`. Read `coverage` first: `unscanned` lists languages the scan does not read (their dependencies are missing, so read those parts of the code yourself), and `unresolved` lists imports it could not follow.
2. **Find the boundaries.** Use the import edges to see which files belong together and which depend on which. Read a few entry points and the files at the centre of the graph; do not read everything. Filename families (`chat-*`, `auth-*`), package directories and `external` packages are all hints, not answers.
3. **Write the model.** Use `.c4` files with a `likec4.config.json`. If a `likec4-dsl` skill is available, follow it for syntax. Give each element a title, technology and a one-sentence description taken from code you read. Name each relationship for what the dependency is ("Reads the model"), not for something you did not see. A relationship on a group is supported by imports between its children. Do not install or run `likec4`: `pathlight check` loads the model itself and fails with "Invalid LikeC4 model" and the parser errors if it is wrong, so a clean check also means the model is valid.
4. **Write `pathlight.activity.json`.** `{ "version": 1, "project": "<likec4 project name>", "mappings": [{ "glob": "src/auth/**", "element": "<exact element id>" }], "ignore": ["tests/**"] }`. Globs are workspace-relative. Element ids are the full dotted ids (`backend.auth`). Use `ignore` for tests, vendored or generated code that is deliberately outside the model.
5. **Check, then adjust.** `pathlight check --workspace .` and work through it:
   - *glob matches no files*: fix the glob.
   - *source files map to no element*: map them, or add them to `ignore` if they are deliberately outside the model.
   - *no import between the mapped files*: the relationship may really run through a network call, an event or a file. Keep it if you can say how; otherwise remove it. Either import direction counts as evidence.
   - *imports with no relationship*: add a relationship when the dependency matters at this level; leave small shared helpers alone.
   - *not checkable*: an end has no mapped files; map it or accept that nothing can be checked.
6. **Show it** with `pathlight show`.
7. **Report plainly**, without asking the user to request it:
   - what the scan covered: files, imports, and anything under `unscanned` or `unresolved` (languages or imports it could not read);
   - what the model contains: elements, and the views you made;
   - what was left out: the "N source files ignored on purpose" line and the kinds of file in `ignore` (tests, tooling, examples), so they can decide whether any belongs in the diagram;
   - what `check` could not verify: relationships marked "not checkable", and relationships you kept with no import behind them, each with the reason you kept it.

On a large codebase do not stop at one flat diagram. Make an overview, then a view for each component that has several parts inside, and say which parts you did not open up.

Run `pathlight check` again after any later change to the code or the model, and report what it says without softening it.

## Keep the model honest

When files are added, moved or removed, run `pathlight check --workspace .` and tell the user what changed: new unmapped files, globs that no longer match, new imports between components. Propose the edits to the model or mapping; do not change the model silently.

## Limits

- The scan reads TypeScript and JavaScript only. It does not follow `tsconfig` `extends`, `exports` patterns or bundler aliases; what it cannot resolve is listed, not guessed.
- The viewer is for Linux with tmux. Do not claim other terminals or platforms work.
- Activity journals hold metadata only (tool, operation, file paths, time). Do not add source, commands or results to them.
