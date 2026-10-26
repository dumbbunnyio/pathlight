---
name: pathlight
description: Use when the user wants to open, show or draw the architecture diagram of a codebase, see which components the agent is touching as it works, or have a LikeC4 architecture model and its .pathlight/pathlight.activity.json file mapping created, extended or checked. Invoke as /pathlight, optionally with a view id. Covers pathlight list, show, scan, check and init.
---

# pathlight

pathlight shows a LikeC4 architecture diagram in a tmux pane beside the conversation and lights up the components whose mapped files you read or edit. LikeC4 owns the model; `.pathlight/pathlight.activity.json` maps file globs to element ids.

## Truthfulness

- Say only what the tools reported. A scan or check is **static evidence** (imports in TypeScript and JavaScript). It does not show what runs, what is called over a network, or that a test passes.
- Never describe the diagram from memory. Open it, or run `pathlight list`, and report what happened.
- Do not invent elements or relationships to make a check pass. A relationship needs a reason you can state from the code you read.
- The viewer shows only observed tool calls. Never imply traffic between components.

## First run

When the user has just installed pathlight, asks you to set it up, `pathlight list` returns no views, or `pathlight open` says there is no model, run `pathlight setup --workspace .` first. It checks tmux, `pathlight` on the PATH, the model, the file mapping and the Claude plugin, prints what is wrong with the fix for each, and, if there is no model, says what it would write. Show the user that output, and only after they agree run `pathlight setup --workspace . --yes`: it draws a first picture from the code, checks it, and prints how to open the viewer. Then **name the boxes** (next section), so the first thing they see is explained, and open it. It never rewrites a model the user wrote, and it leaves hooks and recording to `pathlight init`, which you run only with their agreement. If a step it names needs something you cannot do (installing the binary or the plugin), say so and give them the command it printed.

No views means no model *now*. It is not a question about git: do not run `git status` or `git checkout` to look for an older model, and do not offer to restore deleted model files. If the user removed `pathlight.model.c4` or the other root files on purpose (older versions wrote them there; everything now lives in `.pathlight/`), that is the clean start. Go straight to `pathlight setup`, and mention a stale copy in git only if they ask.

## Commands

