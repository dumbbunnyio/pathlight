import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { applyOverlay, builtOverlay, draftOf, type Overlay } from "../src/draft";

// Phase 6 step 1: a box for a folder that does not exist yet, on a map Pathlight drew (`pathlight plan --new`).
const cli = (directory: string, ...args: string[]) => {
  const done = Bun.spawnSync([process.execPath, resolve("src/cli.ts"), ...args, "--workspace", directory], { stdout: "pipe", stderr: "pipe" });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
};
const see = (directory: string) => cli(directory, "see", "index", "--cols", "120", "--rows", "30").out;
const scanOf = (paths: readonly string[]) => ({ files: paths.map(path => ({ path, language: "typescript" as const, lines: 1 })), imports: [] });

test("a planned folder is its own box where the folder will sit, and keeps its id and name once it has a file", () => {
  // Three one-file folders make the "small folders" collection; a planned folder of one file would join it if it were not declared.
  const code = ["src/a/a.ts", "src/b/b.ts", "src/c/c.ts", "src/big/x.ts", "src/big/y.ts", "src/big/z.ts"];
  const overlay: Overlay = { version: 1, elements: {}, planned: [{ path: "src/auth", title: "Auth middleware", by: "agent" }] };
  const planned = applyOverlay(draftOf(scanOf(code), [{ directory: "", name: "shop" }], overlay), overlay).draft;
  const box = planned.packages[0]!.components.find(entry => entry.key === "src/auth")!;
  expect(box).toMatchObject({ id: "auth", title: "Auth middleware", planned: true, files: [], globs: ["src/auth/**"] });
  expect(box.group).toBeUndefined();
  expect(planned.packages[0]!.components.find(entry => entry.key === "src/a")!.group).toBe("small");

  const built = builtOverlay(overlay, overlay.planned!);
  expect(built.planned).toBeUndefined();
  expect(built.elements["src/auth"]).toMatchObject({ title: "Auth middleware", by: "agent" });
  const after = applyOverlay(draftOf(scanOf([...code, "src/auth/guard.ts"]), [{ directory: "", name: "shop" }], built), built).draft;
  const solid = after.packages[0]!.components.find(entry => entry.key === "src/auth")!;
  expect(solid).toMatchObject({ id: "auth", title: "Auth middleware", files: ["src/auth/guard.ts"] });
  expect(solid.planned).toBeUndefined();
  expect(solid.group).toBeUndefined();
});

test("a name a person already gave the folder is kept when the planned box is built", () => {
  const overlay: Overlay = { version: 1, elements: { "src/auth": { title: "Gatekeeper", by: "human" } }, planned: [{ path: "src/auth", title: "Auth middleware", by: "agent" }] };
  expect(builtOverlay(overlay, overlay.planned!).elements["src/auth"]).toEqual({ title: "Gatekeeper", by: "human" });
});

test("plan --new draws a dashed named box before any file exists; once its files exist a redraw makes it solid with its arrows and name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-plan-new-"));
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "shop" }));
    await mkdir(join(directory, "src/api"), { recursive: true });
    await mkdir(join(directory, "src/store"), { recursive: true });
    for (const name of ["a", "b", "c"]) {
      await writeFile(join(directory, `src/api/${name}.ts`), `import { save } from "../store/${name}";\nexport const h = () => save();\n`);
      await writeFile(join(directory, `src/store/${name}.ts`), "export const save = () => 1;\n");
    }
    expect(cli(directory, "draft").code).toBe(0);

    const planned = cli(directory, "plan", "--new", "src/auth", "--title", "Auth middleware", "--note", "Checks the session first.");
    expect(planned.code).toBe(0);
    expect(JSON.parse(await readFile(join(directory, ".cache/pathlight/plan.json"), "utf8")).elements).toEqual(["auth"]);
    const mapping = JSON.parse(await readFile(join(directory, ".pathlight/pathlight.activity.json"), "utf8"));
    expect(mapping.planned).toEqual(["auth"]);
    expect(mapping.mappings).toContainEqual({ glob: "src/auth/**", element: "auth" });
    const before = see(directory);
    expect(before).toContain("[planned]");
    expect(before).toContain("Auth middleware");
    expect(before).toContain("┄");

    await mkdir(join(directory, "src/auth"));
    await writeFile(join(directory, "src/auth/guard.ts"), `import { save } from "../store/a";\nexport const guard = () => save();\n`);
    expect(cli(directory, "draft").code).toBe(0);
    const model = await readFile(join(directory, ".pathlight/pathlight.model.c4"), "utf8");
    expect(model).toMatch(/^\s*auth -> store /m);
    const remapped = JSON.parse(await readFile(join(directory, ".pathlight/pathlight.activity.json"), "utf8"));
    expect(remapped.planned).toBeUndefined();
    const overlay = JSON.parse(await readFile(join(directory, ".pathlight/pathlight.overlay.json"), "utf8"));
    expect(overlay.planned).toBeUndefined();
    expect(overlay.elements["src/auth"].title).toBe("Auth middleware");
    expect(overlay.standalone).toEqual([{ key: "src/auth", by: "agent" }]);
    const after = see(directory);
    expect(after).toContain("Auth middleware");
    expect(after).not.toContain("[planned]");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("plan --new changes nothing on a map a person wrote, inside another box, or over a folder that has files", async () => {
  const written = await mkdtemp(join(tmpdir(), "pathlight-plan-new-written-"));
  const drawn = await mkdtemp(join(tmpdir(), "pathlight-plan-new-drawn-"));
  try {
    await cp("tests/fixtures/viewer", written, { recursive: true });
    const refused = cli(written, "plan", "--new", "src/auth", "--title", "Auth");
    expect(refused.code).not.toBe(0);
    expect(await Bun.file(join(written, ".pathlight/pathlight.overlay.json")).exists()).toBe(false);

    await writeFile(join(drawn, "package.json"), JSON.stringify({ name: "shop" }));
    await mkdir(join(drawn, "src/api"), { recursive: true });
    for (const name of ["a", "b", "c"]) await writeFile(join(drawn, `src/api/${name}.ts`), "export const x = 1;\n");
    await writeFile(join(drawn, "src/main.ts"), "export const m = 1;\n");
    expect(cli(drawn, "draft").code).toBe(0);
    const model = await readFile(join(drawn, ".pathlight/pathlight.model.c4"), "utf8");
    expect(cli(drawn, "plan", "--new", "src/api/deep", "--title", "Deep").code).not.toBe(0);
    expect(cli(drawn, "plan", "--new", "src/api", "--title", "Api").code).not.toBe(0);
    expect(cli(drawn, "plan", "--new", "../outside", "--title", "Out").code).not.toBe(0);
    expect(await readFile(join(drawn, ".pathlight/pathlight.model.c4"), "utf8")).toBe(model);
    const overlay = await Bun.file(join(drawn, ".pathlight/pathlight.overlay.json")).json().catch(() => ({}));
    expect(overlay.planned ?? []).toEqual([]);
  } finally {
    await rm(written, { recursive: true, force: true });
    await rm(drawn, { recursive: true, force: true });
  }
}, 60_000);
