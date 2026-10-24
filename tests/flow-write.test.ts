import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseStep, renderJourney } from "../src/flow-write";
import { run } from "./effects";

const cli = (...args: string[]) => run(process.execPath, [resolve("src/cli.ts"), ...args]);
const fails = async (...args: string[]) => { try { await cli(...args); return "did not fail"; } catch (error) { return error instanceof Error ? error.message : String(error); } };

test("a step is `from -> to: event`; anything else is refused with the shape asked for", () => {
  expect(parseStep("customer -> parcel.storefront: opens checkout")).toEqual({ from: "customer", to: "parcel.storefront", title: "opens checkout" });
  expect(parseStep("a->b:  one: two ")).toEqual({ from: "a", to: "b", title: "one: two" });
  for (const bad of ["customer parcel", "a b -> c: x", "a -> b"]) expect(typeof parseStep(bad)).toBe("string");
});

test("the file is a dynamic view with the files and the commit in its description, and quotes escaped", () => {
  const text = renderJourney({ id: "place-order", title: "It's an order", reads: ["a.ts", "b.ts"], sha: "abc1234", steps: [{ from: "x", to: "y", title: "don't \\ panic" }] });
  expect(text).toContain("dynamic view place-order {");
  expect(text).toContain(`title 'It\\'s an order'`);
  expect(text).toContain("Agent-written from a.ts, b.ts. Synced at abc1234.");
  expect(text).toContain(`x -> y 'don\\'t \\\\ panic'`);
  expect(renderJourney({ id: "a", title: "t", reads: ["a.ts"], sha: undefined, steps: [] })).not.toContain("Synced at");
});

// Against a real repository and model: what is written compiles, is stamped, shows in `flows`, and a hand-written file is never overwritten or removed.
test("flow add writes a checked journey; refuses unknown components, unread files and files it did not write; remove takes back only its own", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-flow-write-"));
  try {
    await cp("examples/parcel", directory, { recursive: true, filter: path => !path.includes(".cache") });
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "src/checkout.ts"), "export const a = 1;\n");
    const git = (...args: string[]) => run("git", ["-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    await git("init", "-q"); await git("add", "-A"); await git("commit", "-q", "-m", "first");
    const sha = await git("rev-parse", "--short", "HEAD");
    const base = ["flow", "add", "place-order", "--workspace", directory, "--title", "Placing an order", "--reads", "src/checkout.ts"];
    const hops = ["--step", "customer -> parcel.storefront: opens checkout", "--step", "parcel.storefront -> parcel.commerce.api: submits the cart"];

    expect(await fails(...base, "--step", "customer -> parcel.storefrnt: x", "--step", "customer -> parcel.storefront: y")).toContain("Did you mean parcel.storefront");
    expect(await fails(...base.slice(0, -1), "src/nope.ts", ...hops)).toContain("not a file in the workspace");
    expect(await fails("flow", "add", "place-order", "--workspace", directory, "--title", "T", ...hops)).toContain("--reads");
    expect(await fails(...base, "--step", "customer -> parcel.storefront: only one")).toContain("at least two steps");
    expect(existsSync(join(directory, "place-order.behavior.c4"))).toBe(false);

    const out = await cli(...base, ...hops);
    expect(out).toContain("Wrote place-order.behavior.c4: a journey of 2 steps.");
    expect(out).toContain("finds nothing to report");
    const written = await readFile(join(directory, "place-order.behavior.c4"), "utf8");
    expect(written).toContain(`Synced at ${sha}.`);
    const report = JSON.parse(await cli("flows", "--workspace", directory, "--json")) as { journeys: { id: string; sync: { status: string }; steps: { backed: boolean }[] }[] };
    expect(report.journeys.map(journey => [journey.id, journey.sync.status, journey.steps.map(step => step.backed)])).toEqual([["place-order", "current", [true, true]]]);

    // A hop the model has no relationship for is written, and reported rather than hidden.
    const loose = await cli("flow", "add", "loose", "--workspace", directory, "--title", "Loose", "--reads", "src/checkout.ts", ...hops, "--step", "parcel.commerce.orders -> parcel.fulfillment.shipping: tells shipping directly");
    expect(loose).toContain("Check: Step 3");

    expect(await fails(...base, ...hops)).toContain("already exists");
    expect(await cli(...base, ...hops, "--force")).toContain("Wrote place-order.behavior.c4");

    await writeFile(join(directory, "mine.behavior.c4"), "// mine\n");
    expect(await fails("flow", "add", "mine", "--workspace", directory, "--title", "T", "--reads", "src/checkout.ts", ...hops, "--force")).toContain("not written by pathlight flow");
    expect(await fails("flow", "remove", "mine", "--workspace", directory)).toContain("not written by pathlight flow");
    expect(await readFile(join(directory, "mine.behavior.c4"), "utf8")).toBe("// mine\n");

    expect(await cli("flow", "remove", "place-order", "--workspace", directory)).toContain("Removed place-order.behavior.c4");
    expect(existsSync(join(directory, "place-order.behavior.c4"))).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);

// A repository with several LikeC4 projects (this one has three): the root belongs to none, so the file goes in the folder of the project it is for.
test("with several projects the journey is written inside the chosen project's folder, found by flows and removable from the root", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-flow-projects-"));
  try {
    const keep = (path: string) => !path.includes(".cache");
    await cp("examples/parcel", join(directory, "apps/parcel"), { recursive: true, filter: keep });
    await cp("tests/fixtures/viewer", join(directory, "apps/viewer"), { recursive: true, filter: keep });
    await writeFile(join(directory, "checkout.ts"), "export const a = 1;\n");
    const git = (...args: string[]) => run("git", ["-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    await git("init", "-q"); await git("add", "-A"); await git("commit", "-q", "-m", "first");
    const add = ["flow", "add", "place-order", "--workspace", directory, "--title", "Placing an order", "--reads", "checkout.ts", "--step", "customer -> parcel.storefront: opens checkout", "--step", "parcel.storefront -> parcel.commerce.api: submits the cart"];
    expect(await fails(...add)).toContain("several LikeC4 projects");
    expect(await cli(...add, "--project", "parcel")).toContain("Wrote apps/parcel/place-order.behavior.c4");
    expect(existsSync(join(directory, "place-order.behavior.c4"))).toBe(false);
    const report = JSON.parse(await cli("flows", "--workspace", directory, "--json")) as { journeys: { id: string }[] };
    expect(report.journeys.map(journey => journey.id)).toEqual(["place-order"]);
    expect(await cli("flow", "remove", "place-order", "--workspace", directory)).toContain("Removed apps/parcel/place-order.behavior.c4");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 120_000);

// A journey is reached with F, so it must not count as a stray entry view in `pathlight check` (which `--strict` would fail on).
test("a journey is not reported by check as a view nothing links to", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-flow-check-"));
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true, filter: path => !path.includes(".cache") });
    await writeFile(join(directory, "pathlight.activity.json"), JSON.stringify({ version: 1, project: "viewer", mappings: [{ glob: "plugins/**", element: "plugin" }] }));
    await writeFile(join(directory, "a.ts"), "export const a = 1;\n");
    const unlinked = async () => (JSON.parse(await cli("check", "--workspace", directory, "--json")) as { summary: { unlinkedViews: number } }).summary.unlinkedViews;
    const before = await unlinked();
    await cli("flow", "add", "trip", "--workspace", directory, "--title", "A trip", "--reads", "a.ts", "--step", "plugin -> launcher: opens a view", "--step", "launcher -> viewer: starts the pane");
    expect(await unlinked()).toBe(before);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
