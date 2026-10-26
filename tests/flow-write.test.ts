import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseStep, renderJourney } from "../src/flow-write";
import { run, mappingIn } from "./effects";

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

test("a step may name the function it calls: `from -> to: event @ file#name`", () => {
  expect(parseStep("a -> b: submits the cart @ src/api.ts#submitCart")).toEqual({ from: "a", to: "b", title: "submits the cart", call: { file: "src/api.ts", name: "submitCart" } });
  expect(parseStep("a -> b: mail me @ home")).toEqual({ from: "a", to: "b", title: "mail me @ home" });
  expect(typeof parseStep("a -> b: @ src/x.ts#y")).toBe("string");
  const text = renderJourney({ id: "p", title: "t", reads: ["src/api.ts"], sha: undefined, steps: [{ from: "a", to: "b", title: "go", declared: { file: "src/api.ts", name: "f", declaration: "export function f(a: A | B): void" } }] });
  expect(text).toContain("notes 'f | src/api.ts | export function f(a: A | B): void'");
});

test("flow add keeps a called function only if the file exports it, shows it in flows, and flows says when it changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-flow-call-"));
  try {
    await cp("examples/parcel", directory, { recursive: true, filter: path => !path.includes(".cache") });
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "src/checkout.ts"), "export async function submitCart(cart: Cart, user: User): Promise<Order> {\n  return order;\n}\nconst hidden = 1;\n");
    const git = (...args: string[]) => run("git", ["-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    await git("init", "-q"); await git("add", "-A"); await git("commit", "-q", "-m", "first");
    const base = ["flow", "add", "place-order", "--workspace", directory, "--title", "Placing an order", "--reads", "src/checkout.ts"];
    const first = "customer -> parcel.storefront: opens checkout";
    const second = (call: string) => `parcel.storefront -> parcel.commerce.api: submits the cart${call}`;
    expect(await fails(...base, "--step", first, "--step", second(" @ src/checkout.ts#hidden"))).toContain("does not export “hidden”");
    expect(await fails(...base, "--step", first, "--step", second(" @ src/missing.ts#x"))).toContain("name the file in --reads");
    expect(await fails("flow", "add", "place-order", "--workspace", directory, "--title", "T", "--reads", "src/checkout.ts", "--step", first, "--step", second(" @ package.json#x"))).toContain("name the file in --reads");
    expect(existsSync(join(directory, "place-order.behavior.c4"))).toBe(false);

    await cli(...base, "--step", first, "--step", second(" @ src/checkout.ts#submitCart"));
    const written = await readFile(join(directory, "place-order.behavior.c4"), "utf8");
    expect(written).toContain("notes 'submitCart | src/checkout.ts | export async function submitCart(cart: Cart, user: User): Promise<Order>'");
    const { checkFlows } = await import("../src/flows");
    const { Effect } = await import("effect");
    const read = async () => (await Effect.runPromise(checkFlows(directory))).journeys[0]!;
    expect((await read()).steps[1]!.call).toEqual({ name: "submitCart", file: "src/checkout.ts", declaration: "export async function submitCart(cart: Cart, user: User): Promise<Order>" });
    expect((await read()).findings).toEqual([]);
    await writeFile(join(directory, "src/checkout.ts"), "export async function submitCart(cart: Cart): Promise<Order> {\n  return order;\n}\n");
    expect((await read()).findings.join("\n")).toContain("Step 2: submitCart in src/checkout.ts is declared differently");
    await writeFile(join(directory, "src/checkout.ts"), "export const other = 1;\n");
    expect((await read()).findings.join("\n")).toContain("which no longer declares it");
  } finally { await rm(directory, { recursive: true, force: true }); }
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
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer", mappings: [{ glob: "plugins/**", element: "plugin" }] }));
    await writeFile(join(directory, "a.ts"), "export const a = 1;\n");
    const unlinked = async () => (JSON.parse(await cli("check", "--workspace", directory, "--json")) as { summary: { unlinkedViews: number } }).summary.unlinkedViews;
    const before = await unlinked();
    await cli("flow", "add", "trip", "--workspace", directory, "--title", "A trip", "--reads", "a.ts", "--step", "plugin -> launcher: opens a view", "--step", "launcher -> viewer: starts the pane");
    expect(await unlinked()).toBe(before);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test("a flow written from uncommitted files is not behind until one of them changes again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-flow-dirty-"));
  try {
    await cp("examples/parcel", directory, { recursive: true, filter: path => !path.includes(".cache") });
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(join(directory, "src/checkout.ts"), "export const a = 1;\n");
    await mappingIn(directory) && await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "parcel", mappings: [{ glob: "src/checkout.ts", element: "parcel.storefront" }] }));
    const git = (...args: string[]) => run("git", ["-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    await git("init", "-q"); await git("add", "-A"); await git("commit", "-q", "-m", "first");
    // The agent reads the working tree, which already differs from HEAD.
    await writeFile(join(directory, "src/checkout.ts"), "export const a = 2;\n");
    await cli("flow", "add", "place-order", "--workspace", directory, "--title", "Placing an order", "--reads", "src/checkout.ts",
      "--step", "customer -> parcel.storefront: opens checkout", "--step", "parcel.storefront -> parcel.commerce.api: submits the cart");
    expect(await readFile(join(directory, "place-order.behavior.c4"), "utf8")).toMatch(/Read with uncommitted changes: src\/checkout\.ts@[0-9a-f]{8}\./);
    const { checkFlows } = await import("../src/flows");
    const { Effect } = await import("effect");
    const read = async () => (await Effect.runPromise(checkFlows(directory))).journeys[0]!;
    expect((await read()).sync.status).toBe("current");
    expect((await read()).findings).toEqual([]);
    await writeFile(join(directory, "src/checkout.ts"), "export const a = 3;\n");
    expect((await read()).sync.status).toBe("behind");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

test("a workspace inside a larger repository still sees uncommitted and later changes to the files a flow read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-flow-nested-"));
  const workspace = join(directory, "apps/shop");
  try {
    await cp("examples/parcel", workspace, { recursive: true, filter: path => !path.includes(".cache") });
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src/checkout.ts"), "export const a = 1;\n");
    await writeFile(mappingIn(workspace), JSON.stringify({ version: 1, project: "parcel", mappings: [{ glob: "src/checkout.ts", element: "parcel.storefront" }] }));
    // git paths are printed from the repository's top, not from the workspace.
    const git = (...args: string[]) => run("git", ["-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    await git("init", "-q"); await git("add", "-A"); await git("commit", "-q", "-m", "first");
    await writeFile(join(workspace, "src/checkout.ts"), "export const a = 2;\n");
    await cli("flow", "add", "place-order", "--workspace", workspace, "--title", "Placing an order", "--reads", "src/checkout.ts",
      "--step", "customer -> parcel.storefront: opens checkout", "--step", "parcel.storefront -> parcel.commerce.api: submits the cart");
    expect(await readFile(join(workspace, "place-order.behavior.c4"), "utf8")).toMatch(/Read with uncommitted changes: src\/checkout\.ts@[0-9a-f]{8}\./);
    const { checkFlows } = await import("../src/flows");
    const { Effect } = await import("effect");
    const read = async () => (await Effect.runPromise(checkFlows(workspace))).journeys[0]!;
    expect((await read()).sync.status).toBe("current");
    await writeFile(join(workspace, "src/checkout.ts"), "export const a = 3;\n");
    expect((await read()).sync.status).toBe("behind");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
