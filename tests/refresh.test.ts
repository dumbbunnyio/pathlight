import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Phase 6 step 2: `pathlight refresh`, what the end of a turn runs: one scan, the check, a drawn map's redraw when it is due, and the diff.
const cli = (directory: string, ...args: string[]) => {
  const done = Bun.spawnSync([process.execPath, resolve("src/cli.ts"), ...args, "--workspace", directory], { stdout: "pipe", stderr: "pipe" });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
};
const refresh = (directory: string) => JSON.parse(cli(directory, "refresh", "--json").out) as { redrew: boolean; added: { id: string; key: string }[]; blocked?: { element: string; journey: string }; due: string[] };
const model = (directory: string) => join(directory, ".pathlight/pathlight.model.c4");
const git = (directory: string, ...args: string[]) => Bun.spawnSync(["git", "-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);

/** A drawn shop: `api` calls `store`, three one-file folders in "small folders", a commit to diff against. */
const shop = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-refresh-"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "shop" }));
  for (const name of ["a", "b", "c"]) {
    await mkdir(join(directory, `src/api`), { recursive: true });
    await mkdir(join(directory, `src/store`), { recursive: true });
    await mkdir(join(directory, `src/${name}${name}`), { recursive: true });
    await writeFile(join(directory, `src/api/${name}.ts`), `import { save } from "../store/${name}";\nexport const h = () => save();\n`);
    await writeFile(join(directory, `src/store/${name}.ts`), "export const save = () => 1;\n");
    await writeFile(join(directory, `src/${name}${name}/index.ts`), "export const x = 1;\n");
  }
  git(directory, "init", "-q");
  expect(cli(directory, "draft").code).toBe(0);
  git(directory, "add", "-A"); git(directory, "commit", "-qm", "start");
  return directory;
};

test("a turn that adds nothing writes nothing; a new folder is drawn with its arrow; redraw off leaves the map as it is", async () => {
  const directory = await shop();
  try {
    const before = (await stat(model(directory))).mtimeMs;
    expect(refresh(directory)).toMatchObject({ redrew: false, added: [] });
    expect((await stat(model(directory))).mtimeMs).toBe(before);

    await mkdir(join(directory, "src/auth"));
    await writeFile(join(directory, "src/auth/guard.ts"), `import { save } from "../store/a";\nexport const guard = () => save();\n`);
    expect(refresh(directory)).toMatchObject({ redrew: true, added: [{ id: "small.auth", key: "src/auth" }] });
    expect(await readFile(model(directory), "utf8")).toMatch(/^\s*small\.auth -> store /m);
    expect(JSON.parse(await readFile(join(directory, ".cache/pathlight/stale.json"), "utf8")).unmapped).toBe(0);

    expect(cli(directory, "config", "set", "redraw", "off").code).toBe(0);
    expect(cli(directory, "config", "get", "redraw").out.trim()).toBe("off");
    await mkdir(join(directory, "src/billing"));
    await writeFile(join(directory, "src/billing/pay.ts"), "export const pay = 1;\n");
    const held = (await stat(model(directory))).mtimeMs;
    expect(refresh(directory).redrew).toBe(false);
    expect((await stat(model(directory))).mtimeMs).toBe(held);
    expect(JSON.parse(await readFile(join(directory, ".cache/pathlight/stale.json"), "utf8")).unmapped).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a draw that changes nothing still puts back a missing likec4.config.json, so the map can be read again", async () => {
  const directory = await shop();
  try {
    await rm(join(directory, ".pathlight/likec4.config.json"));
    expect(cli(directory, "check").code).not.toBe(0);
    expect(cli(directory, "draft").code).toBe(0);
    expect(cli(directory, "check").code).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a redraw that would remove an id a journey names is not written, and check says why", async () => {
  const directory = await shop();
  try {
    // `small.aa` exists while aa/ has one file; at three files it leaves "small folders" and its id becomes `aa`.
    await writeFile(join(directory, ".pathlight/trip.behavior.c4"), "views {\n  dynamic view trip {\n    title 'Trip'\n    api -> store 'saves'\n    small.aa -> api 'asks'\n  }\n}\n");
    expect(cli(directory, "check").code).toBe(0);
    const before = await readFile(model(directory), "utf8");
    await writeFile(join(directory, "src/aa/two.ts"), "export const y = 2;\n");
    await writeFile(join(directory, "src/aa/three.ts"), "export const z = 3;\n");
    // A grown folder is still claimed by its glob, so it alone is no reason to redraw; a new folder in the same turn is.
    expect(refresh(directory)).toMatchObject({ redrew: false, due: [] });
    await mkdir(join(directory, "src/zz"));
    await writeFile(join(directory, "src/zz/one.ts"), "export const one = 1;\n");
    expect(refresh(directory)).toMatchObject({ redrew: false, blocked: { element: "small.aa", journey: "trip" } });
    expect(await readFile(model(directory), "utf8")).toBe(before);
    expect(JSON.parse(cli(directory, "check", "--json").out).behind).toEqual({ element: "small.aa", journey: "trip" });
    // What check advises can be followed for a journey a person wrote: the file it names is the journey, and any command it names works.
    const advice = cli(directory, "check").out.split("\n").find(line => line.includes("small.aa") && line.includes("trip"))!;
    const named = advice.match(/\.pathlight\/\S+\.behavior\.c4/)?.[0];
    expect(await readFile(join(directory, named ?? "nothing named"), "utf8")).toContain("dynamic view trip");
    for (const [command] of advice.matchAll(/pathlight [a-z]+[^);]*/g)) expect(cli(directory, ...command.trim().split(" ").slice(1)).code).toBe(0);
    // plan --new would redraw too, so it is held back the same way and plans nothing.
    expect(cli(directory, "plan", "--new", "src/auth", "--title", "Auth").code).not.toBe(0);
    expect(await readFile(model(directory), "utf8")).toBe(before);
    // Once the journey no longer names it, check stops saying so at once, and the next turn redraws.
    await rm(join(directory, ".pathlight/trip.behavior.c4"));
    expect(JSON.parse(cli(directory, "check", "--json").out).behind).toBeUndefined();
    expect(refresh(directory)).toMatchObject({ redrew: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("with the last draw's keys gone (a fresh clone, a cleaned cache), a redraw still keeps journeys and announces no box", async () => {
  const directory = await shop();
  try {
    await writeFile(join(directory, ".pathlight/trip.behavior.c4"), "views {\n  dynamic view trip {\n    title 'Trip'\n    small.aa -> api 'asks'\n  }\n}\n");
    await rm(join(directory, ".cache"), { recursive: true, force: true });
    await writeFile(join(directory, "src/aa/two.ts"), "export const y = 2;\n");
    await writeFile(join(directory, "src/aa/three.ts"), "export const z = 3;\n");
    await mkdir(join(directory, "src/zz"));
    await writeFile(join(directory, "src/zz/one.ts"), "export const one = 1;\n");
    expect(refresh(directory)).toMatchObject({ redrew: false, blocked: { element: "small.aa", journey: "trip" } });
    expect(cli(directory, "check").code).toBe(0);
    await rm(join(directory, ".pathlight/trip.behavior.c4"));
    await rm(join(directory, ".cache"), { recursive: true, force: true });
    const done = refresh(directory) as ReturnType<typeof refresh> & { unnamed: string[] };
    expect(done).toMatchObject({ redrew: true, added: [], unnamed: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("the agent's plan follows a box whose id a redraw changed", async () => {
  const directory = await shop();
  try {
    expect(cli(directory, "plan", "small.bb", "api").code).toBe(0);
    await writeFile(join(directory, "src/bb/two.ts"), "export const y = 2;\n");
    await writeFile(join(directory, "src/bb/three.ts"), "export const z = 3;\n");
    await mkdir(join(directory, "src/zz"));
    await writeFile(join(directory, "src/zz/one.ts"), "export const one = 1;\n");
    expect(refresh(directory).redrew).toBe(true);
    expect(JSON.parse(await readFile(join(directory, ".cache/pathlight/plan.json"), "utf8")).elements).toEqual(["api", "bb"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a model a person wrote is never redrawn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-refresh-written-"));
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await mkdir(join(directory, "src/brand-new"), { recursive: true });
    await writeFile(join(directory, "src/brand-new/x.ts"), "export const x = 1;\n");
    const before = await readFile(join(directory, "model.c4"), "utf8");
    const done = refresh(directory);
    expect(done).toMatchObject({ redrew: false, due: [] });
    expect(await readFile(join(directory, "model.c4"), "utf8")).toBe(before);
    expect(await Bun.file(model(directory)).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

// Phase 7 step 4 (decision 8): a drawn map's frames follow the files that run things. A service a file adds or drops is reported and redrawn; any other
// change to the file (a comment) is nothing.
test("a service added to or gone from a compose file is reported and redrawn at the end of a turn; an edited comment is not", async () => {
  const directory = await shop();
  try {
    const compose = (services: string) => writeFile(join(directory, "docker-compose.yml"), `services:\n${services}`);
    const db = "  db:\n    image: postgres:16\n", cache = "  cache:\n    image: redis:7\n";
    const runs = async () => (JSON.parse(await readFile(join(directory, ".pathlight/pathlight.activity.json"), "utf8")) as { runs?: { target: string; name: string }[] }).runs?.map(item => `${item.target}#${item.name}`).sort() ?? [];
    const checked = () => JSON.parse(cli(directory, "check", "--json").out) as { runs: { gone: string[]; added: string[] }; summary: { whereItRuns: number } };
    await compose(db);
    expect(cli(directory, "draft").code).toBe(0);
    expect(await runs()).toEqual(["docker-compose.yml#db"]);
    // The briefing says where it runs, from the same frames.
    expect(cli(directory, "brief", "--first-day").out.split("\n").find(line => line.startsWith("Runs as:"))).toContain("docker-compose.yml");
    expect(checked().summary.whereItRuns).toBe(0);

    await compose(db + cache);
    expect(checked().runs.added).toEqual(["docker-compose.yml#cache"]);
    expect(refresh(directory).redrew).toBe(true);
    expect(await runs()).toEqual(["docker-compose.yml#cache", "docker-compose.yml#db"]);
    expect(checked().summary.whereItRuns).toBe(0);

    await writeFile(join(directory, "docker-compose.yml"), `# the shop's services\nservices:\n${db}${cache}`);
    expect(refresh(directory)).toMatchObject({ redrew: false, due: [] });

    await compose(cache);
    expect(checked().runs.gone).toEqual(["docker-compose.yml#db"]);
    expect(refresh(directory).redrew).toBe(true);
    expect(await runs()).toEqual(["docker-compose.yml#cache"]);

    // A model the person took over (the generated marker gone) is never redrawn, so a service named since is not reported against it.
    await writeFile(model(directory), (await readFile(model(directory), "utf8")).split("\n").slice(1).join("\n"));
    await compose(db + cache);
    expect(checked().runs.added).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);

// Backlog 11: a person's own model file beside a drawn map made every end of turn fail with draft's refusal (exit 1, nothing recorded, nothing shown).
test("a model file of a person's own beside a drawn map stops the redraw quietly, and check says why once", async () => {
  const directory = await shop();
  try {
    await writeFile(join(directory, ".pathlight/mine.c4"), "model {\n}\n");
    // A box left waiting by an earlier turn is not asked about either: naming it would redraw, which the map no longer does.
    await mkdir(join(directory, ".cache/pathlight"), { recursive: true });
    await writeFile(join(directory, ".cache/pathlight/refresh.json"), JSON.stringify({ version: 1, time: Date.now(), redrew: false, added: [], waiting: ["src/aa"] }));
    expect((JSON.parse(cli(directory, "refresh", "--json").out) as { request?: string }).request).toBeUndefined();
    await mkdir(join(directory, "src/auth"));
    await writeFile(join(directory, "src/auth/guard.ts"), "export const guard = 1;\n");
    const before = await readFile(model(directory), "utf8");
    expect(cli(directory, "refresh", "--quiet")).toMatchObject({ code: 0, out: "" });
    const hook = Bun.spawnSync([process.execPath, resolve("src/cli.ts"), "refresh", "--hook", "claude", "--workspace", directory], { stdin: new TextEncoder().encode("{}"), stdout: "pipe", stderr: "pipe" });
    expect([hook.exitCode, hook.stderr.toString()]).toEqual([0, ""]);
    expect(await readFile(model(directory), "utf8")).toBe(before);
    const report = cli(directory, "check").out;
    expect(report.split("\n").filter(line => line.includes(".pathlight/mine.c4"))).toHaveLength(1);
    expect((JSON.parse(cli(directory, "check", "--json").out) as { own: string[] }).own).toEqual([".pathlight/mine.c4"]);
    // Without the file the map is redrawn as before.
    await rm(join(directory, ".pathlight/mine.c4"));
    expect(refresh(directory).redrew).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
