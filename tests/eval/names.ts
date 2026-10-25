#!/usr/bin/env bun
// bun tests/eval/names.ts --workspace DIR --reference tests/eval/references/names-dialupworld.json [--json]
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { Effect } from "effect";
import { formatNameScores, passes, readNameReference, readNames, scoreNames } from "./name-score";

const { values } = parseArgs({ options: { workspace: { type: "string", default: "." }, reference: { type: "string" }, json: { type: "boolean" } } });
if (!values.reference) throw new Error("Pass --reference FILE.");
const workspace = resolve(values.workspace!);
const report = await Effect.runPromise(Effect.gen(function* () {
  const reference = yield* readNameReference(resolve(values.reference!));
  const { keys, overlay } = yield* readNames(workspace);
  return scoreNames({ keys, overlay, reference });
}));
process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatNameScores(report, workspace)}\n`);
process.exitCode = report.entries.every(passes) ? 0 : 1;
