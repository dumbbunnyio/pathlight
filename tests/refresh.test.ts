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
