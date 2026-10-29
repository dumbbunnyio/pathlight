# Measuring map quality

Pathlight is only as useful as its map is true, so the map is measured, not judged. Nothing here asks a model for an opinion: each number is counted from the scan, from `pathlight check`, from the computed LikeC4 views, or from rules a repository's own authors wrote down. The tools live in `tests/eval/` (development tools, not shipped).

## A pinned repository

```sh
git clone --local --no-hardlinks <path-to-opencode> .cache/eval/opencode-installed   # .cache is git-ignored
git -C .cache/eval/opencode-installed checkout 5fa426f68d                            # always the same commit
(cd .cache/eval/opencode-installed && bun install --ignore-scripts --frozen-lockfile)   # lets the reference resolver follow workspace packages
```

## Do the facts match an independent answer?

```sh
bun tests/eval/facts.ts --workspace .cache/eval/opencode-installed --out /tmp/facts-diff.json
```

Compares `pathlight scan` with a reference made another way: every import found by a pattern match and resolved by `oxc-resolver` (a different resolver, with each package's own tsconfig). Both disagreement lists are printed for reading in the source; neither side is assumed right. On the pinned `opencode` (5,127 files, about 19,400 connections) every disagreement was explained: the reference counts import statements that sit inside string literals (test fixtures, code generators) and cannot follow `?raw` or runtime-conditional `exports`; the scan had one real bug (an import with more than 400 tokens of names was dropped), now fixed and tested.

## Does a model agree with the code and with what the authors say?

```sh
bun src/cli.ts draft --workspace .cache/eval/opencode-installed
bun tests/eval/run.ts --workspace .cache/eval/opencode-installed --reference tests/eval/references/opencode.json
```

Reports, for any workspace's model and mapping: files claimed, relationships an import supports, element pairs the imports connect that no relationship declares, how many dependency rules the authors state still hold (`tests/eval/references/opencode.json`: each rule quotes the document line it comes from), and how many boxes the busiest views hold. For a draft made from imports the first three are true by construction; they matter for agent-written and hand-written models. The rules and the view sizes are the informative numbers for a draft.

**Re-exports followed (2026-10-26).** The scan now follows each imported name through a package's barrel files to the file that declares it (see [scan format](scan.md#what-it-follows)), found when a live first run on opentui drew every binding pointing only at `core`'s `index.ts`. On the pinned `opencode` a fresh draft scores 4,168 of 4,168 files claimed, 2,826 of 2,826 edges supported, 0 pairs undeclared, and 16 of 16 of the authors' rules holding. The facts reference has followed re-exports too since 2026-10-28 (see "Instruments corrected" below).

`tests/eval.test.ts` plants one defect at a time (a missing relationship, an invented one, a dropped mapping, a crowded view) and requires the scorer to notice each, so a scorer that stops noticing fails the suite.

## Baseline: what an agent following the skill produces (2026-10-21)

Fresh agents (no draft, no overlay) followed the skill's hand-written workflow on scratch copies of `camenae` and `camenae-sdk`, and the scorer was run on what they wrote, not on their own reports.

| | files claimed | edges supported | pairs undeclared | readable view max boxes | elements / relationships |
| --- | --- | --- | --- | --- | --- |
| camenae, agent | 55 of 55 (71 ignored by the agent: tests, scripts, tools, docs) | 41 of 41 | 0 | 6 | 31 / 41 |
| camenae, draft | 97 of 97 (tests only ignored) | 73 of 73 | 0 | 20 | 34 / 73 |
| camenae-sdk, agent | 23 of 23 (81 ignored: tests, scripts, tools, examples, config) | 12 of 12 | 0 | 7 | 11 / 12 |
| camenae-sdk, draft | 70 of 70 | 3 of 3 | 0 | 7 | 8 / 3 |

**Pass marks, from this baseline:** every eligible file claimed, every relationship backed by an import, no connected pair undeclared, no readable view over 20 boxes, no group with more than about 7 children. Both agent models and both drafts meet all of them, so these are a floor, not a ranking. Since 2026-10-28 (Phase 4a, when the draft began opening a folder that is most of its package) the last two read: no view draws more than nine children of one group as cards (the rest are in its everything view), and no readable view holds more than 20 boxes in all. The scorer prints both (`most boxes in a readable one`, `most cards inside one box`).

**What this cannot tell you.** The scorer checks that a model agrees with the imports; it cannot tell whether the grouping is the one a maintainer would draw, or whether a description is right. Neither repo has authors' rules to score against, and the agents read only file headers, so their descriptions are inferred from names and imports (they said so). The agent's coarser model leaves out 71 and 81 files by choice; `check` reports the count so the reader can disagree. One agent also removed a relationship (web to server over HTTP) because no import backs it: honest, but the overview then shows the web group unconnected.

## Flows: does an agent's journey match the code?

A journey (`pathlight flow add`) is an agent's reading of the code, so it is scored the same way as the map: counted, not judged. `pathlight flows` already finds what can be shown wrong or old (a file that is gone or changed since the sync commit, a hop with no model relationship). It cannot tell that a well-formed journey is wrong, so the eval adds the questions it cannot answer.

```sh
bun tests/eval/flows.ts --workspace DIR --reference tests/eval/references/flows.json
```

`tests/eval/references/flows.json` holds a few questions about this repository ("what happens when someone runs `pathlight check`?"), each with the hops of a correct trace and the files a trace has to read. The answer is the scorer's own hand reading of the code, not an agent's. For each journey the scorer reports:

- **Hops matched, missed, and in order** against the answer.
- **Invented**: a hop outside the answer *and* with nothing behind it (no model relationship, or no import joining the two components through a file the agent says it read). The pass mark is zero.
- **Additional**: a hop outside the answer that the model and an import both back. It is a different reading to look at, and does not count against the run.
- **Unbacked / unsupported**: hops without a model relationship; hops without an import in either direction (data can flow against the import, as in the viewer reading the journal).
- **Files**: cited files that do not exist, and whether the key files were read.

A run passes when every hop of the answer is present and in order, nothing is invented, every hop is backed and supported, no cited file is missing and every key file was read. A hop the answer marks `over` (http, websocket, process) is exempt from backed and supported, because the import-drawn map cannot hold it. It is still required and reported on its own line (since 2026-10-28). `tests/eval-flows.test.ts` plants one defect at a time (no journey, a missing hop, hops in the wrong order, an invented hop, a hop with a relationship but no import, a missing file, an unread key file) and requires the scorer to notice each.

What each check can and cannot see:

| Defect | `pathlight flows` | this score |
| --- | --- | --- |
| A cited file is gone or changed since the sync commit | yes | yes (gone) |
| A hop with no model relationship | yes (`≠`) | yes |
| No sync note | yes | no |
| A hop between related components that the code does not make | no | yes, if no import joins them through a cited file |
| Hops in the wrong order | no | yes |
| A real hop left out | no | yes |

Neither can tell that an event title is right, or that a hop is the *only* way the code gets from A to B.

### Baseline: fresh agents following the skill (2026-10-24)

One agent per question and model (Claude Sonnet and Claude Haiku, each working alone: it scouts and decides itself, the case for a host with no subagents). Each got the exact request the `d` key types into the agent's pane, a clean checkout of the repository with `tests/eval/` and this document removed, and the name of the journey; it was told nothing else. The scorer was run on the files they wrote, not on their own reports. A run **passes** when every required hop of the answer is present and in order, nothing is invented, every hop has a model relationship and an import behind it, every cited file exists, and every key file was read.

| question (hops in the answer) | Sonnet | Haiku |
| --- | --- | --- |
| `check-run` (3) | ✓ | ✗ one model gap: `scanner → launcher` |
| `record-call` (3) | ✓ | ✓ |
| `ask-agent` (2) | ✓, 2 additional hops | no journey (see below) |
| `open-viewer` (3 required, 3 optional) | ✗ stopped at `launcher → viewer`: 2 required hops missed, key file `native-viewer.ts` unread | ✗ one model gap: `launcher → catalog`; missed `activity → viewer` |
| `stale-badge` (3 required, 2 optional) | ✓ | ✗ `plugin → scanner` invented; missed `plugin → launcher` and `launcher → scanner` |
| passes | 4 of 5 | 1 of 5 |

What the failures were:

- **A model gap is not an invention.** Haiku's `check-run` and `open-viewer` each added a hop the code makes (`src/scan.ts` runs git through `src/process.ts`; `src/cli.ts` calls `src/catalog.ts`) and the model has no relationship for. `pathlight flow add` wrote it and reported it (`≠`), and both agents said so. The pass mark still fails them, because the journey and the model disagree; which one is wrong is for a person to decide. The scorer reports these as *model gaps*, separately from *invented* hops (no import joins the two components through a file the agent read).
- **Shortcuts.** Haiku's `stale-badge` drew `plugin → scanner` straight from the Stop hook to the check, skipping the launcher where `pathlight check` runs. The command flagged it as `≠`; the agent said so; the scorer calls it invented.
- **Stopping early.** Sonnet's `open-viewer` stopped once the viewer's pane was started and did not trace into the viewer. It said it had not. The answer's last hops (`viewer → catalog`, `activity → viewer`) are arguable for "up to the diagram being on screen"; both models left out `activity → viewer`, so that hop may be too strict, but it was not loosened after seeing the result.
- **Caution.** Haiku's `ask-agent` wrote nothing: it judged `ask → launcher` unconfirmed because `src/ask.ts` calls `process.ts` and not `tmux.ts`. It first wrote and then removed a two-step journey, which is the one thing the command could not stop.

Every wrong or missing hop in these runs was either flagged by `pathlight flows`, said by the agent in its report, or both. No run produced a wrong hop that nothing pointed out. What the cheaper model did less well was completeness and tracing the whole path, not honesty.

**What this cannot tell you.** Five questions, one run per model each, and both models read this repository, so the result says little about a codebase they have not seen. The answers are the scorer's reading (the `check-run` answer is the one written by hand earlier, so it is not independent), and "supported by an import" does not show that a hop is on the path being traced. It cannot judge event titles. The scout-then-decide split in the skill has not been measured: these runs had one agent do both. Re-run after any change to the skill, `flow add` or the `d` request.

### Scout, then decide (2026-10-24)

The skill proposes a split: a cheap model traces the path and lists facts, a stronger model opens the files, decides the hops and writes the journey. It was run on the same five questions: five Haiku scouts (read-only, told to report files, components and calls and nothing else), then five Sonnet agents, each given the request, the scout's notes marked as unverified leads, and the instruction to confirm each hop in the files itself.

| question | Sonnet alone | Haiku alone | Haiku scout, then Sonnet |
| --- | --- | --- | --- |
| `check-run` | ✓ | ✗ model gap | ✗ model gap (`scanner → launcher`, drawn twice: git through `process.ts`, and the result returned) |
| `record-call` | ✓ | ✓ | ✗ model gap (`launcher → plugin`); one additional hop (`plugin → activity`) |
| `ask-agent` | ✓ | no journey | ✓ |
| `open-viewer` | ✗ stopped at `launcher → viewer` | ✗ | ✗ same two required hops missed (`viewer → catalog`, `activity → viewer`) |
| `stale-badge` | ✓ | ✗ | ✓ (all five hops) |
| passes | 4 of 5 | 1 of 5 | 2 of 5 |

- **No gain was shown.** The split did not pass more questions than Sonnet alone, and it did not cost less: each decider spent about as many tokens (51 to 57 thousand) as a Sonnet agent working alone (50 to 53 thousand), because it opened the files anyway, and the scouts' tokens (50 to 66 thousand each, Haiku) came on top. The skill now says to trace the path yourself unless the path is long and the host offers a subagent.
- **The two split failures are the same kind.** Neither invented anything. Both added hops the code makes and the model does not draw (`src/scan.ts` imports `src/process.ts`; `src/cli.ts` calls `src/claude.ts`), and `pathlight flow add` reported each as `≠`. Sonnet alone left those hops out. On a count that does not fail a run for a model gap the split and Sonnet alone are level, 4 of 5 each; neither count is a reason to prefer one. What it does show: a fuller trace finds places where the model is incomplete, and the strict pass mark treats that as a failure.
- **`open-viewer` failed every way it was tried.** Every run stopped once the viewer was started, or left out `activity → viewer`. The question says "up to the diagram being on screen", and the answer's last hops are arguable; the reference was not changed.
- **Journeys are stricter than `pathlight check`.** `check` counts an import in either direction as covering a relationship; a journey hop has a direction, so `scanner → launcher` is a gap even though `launcher → scanner` exists and the files import each other. This is why `examples/viewer` shows `≠` for hops the code does make. Since 2026-10-26 a hop back over a pair an earlier step of the same journey opened counts as that step's answer (`↩`), not a gap, and several hops over one unrelated pair are one finding; the scores above were taken before that and have not been re-run.

Five questions and one run each: not enough to rank the two ways of working, only to say the split did not help here.

## Names: does an agent's first pass describe the boxes? (2026-10-25)

`bun tests/eval/names.ts --workspace DIR --reference tests/eval/references/names-NAME.json` scores the names and notes in `.pathlight/pathlight.overlay.json` against a hand-written reading of the repository (`name-score.ts`). Two things are measured: **coverage** (how many of the draft's boxes got a note) and, for the boxes the reference describes, **concepts** (groups of words, any one of which in the title or note says that thing) and **forbidden** phrases (a claim the code contradicts). It asks no model for an opinion, so a true note in other words can miss a concept; a box passes with two thirds of its concepts, a note, and no forbidden phrase. References: `names-dialupworld.json` (8 boxes) and `names-models-dev.json` (6 boxes, from a Bun monorepo of about 10,800 tracked files).

### Baseline: today's method (2026-10-25)

One Sonnet-class agent per repository, given the workspace, the overlay keys and the rules of the `m` request (read the code, write `by: "agent"` names, rerun `draft`), and no symbol data. Both ran on a scratch copy.

| | boxes | noted | described boxes passing | files read (agent's count) | tokens | time |
| --- | --- | --- | --- | --- | --- | --- |
| dialupworld | 15 | 15 | 8 of 8 | about 25 | about 52,000 | 43 s |
| models.dev | 41 | 41 | 6 of 6 | about 35 | about 52,000 | 39 s |
| hono (583 tracked files) | 94 | 94 | 17 of 18 | about 30 | about 50,000 | 55 s |

What this does and does not show:
- Naming every box once is cheap on a Sonnet-sized model, and both agents marked what they had only inferred ("inferred from file names", "only saw the folder layout") instead of claiming it. Spot checks of leaf boxes in models.dev (`hit.ts`, `describe.ts`, `model-file-v2.ts`) found the notes right.
- **The score does not discriminate yet.** Both repos have READMEs that say what the major boxes are, and the reference lists only those boxes with loose concepts, so everything passes. It cannot show that symbol slices or any other input would do better. Before one is built, the reference needs the hard boxes (leaf folders and single files whose purpose the README does not state), and the forbidden lists need real mistakes to look for.
- Only two repositories, one agent run each.

### With `pathlight brief` and `pathlight name` (2026-10-25)

The same three repositories, a fresh Sonnet-class agent each, this time given `pathlight brief` (every box's files with sizes, imports in and out, and what is inside it) and `pathlight name` to save the result, following `plugins/claude/agents/pathlight-namer.md`.

| | boxes | noted | described boxes passing | files opened (agent's count) | tokens | time |
| --- | --- | --- | --- | --- | --- | --- |
| dialupworld | 15 | 15 | 8 of 8 | about 16 | about 54,500 | 26 s |
| models.dev | 41 | 41 | 6 of 6 | about 45 | about 59,000 | 52 s |
| hono | 94 | 94 | 18 of 18 | about 20 | about 67,000 | 59 s |

- The `src/request` mistake is gone: the note now reads "HonoRequest: the request object handlers use", because the brief listed `src/request.ts` as part of the box. The top-level `jsx` box in hono, which is a benchmark package, is now "JSX benchmark package".
- One box (`src/compose.ts`) missed a concept on a true note ("composes middleware and handlers into one function"); the reference's synonyms were widened, which is the scorer's limit, not the agent's.
- The agents opened fewer files than in the baseline for hono (about 20 against about 30) and marked most notes "inferred from file names" or similar; they flagged `src/context.ts`, `src/types.ts`, `src/validator` and `src/utils` as guesses. That is the honest outcome, and a weakness: a box the agent could not read still gets a plausible note. The notes carry the doubt in their text; the viewer does not yet show it.
- Still only three repositories, one run each, and a reference that lists the boxes whose purpose is clearest. It shows the brief removes one class of mistake; it does not show these names are right everywhere.

### A real mistake, found on hono

The `src/request` box is `src/request/**` plus `src/request.ts` (the request wrapper class), but the agent was given only the overlay key, saw a folder holding `constants.ts`, and wrote "Request constants: small constants for the request wrapper". Every concept in the reference matched, so the reference now carries `"forbidden": ["constants"]` for that box and it fails. The cause is the input, not the model: the request never listed the files each box owns, so the agent could only describe the folder it opened. The `m` request already sends a box's files (up to eight), but nothing sends them when many boxes are named at once, and a box made of a folder and a loose file reads as the folder.

Also found while drafting hono: a folder beside `src/` (`benchmarks/`, `build/`) was keyed as `src/benchmarks`, a path that does not exist; fixed in `draft.ts` with a test.

## Our scanner against CodeGraph (2026-10-25)

`bun tests/eval/codegraph-compare.ts WORKSPACE OUTDIR` compares file-to-file import pairs from `pathlight scan`, from the independent resolver of `facts.ts`, and from [CodeGraph](https://github.com/colbymchenry/codegraph) 1.6.2 (tree-sitter, SQLite, `codegraph init`; telemetry off), by edge kind. The oracle is not ground truth, so each disagreement on hono was read in the source.

| repository | | pairs | found of the oracle | confirmed by the oracle |
| --- | --- | --- | --- | --- |
| hono (non-test files, after the scan fix below) | pathlight scan | 651 | 99.8% | 94.0% |
| | CodeGraph `imports` | 684 | 96.7% | 86.7% |
| dialupworld (non-test) | pathlight scan | 316 | 100% | 100% |
| | CodeGraph `imports` | 311 | 97.5% | 99.0% |
| models.dev | both tools agree on 343 and 355 pairs; the oracle resolves only 5 because the workspace packages are not installed, so it cannot judge them | | | |

What reading the disagreements on hono showed:
- **The scan's 47 pairs the oracle lacked** are all `from 'hono'` self-imports (adapters importing the root package); each statement was found at the line the scan recorded. The oracle misses them because nothing is installed, so they are the scan being right. The one pair the scan still lacks (`generate-app.ts → src/index.ts`) is import text inside a template string; the oracle is wrong there, and CodeGraph also leaves it out.
- **A real scanner bug**, found by this: a specifier ending in a slash (`from './'`, `from '../'`) did not resolve, so eight edges on hono (the JSX and streaming folders importing their own index) were missing and reported as unresolved. Fixed in `src/scan.ts`, with a test; `scanRevision` is 2.
- **CodeGraph leaves out file-level re-exports** (`export * from './mod'`, `export type {…} from './client'`): ten pairs on hono. It also skips folders its defaults exclude (`build/`).
- **CodeGraph resolves a name through a barrel to the file that defines it.** That is why 74 of its 82 extra pairs are real dependencies the scan draws to the barrel (`src/index.ts`) instead: `handler.ts → src/hono.ts` where the scan has `handler.ts → src/index.ts`. It is more informative about who depends on what, and a different relation from an import.
- **CodeGraph also draws wrong edges when two files define the same name:** `export type { Handler } from './types'` in `src/index.ts` became an edge to `adapters/aws-lambda/src/types.ts`; `ErrorHandler` to `src/jsx/components.ts`; a `ServeStaticOptions` imported from `hono/serve-static` to the Cloudflare adapter's type; `jsxDEV` to the wrong `jsx-dev-runtime.ts`. At least five on hono, none the scan has.
- At box level on hono: the scan draws 168 arrows and CodeGraph's imports give 153; 137 agree. Of the 16 only CodeGraph has, most are the barrel-to-definer relation above and three are the name-collision mistakes.

Conclusion for the arrows: for the question the diagram answers ("which box imports which"), the scan is at least as complete and has no known false edges on the repositories tried; CodeGraph adds a different, symbol-level view and some errors of its own. It has what the scan lacks (what each file defines, which names cross a boundary), which is context for a note, not arrows.

### Naming with CodeGraph's symbols as extra context (hono, 2026-10-25)

Same agent and instructions as the brief-only run, plus a sheet per box of the symbols it exports and which boxes use which names (generated from `codegraph.db`, `tests`-free, read-only):

| | notes saying "inferred" or "guess" | described boxes passing | tokens | time |
| --- | --- | --- | --- | --- |
| brief only | 75 of 94 | 18 of 18 | about 67,000 | 59 s |
| brief and symbol sheet | 30 of 94 | 17 of 18 | about 66,500 | 70 s |

The agent reported that the sheet changed what it wrote for `adapters/bun/src/server.ts`, `service-worker/src/types.ts`, `src/hono-base.ts`, `src/request` and `src/preset`, and was least useful for the adapters, where `getConnInfo`, `handle` and `serveStatic` are defined once per adapter and a few "used by" entries were wrong. The one miss (`src/router`) is a true note ("the routing implementations: RegExp, Trie, Linear, Pattern and Smart") that uses none of the reference's synonyms for matching; it is the scorer, not the note. The count of "inferred" notes is a keyword count, not a measure of accuracy: fewer guesses were declared, and nothing here shows the notes became more correct. That needs a reference with the hard boxes (see above).

### Our own exports list instead of CodeGraph (hono, 2026-10-25)

`pathlight scan` now reads each file's `export` statements (`exportsOf` in `scan-imports.ts`: declarations, defaults, named and re-exported names; names only, TypeScript and JavaScript) and `pathlight brief` prints them per box as `defines:`. A fresh agent, same instructions as the brief-only run, no CodeGraph:

| | notes saying "inferred" or "guess" | described boxes passing | tokens | time |
| --- | --- | --- | --- | --- |
| A: brief only | 75 of 94 | 18 of 18 | about 67,000 | 59 s |
| B: brief and CodeGraph's symbol sheet | 30 of 94 | 17 of 18 | about 66,500 | 70 s |
| C: brief with our exports | 55 of 94 | 18 of 18 | about 71,000 | 76 s |

The two notes I checked against the code, which A got wrong or vague, are right in C: `adapters/bun/src/server.ts` ("Provides getBunServer, which fetches the running Bun server from the request context") and `src/validator` ("checks request parts (json, form, query...) with a user function and types the result"). `src/context.ts`, `src/types.ts`, `src/hono-base.ts` are specific in C where A hedged. CodeGraph's sheet still led to fewer declared guesses (30 against 55); the "used by" half of it is what C lacks, and it was also the half that was ambiguous for same-named functions. Same limits as before: one repository, one run each, a count of declared doubt and two notes verified, not a measure of correctness.

## Baseline: reference repositories (2026-10-27)

Three open-source repositories, mapped as a first-time user would map them, to measure every later change against. Clones at `pathlight-oss-test-repos/` beside this checkout, not updated: **Outline** `d3b094352` (TypeScript: React client, Koa server, plugins), **Mealie** `2e7358d10` (Python FastAPI backend, Nuxt/Vue frontend), **Miniflux** (`v2`) `d5c529b9` (Go). For each: `pathlight setup --yes`, then the `pathlight-namer` subagent ("Name every box of the pathlight map in …"), then the `pathlight-tracer` subagent on the three journeys the namer suggested, each given the exact text the `d` key types (`flowMessage` in `src/ask.ts`, built from the box's mapped files and connections) plus one line naming the workspace. All in Claude Code, Sonnet-class subagents, one run each. No dependencies were installed; the scan did not need them (Outline has no workspace packages). The captures, logs and replies are in `docs/internal/baseline/` (not in git).

### What the scan and the draft see

| | files the scan reads | not read | boxes drawn | relationships | `setup --yes` | `check` |
| --- | --- | --- | --- | --- | --- | --- |
| Outline | 2,417 TS/JS | none reported | 15 (7 folders, 7 loose files, 1 collection) | 9 | 2.0 s | 0.7 s |
| Mealie | 309 TS/JS | 492 Python, 238 Vue | 13 | 1 | 1.1 s | 0.3 s |
| Miniflux | 5 TS/JS | 339 Go, 1 Python | 4 | 0 | 0.9 s | 0.3 s |

`check` reports every map as agreeing with the code, and the model scorer (`tests/eval/run.ts`, no authors' rules) gives all three 100% files claimed, 100% edges supported and 0 undeclared pairs; views: Outline 13 (largest readable 8 boxes, median 4), Mealie 9 (6, median 3), Miniflux 1 (4). **These pass because they count only what the scan reads**: on Miniflux "100% of files claimed" is 5 of 5, with 339 Go files outside the count. On these repos neither `check` nor the model scorer can fail; Phase 4 is what gives them something to count.

### Facts: Outline against an independent resolver

`bun tests/eval/facts.ts --workspace outline`: 2,417 files; the scan finds 13,154 file pairs, the reference 12,246, both 11,123. The scan finds 90.8% of the reference; the reference confirms 84.6% of the scan.

Every disagreement read is one cause: **re-exports**. The scan follows a named import through a file that re-exports it to the file that defines it; the reference stops at the re-exporting file. Of the 1,123 pairs only the reference has, 1,117 end at an `index.ts` barrel (`shared/types/index.ts` 569, `server/models/index.ts` 444, `server/policies/index.ts` 44, …) and the other 6 at `server/types.ts` and `server/validation.ts`, which re-export from `@shared` (`export { AuthenticationType } from "@shared/types"`). The 2,031 pairs only the scan has are the other side of the same imports (`app/actions/definitions/documents.tsx → shared/types/navigation.ts` where the source imports `@shared/types`); 1,968 have a reference-only barrel above the target in the same folder, and the remaining 63 go through barrels that also define things of their own (`@shared/styles` re-exports `depths`). This is the known gap in the reference ("does not follow barrels"), not a scanner fault; until the reference follows re-exports, these numbers cannot show a scanner regression smaller than about 15%.

### Names: hard boxes

New references, written from the code before the namer ran: `names-outline.json` (12 boxes), `names-mealie.json` (10), `names-miniflux.json` (4: Miniflux's draft has only 4 boxes, so it cannot have the 8 the plan asked for). Every box listed is one the README does not explain (`.oxlint`, `__mocks__`, `relativeci.config.js`, `dev`, `.semgrep`, `frontend/server`, …), each with a forbidden phrase for a plausible misreading (`relativeci` as "relative import", `__mocks__` as `jest`, `build.js` as the client bundle).

| | boxes | noted | namer time / tokens | described boxes passing |
| --- | --- | --- | --- | --- |
| Outline | 15 | 15 | 24.9 s / 21,471 | 12 of 12 (2 near misses: `.claude` missed "verify"; `lint-staged` missed the translation step) |
| Mealie | 13 | 13 | 17.8 s / 20,398 | 10 of 10 as first written; **8 of 10** after tightening |
| Miniflux | 4 | 4 | 13.1 s / 16,847 | 3 of 4 (`.github` named "Commit message checker") |

- Mealie scored 10 of 10 with no near miss, so the reference was tightened after reading the code again (and, honestly, after reading the notes): `frontend/vuetify.options.js` is imported by nothing (the Nuxt config carries the Vuetify settings), and `docs` is the MkDocs user documentation, not "JavaScript assets". Both now fail. This is recorded in the reference's note.
- The three misses share a cause: **the namer describes the files the scan lists**, and on a repo the scan does not read, those are the wrong files. Miniflux's `.github` holds 9 workflows, issue templates and dependabot, but the brief lists only the one Python script, so the note describes a commit checker. Mealie's `docs` brief lists the two `.js` files among the Markdown. Phase 4 (and the brief listing unscanned files by name) should move these.
- 20 of 32 notes say "inferred from file names". Each namer made 4 tool calls and reported opening at most three files.

### Flows: Outline reference questions

`tests/eval/references/flows-outline.json`, written before reading any journey: `collab-keystroke` (a keystroke reaches other editors), `create-document` (a new document appears in other sidebars), `slack-sign-in`. The namer's suggested journeys were different questions, so the tracer was also run on these three, with the `d` request text plus the journey's id.

| question (required hops) | result | matched / missed | why it fails |
| --- | --- | --- | --- |
| `collab-keystroke` (2 + 2 optional) | ✗ | 3 of 3 present, in order | `app → server` (websocket) has no model relationship and no import; key file `PersistenceExtension.ts` not read |
| `create-document` (2 + 1 optional) | ✗ | 2 of 2, in order | `app → server` (HTTP) has no model relationship; `server → app` (socket.io push) has no import |
| `slack-sign-in` (2 + 2 optional) | ✗ | 3, 1 missed (`app → plugins`), 1 additional (`server → plugins`) | as above; the tracer's reading (browser → server's auth router → plugin router) is arguably more exact than the reference's `app → plugins` |
| passes | **0 of 3** | | |

- **No trace of these questions can pass the current pass mark.** A pass requires every hop to have a model relationship and an import behind it; two of the three answers cross HTTP or a websocket, which the import-drawn map never has. The tracer found the path each time (5 of the 6 required hops, all in order, nothing invented; the sixth is the disputed `app → plugins`) and was failed for the map's missing edge kind. Until the map can hold runtime edges or the scorer separates "the map lacks this kind of edge" from "unbacked", this score measures the map, not the trace.
- Across all recorded journeys on Outline and Mealie, 10 of 24 hops were flagged `≠` by `flow add`, and every one is a real network or build-script hop.

### The namer's journeys, traced (all three repos)

| | journey | result |
| --- | --- | --- |
| Outline | open the app, sign in, collections load | recorded, 2 steps, but bent to model-backed hops (plugin loading, shared types); the real hops are HTTP calls with no arrow |
| | a queued email is sent | recorded as two `server → shared` helper calls: `flow add` refused one step, so the tracer added a second real but trivial hop; the email path is inside `server` |
| | `dev:backend` builds and watches | recorded, 3 steps, all 3 flagged (build script → folders, no import) |
| Mealie | import a recipe from a URL | recorded, 2 steps, clean |
| | `/api` through the Nuxt proxy | **refused**: `--reads 'frontend/server/api/[...].ts'` was "not a file in the workspace" (the `..` check matched inside `[...]`). Fixed in `src/flow-write.ts` with a test; re-run recorded 4 steps, all flagged (no `app → server` or `server → backend` relationship) |
| | shopping list page loads | recorded, 2 steps, clean |
| Miniflux | run the binary / open the web UI / list entries via the API | **none recorded**: every path is inside `internal`, and a journey needs two hops between different components. The tracers refused to pad. |

Tracer runs took 19–41 s and 18,000–30,000 tokens each.

What this baseline cannot show: one run per agent and question; three repositories; references written by one person in one sitting, before (and for Mealie's tightening, after) seeing the agents' output. It shows where the current pipeline stops on code it has not seen: languages the scan does not read (Phase 4), runtime edges no phase yet owns, and scores that pass because they count only what the scan reads.

## Instruments corrected (2026-10-28)

Phase 2b fixed the instruments the Phase 1 review found wrong before anything is scored against them again (`docs/internal/plans/phase-2b-instruments.md`). Every run below was on scratch clones of the three reference repositories (each with its Phase 1 `.pathlight/` copied in), not on the clones themselves. No namer or tracer was run: the overlays and journeys are Phase 1's.

### Files with `...` in their names

`pathlight flows` skipped any file name containing `..`, so `frontend/server/api/[...].ts` (Mealie's Nuxt catch-all route) was never read from a flow's text. It now refuses only a `..` path segment, as `pathlight flow add` does. On Mealie's `api-proxy` journey the description names three files, and the scorer now finds all three (it found two before). A journey's out-of-date check was already right: it goes by the components whose files changed, and `frontend/server/**` maps to `server`, so editing the file marked the journey `behind` before and after. `pathlight flows --json` for journeys has not changed (it lists components, not files).

### Flows: hops that are not imports

```sh
bun tests/eval/flows.ts --workspace outline --reference tests/eval/references/flows-outline.json
bun tests/eval/flows.ts --workspace . --reference tests/eval/references/flows.json
```

A reference hop can now carry `"over": "http" | "websocket" | "process"`, written in by hand from reading the code (each question's `note` names the file and line). The scorer still requires such a hop to be present, in order, with the key files read, but not backed by a model relationship or an import. It reports these hops on a line of their own (`runtime hops: N, of which M unbacked in the model`). The same hop without `over` still fails (`tests/eval-flows.test.ts`). The Slack answer was corrected as the Phase 1 review decided, after reading the tracer's trace: `app → server` (http), `server → plugins`, `plugins → server`, `server → app` optional (http).

| Outline question | before | after |
| --- | --- | --- |
| `collab-keystroke` | ✗ 1 without a model relationship, 2 without an import; key files 3/4 | ✗ runtime hops 2 (1 unbacked in the model); key files 3/4 (`server/collaboration/PersistenceExtension.ts` unread) |
| `create-document` | ✗ 1 without a model relationship, 2 without an import | **✓** runtime hops 2 (1 unbacked) |
| `slack-sign-in` | ✗ `app → plugins` missed; 1 without a relationship, 2 without an import; key files 4/5 | ✗ 4 of 4 hops in order, runtime hops 2 (1 unbacked); key files 4/5 (`server/commands/accountProvisioner.ts` not cited, though step 3's text names `accountProvisioner`) |
| passes | 0 of 3 | **1 of 3** |

The review expected about 2 of 3. The difference is Slack's key file. Before the correction the trace failed for its hops, so the unread file was never the only reason. The key files were not changed to fit the trace. On this repository the five questions have no journeys written (the 2026-10-24 traces were made in scratch checkouts that are gone), so the score is "no journey written" for all five before and after. Its three `plugin → launcher` hops are now `over: "process"`: the Claude hooks run the `pathlight` binary (`plugins/claude/hooks/hooks.json` lines 8, 19, 30 and 60; `plugins/claude/open-hook.sh` line 16). There is no Mealie flows reference.

### Facts: the reference follows re-exports

```sh
bun tests/eval/facts.ts --workspace outline --out /tmp/facts-outline.json
bun tests/eval/facts.ts --workspace .cache/eval/opencode-installed --out /tmp/facts-opencode.json
```

The independent reference now follows each imported name through `export * from`, `export { a as b } from`, `export * as ns from` and their type forms to the file that declares it, as the scan does. It uses its own patterns and `oxc-resolver`, not the scanner's tokenizer or `throughReexports`.

| | scan pairs | reference pairs | both | scan only | reference only |
| --- | --- | --- | --- | --- | --- |
| Outline, before | 13,154 | 12,246 | 11,123 | 2,031 | 1,123 |
| Outline, after | 13,154 | 13,154 | 13,154 | **0** | **0** |
| opencode `5fa426f68d`, before | 20,538 | 19,405 | 17,758 | 2,780 | 1,647 |
| opencode, after | 20,538 | 20,518 | 20,507 | **31** | **11** |

On Outline the two now agree on every pair, so the 15% band that could hide a regression is gone. On opencode every remaining pair is one of the known kinds, each read in the source:
- **Scan only (31):** 20 are `?raw` or `?inline` imports, which oxc-resolver does not resolve (`fixture.tsx` importing `edit.ts?raw`, `notices.ts` importing `.txt?raw`, the `gui-extensions` stylesheets as `.css?inline`, `desktop-cli.ts` importing `install?raw`). 11 reach `packages/console/resource/resource.cloudflare.ts` through a `production` export condition, which is not among the reference's conditions.
- **Reference only (11):** import text inside template strings, which the reference's pattern match counts and the scan does not (`packages/sdk/script/verify-package.ts` line 104, `packages/core/test/plugin/module.test.ts` line 160, `packages/client/script/build.ts` line 116, and so on).

While this was being written, the first version of the reference disagreed on 117 opencode pairs. Most came from files that re-export themselves as a namespace (`export * as RequestExecutor from "./executor.js"` inside `executor.ts`): the reference had dropped a file's own import before it could carry the name. The scan was right, and the reference was fixed.

### Brief: files that are not code

```sh
bun src/cli.ts brief --workspace v2 .github internal
bun src/cli.ts brief --workspace mealie docs mealie
```

Source files in languages the scan does not read (Go, Python, Vue) were already listed in each box. What a box never showed was its files in no programming language. `pathlight brief` now names every file a box's mapping claims and the brief does not otherwise list (minus what the draft ignores, such as tests), with its kind. It shows at most 40, one from each folder in turn (shallowest first, images and fonts last), then `… and N more`.

- Miniflux `.github`, before: one file, `commit-checker.py`. After: also `dependabot.yml`, the 6 issue templates, `pull_request_template.md` and the 9 workflows (17 files).
- Mealie `docs`, before: `extra.js`, `analytics.js`. After: these lead the new list: `docs/mkdocs.yml [YAML]`, `docs/docs/index.md [Markdown]`, `docs/overrides/home.html [HTML]`, the contributor and user guides…
- The Phase 1 name scores, re-scored with `bun tests/eval/names.ts --workspace W --reference tests/eval/references/names-R.json`, are unchanged: Outline 12 of 12, Mealie 8 of 10, Miniflux 3 of 4. The overlays are Phase 1's, so they could not move. Whether the two misses this was for (`.github` as a commit checker, Mealie `docs` as JavaScript assets) now pass needs the next naming run.
- Limit: on a large box such as Mealie's backend or Miniflux's `internal` the 40 still go mostly to translation JSON and test data, one folder at a time. The list says what is there; it does not rank what matters.

## Languages (2026-10-28)

The scan reads Python and Go (`docs/scan.md`, "Languages"). Each is measured against its own language's tools, written without reading the front end it checks. Runs on the reference clones themselves (read-only: `scan` and the references only); drafts and names on scratch copies.

### Python against CPython

```sh
bun tests/eval/facts-python.ts --workspace pathlight-oss-test-repos/mealie --python "uv run --python 3.14 --no-project python" --out /tmp/facts-python.json
```

`tests/eval/facts_python.py` finds the statements with CPython's `ast` and resolves them with `importlib.machinery.PathFinder` over the project's roots as `sys.path`, searched together the way the interpreter searches; it follows a name taken from a package through the package's `__init__.py` to the statement that binds it, keeping the last binding as the interpreter does (the scan takes the first match). It must run on the Python the project declares: Mealie needs 3.14 (`requires-python = ">=3.14,<3.15"`), and on 3.13 `ast` cannot parse 10 files that use `except A, B:` without parentheses (PEP 758).

| Mealie `2e7358d10`, 696 Python files | scan pairs | reference pairs | both | scan only | reference only |
| --- | --- | --- | --- | --- | --- |
| reference on CPython 3.13 | 2,777 | 2,712 | 2,711 | 66 | 1 |
| reference on CPython 3.14, first scan rule | 2,777 | 2,776 | 2,775 | 2 | 1 |
| reference on CPython 3.14, final | 2,776 | 2,776 | **2,776** | **0** | **0** |

- **On 3.13**, all 66 scan-only pairs come from the 10 files the older `ast` could not parse (`mealie/repos/repository_generic.py` line 83, `mealie/services/scraper/cleaner.py` line 590, `mealie/core/security/providers/ldap_provider.py` line 139 …); tree-sitter reads them. The reference was wrong, not the scan.
- **The three left on 3.14 were one scan rule, now changed.** `mealie/routes/shared/__init__.py` is a package's `__init__.py` that holds a controller of its own, and imports `from mealie.routes._base import BaseUserController, controller` and `from mealie.schema.recipe import RecipeShareTokenSummary`. The first rule treated every `from … import` in an `__init__.py` as a barrel line and kept it on the package it names (as TypeScript keeps a barrel's `export … from`), so the scan had `→ mealie/routes/_base/__init__.py` and `→ mealie/schema/recipe/__init__.py` where the reference followed the names to `base_controllers.py` (and to `recipe_share_token.py`, which line 11 also reaches). The plan's rule names a barrel's `from .mod import name`, so only relative imports in an `__init__.py` are barrel lines now; an `__init__.py`'s other imports are its own and are followed like any file's.
- **grimp** (`uv run --python 3.14 --with grimp`, `build_graph("mealie", cache_dir=None)`, nothing written to the clone), compared at the package level (folder to folder): grimp has 523 pairs, the scan 559; all 523 are the scan's. The scan's 36 others all start or end in a folder without `__init__.py` (`mealie/alembic`, `mealie/alembic/versions`, `mealie/core/logger`, `mealie/db/fixes`, `mealie/scripts`, `mealie/services/analytics`), which grimp does not count as part of the package; CPython imports them as namespace packages.

### Go against `go list`

```sh
bun tests/eval/facts-go.ts --workspace pathlight-oss-test-repos/v2 --out /tmp/facts-go.json
```

`go list -e -json ./...` in each module (`GOFLAGS=-mod=readonly`, `GOPROXY=off`: nothing fetched or written; dependencies that are not downloaded are errors, but `Imports` still come from the source), each package's `Imports`, `TestImports` and `XTestImports` within the module, against the scan's file records collapsed to their folders.

| Miniflux `d5c529b9`, 434 Go files, 88 packages | scan pairs | reference pairs | both | scan only | reference only |
| --- | --- | --- | --- | --- | --- |
| package to package | 365 | 365 | **365** | **0** | **0** |

No file in Miniflux carries a build constraint (`IgnoredGoFiles` is empty), so the expected class of disagreement, a file the scan reads and `go list` leaves out for its tags, does not occur here; the script lists such files when there are any. The comparison is at the package level, which is what `go list` answers: it cannot check which files of a package the scan chose for an import (the files that declare the names used). Of the 624 import statements into a package of several files, 3 fell back to every file of the package (a used name no file declares).

### What the map says now (scratch copies, `pathlight draft` then `check` and `tests/eval/run.ts`)

| | boxes / relationships | files the scorer counts | edges supported | undeclared | most boxes in a readable view |
| --- | --- | --- | --- | --- | --- |
| Mealie, Phase 1 map, `main`'s code | 13 / 1 | 309 of 309 | 1 of 1 | 0 | 6 |
| Mealie, re-drafted | 13 / 3 | 802 of 802 | 3 of 3 | 0 | 6 |
| Miniflux, Phase 1 map, `main`'s code | 4 / 0 | 5 of 5 | 0 of 0 | 0 | 4 |
| Miniflux, re-drafted | 4 / 1 | 440 of 440 | 1 of 1 | 0 | 4 |

The new arrows are Mealie's `dev → backend` (4 imports) and `.semgrep → backend` (2) and Miniflux's `root → internal` (`main.go` into `internal/cli`); this branch's `check` already reports them as undeclared on the Phase 1 maps. No box says "not read by the scan" for Python or Go (Mealie's 238 Vue files still do). The pass marks hold. **The backends are still one box each** (Mealie `mealie` 623 files, Miniflux `internal` 550): the draft opens only a package's top-level folders, for every language (Outline's `server` is one box of 947 TypeScript files too). With an overlay `split` of that folder (a measurement on separate copies, not a first run) Miniflux draws 28 boxes and 124 relationships and Mealie 26 boxes and 61, every one import-backed, but the split breaks the pass mark for children side by side (Miniflux `small` 11, Mealie `mealie` 13). Drawing the inside of a large backend needs a grouping rule the draft does not have.

### Names, re-run

The `pathlight-namer` subagent on scratch copies of the three repos, with the Phase 1 overlay removed and the map redrawn unnamed, run headless (`claude -p "Use the pathlight:pathlight-namer subagent for this: Name every box of the pathlight map in DIR"` with this branch's plugin), scored with `bun tests/eval/names.ts --workspace DIR --reference tests/eval/references/names-REPO.json`. The drafts did not change their boxes, so every reference box exists.

| | Phase 1 | Phase 4 | time / cost | notes saying "inferred" |
| --- | --- | --- | --- | --- |
| Outline | 12 of 12 | 12 of 12 (`lint-staged` still misses the translation step, a near miss) | 84 s / $0.30 | 8 of 15 (11) |
| Mealie | 8 of 10 | **9 of 10**: `docs` passes ("User and contributor documentation site: MkDocs …"); `frontend/vuetify.options.js` still fails (the note does not say it is unused) | 60 s / $0.30 | 5 of 13 (8) |
| Miniflux | 3 of 4 | **4 of 4**: `.github` is "GitHub automation and issue templates" | 42 s / $0.22 | 0 of 4 (1) |

No note describes translation files (three large boxes mention translations among their contents, which is true), so `brief`'s list of other files was left as it is. One run per repository.

## Open the big box (2026-10-28)

The draft opens a folder that holds more than half of its holder's read files and, besides, either at least 100 of them (`openFloor`) or nine in ten of them (`openShare`), and has subfolders; the same test applies inside it, a chain of single folders collapses, and a `split` opens any folder with subfolders. An opened folder has its own view with its nine strongest children as cards (`folderCap`, collections among them) and the rest in its everything view. Scratch copies of the reference clones, drafted with `main` (before) and with this phase (after), scored with this phase's `tests/eval/run.ts` both times so the new count is there for both.

| | boxes / relationships | opened folders (children, cards) | files the scorer counts | edges supported | undeclared | most boxes in a readable view | most cards inside one box |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Mealie, before | 13 / 3 | none | 802 of 802 | 3 of 3 | 0 | 6 | 4 |
| Mealie, after | 36 / 62 | `mealie` (13, 9), `frontend/app` (10, 9) | 800 of 800 | 62 of 62 | 0 | 12 | 9 |
| Miniflux, before | 4 / 1 | none | 440 of 440 | 1 of 1 | 0 | 4 | 0 |
| Miniflux, after | 30 / 124 | `internal` (16, 9: eight children and the small-folders collection of ten) | 440 of 440 | 124 of 124 | 0 | 18 | 9 |
| Outline, after (with its six journeys) | 15 / 9 | none | 2,417 of 2,417 | 9 of 9 | 0 | 8 | 7 |

- **Outline and opencode do not change.** Their drafts are byte-identical to `main`'s, model and mapping, on copies without journeys; Outline's copy with its six journeys differs by one line, the `#behavior` exclusion that `main` wrote and LikeC4 rejected (on `main` its `check` fails; here it is clean). No opencode folder meets the rule: its biggest over-half folder holds 83 read files at 59%, and its highest share is 82%.
- **Mealie's 802 → 800** is two test files, `frontend/app/tests/setup.ts` and `utils.ts`: `main`'s `frontend/app/**` claimed them by accident, and now `tests/` is not a child of the opened folder, so they are ignored on purpose like every other test.
- **Pass marks hold**: every file claimed, every edge supported, no pair undeclared, no readable view over 20, no view drawing more than nine children of one box.
- **Time**: `pathlight draft` (three runs) Mealie 0.75–0.79 s before, 0.76–0.78 s after; Miniflux 0.56–0.57 s both. `scanWorkspace` (median of five) is unchanged: Mealie 544 / 562 ms, Miniflux 393 / 392 ms (`src/scan.ts` did not change).

**Names.** On the scratch copies with the clones' Phase 1 overlays, every existing key persists: Outline 12 of 12, Mealie 8 of 10, Miniflux 3 of 4, as before. The namer was then run once on Mealie and Miniflux as Phase 4 did (Phase 1 overlay removed, map redrawn unnamed, headless `claude -p` with the `pathlight-namer` subagent; logs and the overlay it wrote under `docs/internal/baseline/{mealie,v2}/phase-4a/logs/`):

| | Phase 4 | now | time / cost | notes saying "inferred" (new boxes) |
| --- | --- | --- | --- | --- |
| Mealie | 9 of 10 | **8 of 10**: `frontend/vuetify.options.js` still fails as in Phase 4; `mealie` now fails for saying "frontend" | 141 s / $0.47 | 11 of 36 (7 of 21) |
| Miniflux | 4 of 4 | 4 of 4 | 108 s / $0.45 | 0 of 30 (0 of 25) |

The `mealie` note that fails reads "The FastAPI backend: HTTP routes call services, which use repositories over SQLAlchemy models … Also serves the built frontend in production." The last sentence is true (`mealie/app.py` line 160 calls `spa.mount_spa(app)`), so the reference's forbidden word, meant for a namer that takes the backend for the whole app, catches a correct note here. One run; the reference was not changed by the build. The review (2026-10-29) corrected the reference: `mealie` now forbids `vue` and `nuxt`, which only a note that puts the UI in the backend folder would say; the same namer overlay scores **9 of 10** against it (`frontend/vuetify.options.js` is the one miss, as in Phase 4), and the Phase 1 overlay stays 8 of 10.
