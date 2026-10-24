#!/usr/bin/env bun
// bun tests/eval/flows.ts --workspace DIR --reference tests/eval/references/flows.json [--json]
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { Effect } from "effect";
import { formatFlowScores, passes, readFlowReference, scoreFlows } from "./flow-score";

const { values } = parseArgs({ options: { workspace: { type: "string", default: "." }, reference: { type: "string" }, json: { type: "boolean" } } });
if (!values.reference) throw new Error("Pass --reference FILE.");
const workspace = resolve(values.workspace!);
const scores = await Effect.runPromise(Effect.gen(function* () {
  return yield* scoreFlows(workspace, yield* readFlowReference(resolve(values.reference!)));
}));
process.stdout.write(values.json ? `${JSON.stringify(scores, null, 2)}\n` : `${formatFlowScores(scores, workspace)}\n`);
process.exitCode = scores.every(passes) ? 0 : 1;
