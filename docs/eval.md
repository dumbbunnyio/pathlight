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

`tests/eval.test.ts` plants one defect at a time (a missing relationship, an invented one, a dropped mapping, a crowded view) and requires the scorer to notice each, so a scorer that stops noticing fails the suite.

## Baseline: what an agent following the skill produces (2026-10-21)

Fresh agents (no draft, no overlay) followed the skill's hand-written workflow on scratch copies of `camenae` and `camenae-sdk`, and the scorer was run on what they wrote, not on their own reports.

| | files claimed | edges supported | pairs undeclared | readable view max boxes | elements / relationships |
| --- | --- | --- | --- | --- | --- |
| camenae, agent | 55 of 55 (71 ignored by the agent: tests, scripts, tools, docs) | 41 of 41 | 0 | 6 | 31 / 41 |
| camenae, draft | 97 of 97 (tests only ignored) | 73 of 73 | 0 | 20 | 34 / 73 |
| camenae-sdk, agent | 23 of 23 (81 ignored: tests, scripts, tools, examples, config) | 12 of 12 | 0 | 7 | 11 / 12 |
| camenae-sdk, draft | 70 of 70 | 3 of 3 | 0 | 7 | 8 / 3 |

**Pass marks, from this baseline:** every eligible file claimed, every relationship backed by an import, no connected pair undeclared, no readable view over 20 boxes, no group with more than about 7 children. Both agent models and both drafts meet all of them, so these are a floor, not a ranking.

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

A run passes when every hop of the answer is present and in order, nothing is invented, every hop is backed and supported, no cited file is missing and every key file was read. `tests/eval-flows.test.ts` plants one defect at a time (no journey, a missing hop, hops in the wrong order, an invented hop, a hop with a relationship but no import, a missing file, an unread key file) and requires the scorer to notice each.

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
