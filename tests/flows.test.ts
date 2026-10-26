import { expect, test } from "bun:test";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assessFlow, assessJourney, namedFiles, syncOf, type FlowInput, type JourneyInput } from "../src/flows";
import { run } from "./effects";

const cli = (...args: string[]) => run(process.execPath, [resolve("src/cli.ts"), ...args]);
const none = { changed: new Set<string>(), known: () => true };
const flow = (patch: Partial<FlowInput> = {}): FlowInput => ({
  id: "signup", title: "Signing up", view: "signup", viewDescription: "Agent-written. Synced at 3f2a9c1.",
  states: [
    { id: "signup.start", title: "Opens the page", kind: "state", tags: [], description: "src/web/signup.ts" },
    { id: "signup.ask", title: "Email used?", kind: "decision", tags: [], description: "" },
    { id: "signup.done", title: "Account made", kind: "state", tags: [], description: "src/api/users.ts, see Node.js notes" },
  ],
  arrows: [{ source: "signup.start", target: "signup.ask", title: "submits" }, { source: "signup.ask", target: "signup.done", title: "no" }, { source: "signup.ask", target: "signup.start", title: "yes" }],
  ...patch,
});
const files = new Set(["src/web/signup.ts", "src/api/users.ts", "package.json"]);
const paths = (path: string) => files.has(path);

test("a flow whose files exist, are unchanged and whose arrows all carry events has nothing to report", () => {
  const report = assessFlow(flow(), paths, undefined, none);
  expect(report.findings).toEqual([]);
  expect(report.sync).toEqual({ status: "current", sha: "3f2a9c1" });
  expect(report.states.map(state => state.files.map(file => file.status))).toEqual([["ok"], [], ["ok"]]);
});

test("file names in prose: a path with a slash must exist, a bare word counts only when it is a file", () => {
  expect(namedFiles("src/a.ts, then package.json. Uses Node.js and e.g. foo (src/gone.ts).", paths)).toEqual([
    { path: "src/a.ts", exists: false }, { path: "package.json", exists: true }, { path: "src/gone.ts", exists: false },
  ]);
  expect(namedFiles("see https://example.com/a.ts and /etc/passwd and ../x/y.ts", paths)).toEqual([]);
});

test("each way a flow can be wrong or old is reported once, naming the state", () => {
  const report = assessFlow(flow({
    states: [
      { id: "s.a", title: "First", kind: "state", tags: [], description: "src/web/signup.ts" },
      { id: "s.b", title: "Gone", kind: "state", tags: ["bug"], description: "src/missing.ts" },
      { id: "s.c", title: "Floating", kind: "state", tags: [], description: "" },
      { id: "s.d", title: "Which way?", kind: "decision", tags: [], description: "" },
    ],
    arrows: [{ source: "s.a", target: "s.b", title: null }, { source: "s.d", target: "s.a", title: "only" }],
    viewDescription: "no stamp here",
  }), paths, undefined, { changed: new Set(["src/web/signup.ts"]), known: () => true });
  expect(report.findings).toEqual([
    "“Gone” names src/missing.ts, which is not in the workspace.",
    "The view has no “Synced at <commit>” note, so nobody can tell how old this reading is.",
    "1 of 3 states name no file, so they cannot be checked.",
    "The arrow from “First” to “Gone” says no event.",
    "The decision “Which way?” has one answer; a decision asks a question with two or more.",
    "Nothing leads to “Floating” from the first state, “First”.",
    "Nothing leads to “Which way?” from the first state, “First”.",
  ]);
  expect(report.unverified).toBe(1);
  expect(report.sync).toEqual({ status: "none" });
});

test("a sync commit that is not in the repository is reported, and so are files changed since a known one", () => {
  expect(assessFlow(flow(), paths, undefined, { changed: new Set(), known: () => false }).findings).toContain("The view was synced at 3f2a9c1, which is not a commit in this repository.");
  const behind = assessFlow(flow(), paths, undefined, { changed: new Set(["src/api/users.ts"]), known: () => true });
  expect(behind.sync).toEqual({ status: "behind", sha: "3f2a9c1" });
  expect(behind.findings).toEqual(["“Account made” names src/api/users.ts, which changed after the flow was synced at 3f2a9c1."]);
  expect(syncOf("Synced at ABCDEF1234")).toBe("abcdef1234");
  expect(syncOf("Synced at xyz")).toBeUndefined();
});

test("a state's files map to the elements the activity mapping gives them", () => {
  const config = { version: 1 as const, project: "p", mappings: [{ glob: "src/api/**", element: "api" }, { glob: "src/**", element: "everything" }] };
  expect(assessFlow(flow(), paths, config, none).states.map(state => state.elements)).toEqual([["everything"], [], ["api", "everything"]]);
});

