---
name: pathlight
description: Use when the user wants to open, show or draw the architecture diagram of a codebase, see which components the agent is touching as it works, or have a LikeC4 architecture model and its pathlight.activity.json file mapping created, extended or checked. Invoke as /pathlight, optionally with a view id. Covers pathlight list, show, scan, check and init.
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
- `pathlight draft --workspace .` writes a first picture made from the code alone (packages, folders, the imports between them, several views); see the next section. `--out DIR` writes it elsewhere.
- `pathlight doctor --workspace .` checks tmux, the model, the file mapping and the plugin and prints the fix for each failure. Run it first when the viewer does not open or nothing is recorded.
- `pathlight init --workspace .` wires Claude Code hooks (`.claude/settings.local.json`, per user), the OpenCode plugin, this skill, and proposes a mapping by matching element names to files on disk. It turns on recording, so tell the user what it will write and get their agreement first. `--no-claude-hooks` skips the project-local hooks when the Claude plugin is installed.

## Show the architecture

1. `pathlight list --workspace .` and pick the overview view.
2. `pathlight show VIEW --workspace . --follow`. If the user named a view (for example `/pathlight services`), show that one.
3. Report only whether it opened.

If `list` returns no views the workspace has no model yet. Say so, and offer to draft one. Name the files you would write before writing them (`likec4.config.json`, `model.c4`, `views.c4` or similar, and `pathlight.activity.json`), and where. Prefer the repository root unless the project already keeps documentation elsewhere. Write nothing until the user agrees, then follow the draft workflow below.

## A quick draft from the code

When the code already exists and the user wants something to look at straight away, `pathlight draft --workspace .` writes `pathlight.model.c4`, `pathlight.activity.json` and `likec4.config.json` with no judgement involved: each package is a box, top-level folders are components (small folders and loose files share a collection each), and a relationship exists wherever files in one component import files in another, labelled with the import count. It also writes views for the landscape, the inside of each package, each component's neighbourhood, and import cycles. Every name is a folder or file name and every description is a count. Say that plainly: it shows what the code does, not what it is for.

It never rewrites a model the user wrote (use `--out DIR`), and what it writes is generated: rerun it instead of editing those files by hand. To give a draft better names or a note on what a part is for, write `pathlight.overlay.json` next to it and rerun `pathlight draft`: `{"version":1,"elements":{"packages/core/src/session":{"title":"Sessions","note":"Runs one conversation turn"}}}`. Keys are what the code is (a package directory, a folder path, a file path, or `<directory>#small` / `<directory>#loose` for a collection), not the generated ids, so a name survives when an id moves. A title is at most 60 characters and a note 300; only read the code you are naming. Keys that match nothing are listed after the run: fix or remove them. The overlay can also correct structure: `"merges":[{"title":"Data store","keys":["<folder path>","<folder path>"],"by":"agent"}]` (several folders are one component), `"splits":[{"key":"<folder path>","by":"agent"}]` (a folder becomes one component per subfolder) and `"relationships":[{"from":"<key>","to":"<key>","title":"reads and writes rows","by":"agent"}]` (a label for an arrow imports already support). Mark what you add `"by":"agent"`. Never change or remove an entry marked `"by":"human"`: those are the user's decisions, and `draft` reports one that differs from the last commit. Propose a merge, split or title only for something you checked in the code. An entry that contradicts the code is skipped and listed after the run, so read that list and fix or drop those entries. The overlay never adds files or invents an arrow. If the user wants different groupings, write a model yourself as below.

## Draft a model for a codebase that has none

