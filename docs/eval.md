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
