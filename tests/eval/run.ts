#!/usr/bin/env bun
// bun tests/eval/run.ts --workspace DIR [--reference FILE] [--json]
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { Effect } from "effect";
import { formatScore, readReference, scoreWorkspace } from "./score";

const { values } = parseArgs({ options: { workspace: { type: "string", default: "." }, reference: { type: "string" }, json: { type: "boolean" } } });
const workspace = resolve(values.workspace!);
const score = await Effect.runPromise(Effect.gen(function* () {
  const reference = values.reference ? yield* readReference(resolve(values.reference)) : undefined;
  return yield* scoreWorkspace(workspace, reference);
}));
process.stdout.write(values.json ? `${JSON.stringify(score, null, 2)}\n` : `${formatScore(score, workspace)}\n`);
process.exitCode = score.assertions.failures.length || score.edges.unsupported || score.pairs.undeclared || score.files.claimed < score.files.eligible ? 1 : 0;
