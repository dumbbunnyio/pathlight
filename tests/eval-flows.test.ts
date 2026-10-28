import { expect, test } from "bun:test";
import { passes, scoreFlow, type FlowScoreInput, type Hop } from "./eval/flow-score";

const question = {
  id: "check-run", question: "q", files: ["src/cli.ts", "src/check.ts"],
  hops: [{ from: "launcher", to: "scanner" }, { from: "scanner", to: "activity" }, { from: "scanner", to: "catalog" }],
};
const good: Hop[] = question.hops.map(hop => ({ ...hop, backed: true }));
const cited = ["src/cli.ts", "src/check.ts", "src/stale.ts"];
// Imports exist for the pairs below (either direction counts) and for nothing else.
const joined = new Set(["launcher|scanner", "scanner|activity", "scanner|catalog", "viewer|catalog"]);
const supported = (from: string, to: string) => joined.has(`${from}|${to}`) || joined.has(`${to}|${from}`);
const run = (patch: Partial<NonNullable<FlowScoreInput["written"]>> | null) => scoreFlow({
  question, supported,
  written: patch === null ? undefined : { hops: good, cited, missingFiles: [], findings: [], ...patch },
});

// Each planted defect says what the scorer must notice, so a scorer that stops noticing fails here.
test("a trace that matches the answer, in order, with real files, passes", () => {
  const score = run({});
  expect(score).toMatchObject({ written: true, hops: 3, matched: 3, ordered: 3, invented: [], additional: [], unbacked: 0, unsupported: 0, citedKey: 2 });
  expect(passes(score)).toBe(true);
});

test("planted: no journey at all, a missing hop, and the same hops in the wrong order", () => {
  expect(passes(run(null))).toBe(false);
  const short = run({ hops: good.slice(0, 2) });
  expect(short.missed).toEqual(["scanner → catalog"]);
  expect(passes(short)).toBe(false);
  const swapped = run({ hops: [good[0]!, good[2]!, good[1]!] });
  expect(swapped).toMatchObject({ matched: 3, ordered: 2 });
  expect(passes(swapped)).toBe(false);
});

test("planted: a hop nothing stands behind is invented; one an import supports but the model lacks is a model gap; one both back is an additional reading", () => {
  const made = run({ hops: [...good, { from: "viewer", to: "themes", backed: false }] });
  expect(made.invented).toEqual(["viewer → themes"]);
  expect(made.unbacked).toBe(1);
  expect(passes(made)).toBe(false);
  // The code does it, the model does not say so: the story and the model disagree, which is neither an invention nor a pass.
  const gap = run({ hops: [...good, { from: "viewer", to: "catalog", backed: false }] });
  expect(gap).toMatchObject({ invented: [], modelGaps: ["viewer → catalog"], unbacked: 1 });
  expect(passes(gap)).toBe(false);
  // Backed by a relationship but no import joins the pair: the claim has nothing in the code behind it.
  const lonely = run({ hops: [...good, { from: "launcher", to: "viewer", backed: true }] });
  expect(lonely.invented).toEqual(["launcher → viewer"]);
  expect(lonely.unsupported).toBe(1);
  // Both: a different but defensible hop.
  const other = run({ hops: [...good, { from: "viewer", to: "catalog", backed: true }] });
  expect(other.invented).toEqual([]);
  expect(other.additional).toEqual(["viewer → catalog"]);
  expect(passes(other)).toBe(true);
});

test("planted: a cited file that is not there, and a key file never read", () => {
  const gone = run({ cited: ["src/cli.ts", "src/check.ts"], missingFiles: ["src/nope.ts"] });
  expect(gone.missingFiles).toEqual(["src/nope.ts"]);
  expect(passes(gone)).toBe(false);
  const unread = run({ cited: ["src/stale.ts"] });
  expect(unread.citedKey).toBe(0);
  expect(passes(unread)).toBe(false);
});

test("an optional hop of the answer is never missed, and counts as matched when it is drawn", () => {
  const withOptional = { ...question, hops: [...question.hops.slice(0, 2), { ...question.hops[2]!, optional: true }] };
  const score = (hops: Hop[]) => scoreFlow({ question: withOptional, supported, written: { hops, cited, missingFiles: [], findings: [] } });
  expect(passes(score(good.slice(0, 2)))).toBe(true);
  expect(score(good)).toMatchObject({ matched: 3, ordered: 3, missed: [] });
  expect(passes(score(good))).toBe(true);
  // A required hop is still required.
  expect(passes(score([good[0]!, good[2]!]))).toBe(false);
});

test("planted: a hop the answer marks `over` passes with no relationship and no import, still has to be there, and the same hop unmarked fails", () => {
  // The browser asks the server over HTTP: no import joins app and server, and the import-drawn model has no arrow for it.
  const web = { id: "sign-in", question: "q", files: ["app/login.tsx"], hops: [{ from: "app", to: "server", over: "http" as const }, { from: "server", to: "plugins" }] };
  const hops: Hop[] = [{ from: "app", to: "server", backed: false }, { from: "server", to: "plugins", backed: true }];
  const linked = (from: string, to: string) => `${from}|${to}` === "server|plugins";
  const score = (question: typeof web | Omit<typeof web, "hops"> & { hops: { from: string; to: string }[] }, drawn = hops) => scoreFlow({ question, supported: linked, written: { hops: drawn, cited: ["app/login.tsx"], missingFiles: [], findings: [] } });
  const marked = score(web);
  expect(marked).toMatchObject({ unbacked: 0, unsupported: 0, runtime: ["app → server over http"], runtimeUnbacked: 1, missed: [] });
  expect(passes(marked)).toBe(true);
  // Marking a hop excuses the missing edge, not the hop: leaving it out is still a miss.
  expect(passes(score(web, hops.slice(1)))).toBe(false);
  const unmarked = score({ ...web, hops: [{ from: "app", to: "server" }, web.hops[1]!] });
  expect(unmarked).toMatchObject({ unbacked: 1, unsupported: 1, runtime: [] });
  expect(passes(unmarked)).toBe(false);
});