Aim for a diagram a person can read in one glance. Build it in levels: a few groups (3 to 7) that say what the code is for, and inside each group its parts. A flat row of 14 boxes is not a readable diagram. A small codebase gives a small diagram; do not pad it. Give every group its own view that opens it up, and link the overview to each: in the overview write `include camenae.web with { navigateTo web }` so the group opens its view (press `o` in the viewer).

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
   - *views with no navigateTo pointing to them*: a diagram has one entry, the overview. Link the others from it, as above.
   - *an element has many elements side by side*: group related ones under a parent and give each group its own view (see below). Do not leave more than about 7 elements at one level.
   - *an element holds many of the mapped files*: the report lists the folders inside it. Split it along them if they are different parts of the system; otherwise leave it and say so.
   - *shared types and utilities that everything imports*: list the element in `"shared": ["<element id>"]` in `pathlight.activity.json`, so `check` stops asking for a relationship to it. Only do this for code that is genuinely used everywhere.
   - *two elements import each other* (`check` says "both ways"): draw one relationship in the direction the stronger dependency runs, say in its description that the other direction exists, and do not hide it by moving files unless the user asked for a restructure.
   - *one file does two jobs*: put it with the element that most of its importers belong to, and name the second job in that element's description.
   - *the model needs `specification` kinds*: declare the element kinds you use once, in a `specification` block (a separate `spec.c4` is fine).
6. **Show it** with `pathlight show`.
7. **Report plainly**, every time and without being asked, as this checklist (say "none" rather than leaving an item out):
   - what the scan covered: files, imports, and anything under `unscanned` or `unresolved` (languages or imports it could not read);
   - what the model contains: elements, and the views you made;
   - what was left out: the "N source files ignored on purpose" line and the kinds of file in `ignore` (tests, tooling, examples), so they can decide whether any belongs in the diagram;
   - what `check` could not verify: relationships marked "not checkable", and relationships you kept with no import behind them, each with the reason you kept it.

## Design the architecture before the code exists

When there is little or no code yet, the model is the plan, and writing it with the user is the work. Agree the components and relationships with them, write the model, and map each component to the files you expect to create. Then list the components that do not exist yet in `"planned": ["<element id>", ...]` in `pathlight.activity.json` (an element covers everything inside it). `pathlight check` then reports the plan and how much of it exists instead of calling those globs mistakes, and the viewer draws unbuilt ones dashed with a `[planned]` tag.

As files appear, `check` says "<id> now has files: remove it from planned"; do that. From then on its relationships are checked against the code, so a relationship the plan drew that the code does not have is reported as unsupported: that is the plan and the code disagreeing, and the user decides which to change. Never add an element to `planned` to hide a glob that is simply wrong.

On a large codebase do not stop at one flat diagram. Make an overview, then a view for each component that has several parts inside, and say which parts you did not open up.

When you create, move or delete files later in the session, add or fix their mapping in `pathlight.activity.json` in the same change, so the viewer lights the right component instead of listing the file as `no component`.

Run `pathlight check` again after any later change to the code or the model, and report what it says without softening it.

## Say where you are about to work

Before a change that spans several parts, run `pathlight plan <element id> [...]` with the ids from the model you expect to touch (ids only, no text), and `pathlight plan` with none when you finish. The viewer outlines those elements in purple and marks activity on any other element `off plan`, so the user sees at once when the work wandered. Unknown ids are refused. It is a statement of intent, not a record: if the plan turns out wrong, set a new one.

## What changed since the last commit

`pathlight diff --workspace .` lists the model's relationships that an import backs now and did not at `HEAD` (or `--base REV`), the ones that lost their imports, and new pairs of elements that import each other with no relationship. Use it before reporting a change that touched structure: an added import between two elements is either a missing relationship to declare or a dependency to question. It is static imports only; say so.

## Keep the model honest

When files are added, moved or removed, run `pathlight check --workspace .` and tell the user what changed: new unmapped files, globs that no longer match, new imports between components. Propose the edits to the model or mapping; do not change the model silently.

## Limits

- The scan reads TypeScript and JavaScript only. It does not follow `tsconfig` `extends`, `exports` patterns or bundler aliases; what it cannot resolve is listed, not guessed.
- The viewer is for Linux with tmux. Do not claim other terminals or platforms work.
- Activity journals hold metadata only (tool, operation, file paths, time). Do not add source, commands or results to them.