Run `pathlight --help` for every flag. If `pathlight` is not on the PATH, ask the user how it is installed (the repository's `bun link`, or `bun <repo>/src/cli.ts`).

- `pathlight list --workspace .` lists the views (id, title, project) as JSON.
- `pathlight show VIEW --workspace . --follow` opens the viewer in the user's tmux window and follows this session. Inside tmux it finds the pane itself; from a background service pass the user's actual pane with `--pane %ID` (and `--socket PATH` for a non-default tmux server). Never guess a pane.
- `pathlight scan --workspace . --out scan.json` writes the static facts: files, imports (with lines), external packages, what could not be resolved, and `coverage`.
- `pathlight check --workspace .` compares the model and mapping with a fresh scan. `--json` gives data; `--strict` exits 1 when anything is found.
- `pathlight draft --workspace .` writes a first picture made from the code alone (packages, folders, the imports between them, several views); see the next section. `--out DIR` writes it elsewhere.
- `pathlight setup --workspace .` is the first run (see above); add `--yes` to let it draw a first model.
- `pathlight brief [KEY ...] --workspace .` lists what an agent needs to name boxes: the files each box owns, what it imports from and what imports it, what is inside it, any name it has. `pathlight name KEY --title TEXT --note TEXT --workspace .` (or `--from FILE|-` with a JSON array of `{"key","title","note"}`) saves names as the agent's reading and redraws once; it never replaces a name the user wrote.
- `pathlight doctor --workspace .` checks tmux, the model, the file mapping and the plugin and prints the fix for each failure. Run it first when the viewer does not open or nothing is recorded.
- `pathlight init --workspace .` wires Claude Code hooks (`.claude/settings.local.json`, per user), the OpenCode plugin, this skill, and proposes a mapping by matching element names to files on disk. It turns on recording, so tell the user what it will write and get their agreement first. `--no-claude-hooks` skips the project-local hooks when the Claude plugin is installed.

## Show the architecture

1. `pathlight list --workspace .` and pick the overview view.
2. `pathlight show VIEW --workspace . --follow`. If the user named a view (for example `/pathlight services`), show that one.
3. Report only whether it opened.

If `list` returns no views the workspace has no model yet: follow **First run** above. Write a model by hand (below) only when the user asks for one instead of the draft; then name the files you would write, in `.pathlight/` (everything pathlight writes goes there, so nothing lands loose in the root), and write nothing until they agree.

## After the draft: name the boxes

A fresh draft shows what the code does, not what it is for: every box is a folder name with a line count. The first run is not finished until the boxes say what they are for, so after `setup --yes` do this (the user has already agreed to the draft; naming only writes `.pathlight/pathlight.overlay.json`, as your reading, and never replaces a name they wrote):

- If you have a `pathlight-namer` agent, hand the whole job to it: "Name every box of the pathlight map in this workspace." It runs on a mid-size model, so the reading stays out of this conversation and off a larger model. Otherwise do it yourself as below.
- Run `pathlight brief --workspace .`. When the map was named before and the user asks to refresh it, run `pathlight brief --changed --workspace .` instead: it lists only boxes that are new or whose files changed since they were named, so only those need reading. Boxes come children first. The files listed are the box: a folder plus a loose file beside it is one box, so describe all of it. Open the files that decide what a box is for (the entry point, the biggest file, a README) and name it for what it does in this app, not what it holds. Say when a note is inferred from file names; never describe behaviour you did not see.
- Save a level at a time: `pathlight name --workspace . --from -` with a JSON array of `{"key","title","note"}` (title up to 60 characters, note up to 300, one line). The key is exactly the one `brief` printed.
- The box that holds the whole app gets a note on what the app is for: `brief` opens with the project's own description and README for it. Name it last.
- Tell the user how many boxes were named and which you could only infer, say in a sentence what the app does, then record the up to three journeys the namer suggested so the map opens with something to follow: hand each to the `pathlight-tracer` agent (several can run at once; without one, follow the `pathlight-behavior` skill yourself), naming the file it starts at. They are your reading of the code and the viewer labels them so. Say which were recorded and which the tracer could not confirm (it drops a hop it cannot point to), then open the viewer. The user presses `F` to step through one. They correct any box with `m` (ask the agent again) or `n` (write it themselves, which becomes a pin).

## A quick draft from the code

When the code already exists and the user wants something to look at straight away, `pathlight draft --workspace .` writes `pathlight.model.c4`, `pathlight.activity.json` and `likec4.config.json` into `.pathlight/` with no judgement involved: each package is a box, top-level folders are components (small folders and loose files share a collection each), and a relationship exists wherever files in one component import files in another, labelled with the import count. It also writes views for the landscape, the inside of each package, each component's neighbourhood, and import cycles. Every name is a folder or file name and every description is a count. Say that plainly: it shows what the code does, not what it is for.

It never rewrites a model the user wrote (use `--out DIR`), and what it writes is generated: rerun it instead of editing those files by hand. To give a draft better names or a note on what a part is for, write `.pathlight/pathlight.overlay.json` next to it and rerun `pathlight draft`: `{"version":1,"elements":{"packages/core/src/session":{"title":"Sessions","note":"Runs one conversation turn"}}}`. Keys are what the code is (a package directory, a folder path, a file path, or `<directory>#small` / `<directory>#loose` for a collection), not the generated ids, so a name survives when an id moves. A title is at most 60 characters and a note 300; only read the code you are naming. Keys that match nothing are listed after the run: fix or remove them. The overlay can also correct structure: `"merges":[{"title":"Data store","keys":["<folder path>","<folder path>"],"by":"agent"}]` (several folders are one component), `"splits":[{"key":"<folder path>","by":"agent"}]` (a folder becomes one component per subfolder) and `"relationships":[{"from":"<key>","to":"<key>","title":"reads and writes rows","by":"agent"}]` (a label for an arrow imports already support). Mark what you add `"by":"agent"`. Never change or remove an entry marked `"by":"human"`: those are the user's decisions, and `draft` reports one that differs from the last commit. Propose a merge, split or title only for something you checked in the code. An entry that contradicts the code is skipped and listed after the run, so read that list and fix or drop those entries. The overlay never adds files or invents an arrow. If the user wants different groupings, write a model yourself as below.

## Draft a model for a codebase that has none

Aim for a diagram a person can read in one glance. Build it in levels: a few groups (3 to 7) that say what the code is for, and inside each group its parts. A flat row of 14 boxes is not a readable diagram. A small codebase gives a small diagram; do not pad it. Give every group its own view that opens it up, and link the overview to each: in the overview write `include camenae.web with { navigateTo web }` so the group opens its view (press `o` in the viewer).

1. **Scan.** `pathlight scan --workspace . --out scan.json`. Read `coverage` first: `unscanned` lists languages the scan does not read (their dependencies are missing, so read those parts of the code yourself), and `unresolved` lists imports it could not follow.
2. **Find the boundaries.** Use the import edges to see which files belong together and which depend on which. Read a few entry points and the files at the centre of the graph; do not read everything. Filename families (`chat-*`, `auth-*`), package directories and `external` packages are all hints, not answers.
3. **Write the model.** Use `.c4` files with a `likec4.config.json`, in `.pathlight/`. The syntax you need is under "LikeC4 in brief" below. Give each element a title, technology and a one-sentence description taken from code you read. Name each relationship for what the dependency is ("Reads the model"), not for something you did not see. A relationship on a group is supported by imports between its children. Do not install or run `likec4`: `pathlight check` loads the model itself and fails with "Invalid LikeC4 model" and the parser errors if it is wrong, so a clean check also means the model is valid.
4. **Write `.pathlight/pathlight.activity.json`.** `{ "version": 1, "project": "<likec4 project name>", "mappings": [{ "glob": "src/auth/**", "element": "<exact element id>" }], "ignore": ["tests/**"] }`. Globs are workspace-relative. Element ids are the full dotted ids (`backend.auth`). Use `ignore` for tests, vendored or generated code that is deliberately outside the model.
5. **Check, then adjust.** `pathlight check --workspace .` and work through it:
   - *glob matches no files*: fix the glob.
   - *source files map to no element*: map them, or add them to `ignore` if they are deliberately outside the model.
   - *no import between the mapped files*: the relationship may really run through a network call, an event or a file. Keep it if you can say how; otherwise remove it. Either import direction counts as evidence.
   - *imports with no relationship*: add a relationship when the dependency matters at this level; leave small shared helpers alone.
   - *not checkable*: an end has no mapped files; map it or accept that nothing can be checked.
   - *views with no navigateTo pointing to them*: a diagram has one entry, the overview. Link the others from it, as above.
   - *an element has many elements side by side*: group related ones under a parent and give each group its own view (see below). Do not leave more than about 7 elements at one level.
   - *an element holds many of the mapped files*: the report lists the folders inside it. Split it along them if they are different parts of the system; otherwise leave it and say so.
   - *shared types and utilities that everything imports*: list the element in `"shared": ["<element id>"]` in `.pathlight/pathlight.activity.json`, so `check` stops asking for a relationship to it. Only do this for code that is genuinely used everywhere.
   - *two elements import each other* (`check` says "both ways"): draw one relationship in the direction the stronger dependency runs, say in its description that the other direction exists, and do not hide it by moving files unless the user asked for a restructure.
   - *one file does two jobs*: put it with the element that most of its importers belong to, and name the second job in that element's description.
   - *the model needs `specification` kinds*: declare the element kinds you use once, in a `specification` block (a separate `spec.c4` is fine).
6. **Show it** with `pathlight show`.
7. **Report plainly**, every time and without being asked, as this checklist (say "none" rather than leaving an item out):
   - what the scan covered: files, imports, and anything under `unscanned` or `unresolved` (languages or imports it could not read);
   - what the model contains: elements, and the views you made;
   - what was left out: the "N source files ignored on purpose" line and the kinds of file in `ignore` (tests, tooling, examples), so they can decide whether any belongs in the diagram;
   - what `check` could not verify: relationships marked "not checkable", and relationships you kept with no import behind them, each with the reason you kept it.

## LikeC4 in brief

This is the whole of the syntax a pathlight model needs; the example is compiled by a test, so copy its shape. Anything beyond it is on https://likec4.dev/dsl/, and `pathlight check` reports a mistake with the parser's message.

```likec4
specification {
  element system
  element component
  tag planned
}
model {
  app = system 'Orders' {
    description 'Takes and fulfils orders.'
    api = component 'Order API' {
      technology 'Express'
      description 'Validates an order and stores it.'
    }
    store = component 'Order store' {
      #planned
      technology 'Postgres'
    }
    api -> store 'Writes orders'
  }
  billing = system 'Billing'
  app.api -> billing 'Asks it to charge the customer'
}
views {
  view index {
    title 'Overview'
    include app with { navigateTo app }
    include billing
  }
  view app of app {
    title 'Inside Orders'
    include *
    autoLayout LeftRight
  }
}
```

- **Kinds** (`system`, `component`) are declared once in `specification`; a tag is declared there as `tag name` and used as `#name`.
- **An element** is `id = kind 'Title' { ... }` with optional `technology`, `description` and nested elements. Its relationships go inside the parent (`api -> store 'label'`) or anywhere with full dotted ids (`app.api -> billing`).
- **Ids** are letters, digits, `_` and `-`, not starting with a digit. A dot is the path separator (`app.api`), never part of an id. Avoid reserved words as ids (`storage`, `notation`, `model`, `view`, `style`, `group`).
- **A view** is `view name { ... }`, or `view name of element { ... }` to open one element up. `include *` is the element's children (or the top level in a view with no `of`); `include a.*` is the children of `a`; `include a, b` lists elements; `exclude` removes. `*` only works alone or after a dot: there is no pattern such as `signup_*`.
- **Linking views:** `include app with { navigateTo app }` makes the box open view `app` (`o` in the viewer). Every view except the overview should be linked from it.
- **Quotes:** single or double; put a long text on its own lines inside `'''` triple quotes only if you need line breaks.
- **Several files** in one folder with one `likec4.config.json` (`{"name": "demo"}`) form one model; across files an element is referenced by its full dotted id.

## Design the architecture before the code exists

When there is little or no code yet, the model is the plan, and writing it with the user is the work. Agree the components and relationships with them, write the model, and map each component to the files you expect to create. Then list the components that do not exist yet in `"planned": ["<element id>", ...]` in `.pathlight/pathlight.activity.json` (an element covers everything inside it). `pathlight check` then reports the plan and how much of it exists instead of calling those globs mistakes, and the viewer draws unbuilt ones dashed with a `[planned]` tag.

As files appear, `check` says "<id> now has files: remove it from planned"; do that. From then on its relationships are checked against the code, so a relationship the plan drew that the code does not have is reported as unsupported: that is the plan and the code disagreeing, and the user decides which to change. Never add an element to `planned` to hide a glob that is simply wrong.

On a large codebase do not stop at one flat diagram. Make an overview, then a view for each component that has several parts inside, and say which parts you did not open up.

When you create, move or delete files later in the session, add or fix their mapping in `.pathlight/pathlight.activity.json` in the same change, so the viewer lights the right component instead of listing the file as `no component`.

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