// The oracle is only worth having if it fails when the code moves under the diagram: a real repository, a flow synced at its first commit,
// then the files are changed and removed one by one.
test("against a real repository: current at the sync commit, behind after an edit, and missing after a delete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-flows-"));
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await mkdir(join(directory, "src/web"), { recursive: true });
    await writeFile(join(directory, "src/web/signup.ts"), "export const a = 1;\n");
    const git = (...args: string[]) => run("git", ["-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    await git("init", "-q");
    await git("add", "-A");
    await git("commit", "-q", "-m", "first");
    const sha = (await git("rev-parse", "--short", "HEAD"));
    await writeFile(join(directory, "signup.behavior.c4"), `specification {\n  element flow\n  element state\n  element decision\n  tag behavior\n}\nmodel {\n  signup = flow 'Signing up' {\n    #behavior\n    start = state 'Opens the page' { description 'src/web/signup.ts' }\n    next = state 'Sees the form' { description 'src/web/signup.ts' }\n    start -> next 'loads'\n  }\n}\nviews {\n  view signup of signup {\n    title 'Sign up'\n    description 'Agent-written. Synced at ${sha}.'\n    include *\n    autoLayout TopBottom\n  }\n}\n`);
    await git("add", "-A");
    await git("commit", "-q", "-m", "flow");
    const report = async () => JSON.parse(await cli("flows", "--workspace", directory, "--json")) as { flows: { sync: { status: string; sha?: string }; findings: string[] }[]; summary: { findings: number; behind: number } };

    const clean = await report();
    expect(clean.flows[0]!.sync).toEqual({ status: "current", sha });
    expect(clean.flows[0]!.findings).toEqual([]);

    await writeFile(join(directory, "src/web/signup.ts"), "export const a = 2;\n");
    const edited = await report();
    expect(edited.flows[0]!.sync.status).toBe("behind");
    expect(edited.summary.behind).toBe(1);
    expect(edited.flows[0]!.findings[0]).toContain("changed after the flow was synced");

    await rm(join(directory, "src/web/signup.ts"));
    const gone = await report();
    expect(gone.flows[0]!.findings.some(text => text.includes("is not in the workspace"))).toBe(true);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test("a journey reports each step the model has no relationship for, a missing or unknown sync note, and components whose files changed since", () => {
  const journey = (patch: Partial<JourneyInput> = {}): JourneyInput => ({
    id: "placeorder", title: "Placing an order", viewDescription: "Synced at abc1234.",
    steps: [
      { source: "customer", target: "parcel.storefront", title: "opens checkout", backed: true },
      { source: "parcel.commerce.orders", target: "parcel.fulfillment.shipping", title: "tells shipping directly", backed: false },
    ], ...patch,
  });
  const known = () => true;
  expect(assessJourney(journey(), { changedElements: new Set(), known }).findings).toEqual(["Step 2, “tells shipping directly”, goes from orders to shipping with no relationship between them in the model."]);
  // Two hops over one unrelated pair are one gap; a hop back the way an earlier one went is its answer and no gap.
  const http = assessJourney(journey({ steps: [
    { source: "page", target: "server", title: "loads", backed: false }, { source: "server", target: "page", title: "returns", backed: false },
    { source: "page", target: "server", title: "sends", backed: false },
  ] }), { changedElements: new Set(), known });
  expect(http.findings).toEqual(["Steps 1 and 3 go from page to server with no relationship between them in the model."]);
  expect(http.steps.map(step => step.reply ?? false)).toEqual([false, true, false]);
  const clean = assessJourney(journey({ steps: [journey().steps[0]!] }), { changedElements: new Set(), known });
  expect(clean.findings).toEqual([]);
  expect(clean.sync).toEqual({ status: "current", sha: "abc1234" });
  expect(clean.steps).toEqual([{ n: 1, title: "opens checkout", elements: ["customer", "parcel.storefront"], from: "customer", to: "parcel.storefront", backed: true }]);
  const behind = assessJourney(journey({ steps: [journey().steps[0]!] }), { changedElements: new Set(["parcel.storefront"]), known });
  expect(behind.sync).toEqual({ status: "behind", sha: "abc1234" });
  expect(behind.findings).toEqual(["Files of storefront changed after the flow was synced at abc1234."]);
  expect(assessJourney(journey({ viewDescription: "" }), { changedElements: new Set(), known }).findings).toContain("The view has no “Synced at <commit>” note, so nobody can tell how old this reading is.");
  expect(assessJourney(journey(), { changedElements: new Set(), known: () => false }).findings).toContain("The view was synced at abc1234, which is not a commit in this repository.");
});

test("against a real model: a dynamic view is a journey, and a step with no relationship behind it is reported by the CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-journey-"));
  try {
    await cp("examples/parcel", directory, { recursive: true, filter: path => !path.includes(".cache") });
    await writeFile(join(directory, "views.c4"), `${await readFile(join(directory, "views.c4"), "utf8")}
views {
  dynamic view placeorder {
    title 'Placing an order'
    description 'Synced at abc1234.'
    customer -> parcel.storefront 'opens checkout'
    parcel.storefront -> parcel.commerce.api 'submits the cart'
    parcel.commerce.orders -> parcel.fulfillment.shipping 'tells shipping directly'
  }
}
`);
    const report = JSON.parse(await cli("flows", "--workspace", directory, "--json")) as { journeys: { id: string; steps: { backed: boolean }[]; findings: string[] }[]; summary: { journeys: number } };
    expect(report.summary.journeys).toBe(1);
    expect(report.journeys[0]!.steps.map(step => step.backed)).toEqual([true, true, false]);
    expect(report.journeys[0]!.findings.some(text => text.includes("with no relationship between them in the model"))).toBe(true);
    expect(await cli("flows", "--workspace", directory)).toContain("journey placeorder; 3 steps");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
