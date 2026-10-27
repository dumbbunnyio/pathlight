import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { run } from "./effects";

// `npm i -g @dumbbunnyio/pathlight` (and `npm i -g pathlight`, which points at it) as a user runs it, from packed tarballs into a private prefix, with a
// stand-in for the binary: the launcher must find the package for this platform, pass the arguments, the exit code and whose child it is (so `open`
// typed at a prompt still takes over the pane).
test.skipIf(!Bun.which("npm"))("the npm launcher runs the binary of this platform's package, the unscoped name runs the same, and a missing build says what to do", async () => {
  const work = await mkdtemp(join(tmpdir(), "pathlight-npm-"));
  const here = `${process.platform}-${process.arch}`;
  const other = here === "darwin-arm64" ? "linux-x64" : "darwin-arm64";
  try {
    const binaries = join(work, "binaries");
    await mkdir(binaries);
    for (const platform of [here, other]) {
      await writeFile(join(binaries, `pathlight-${platform}`), `#!/bin/sh\necho "args:$*"\necho "parent:$PATHLIGHT_LAUNCHER_PPID"\nexit 3\n`);
      await chmod(join(binaries, `pathlight-${platform}`), 0o755);
    }
    await run("sh", [resolve("scripts/build-npm.sh"), "9.9.9", binaries]);
    const dist = resolve("dist/npm");
    const manifest = JSON.parse(await readFile(join(dist, "pathlight", "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({ name: "@dumbbunnyio/pathlight", version: "9.9.9", license: "MIT", bin: { pathlight: "launcher.cjs" },
      optionalDependencies: { [`@dumbbunnyio/pathlight-${here}`]: "9.9.9", [`@dumbbunnyio/pathlight-${other}`]: "9.9.9" } });
    expect(JSON.parse(await readFile(join(dist, other, "package.json"), "utf8"))).toMatchObject({ name: `@dumbbunnyio/pathlight-${other}`, os: [other.split("-")[0]], cpu: [other.split("-")[1]] });
    expect(JSON.parse(await readFile(join(dist, "pointer", "package.json"), "utf8"))).toMatchObject({ name: "pathlight", dependencies: { "@dumbbunnyio/pathlight": "9.9.9" } });

    const packs = join(work, "packs");
    await mkdir(packs);
    for (const folder of [here, "pathlight", "pointer"]) await run("sh", ["-c", `cd "${join(dist, folder)}" && npm pack --silent --pack-destination "${packs}"`]);
    expect((await readdir(packs)).sort()).toEqual(["dumbbunnyio-pathlight-9.9.9.tgz", `dumbbunnyio-pathlight-${here}-9.9.9.tgz`, "pathlight-9.9.9.tgz"]);
    const platformPack = join(packs, `dumbbunnyio-pathlight-${here}-9.9.9.tgz`), mainPack = join(packs, "dumbbunnyio-pathlight-9.9.9.tgz");
    const install = (prefix: string, ...args: string[]) => run("npm", ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", ...args]);

    // Without the platform package the launcher says so rather than failing obscurely.
    const bare = join(work, "bare");
    await install(bare, "--no-optional", mainPack);
    const missing = Bun.spawn([join(bare, "bin", "pathlight"), "--help"], { stderr: "pipe" });
    expect(await missing.exited).toBe(1);
    expect(await new Response(missing.stderr).text()).toContain(`no build for ${here}`);

    // Not the last command, so the shell stays the launcher's parent as at a prompt (sh -c would otherwise exec it in its own place).
    const runs = async (bin: string) => {
      const child = Bun.spawn(["sh", "-c", `echo "shell:$$"; "$0" open "two words"; exit $?`, bin], { stdout: "pipe" });
      const [out, code] = [await new Response(child.stdout).text(), await child.exited];
      expect(code).toBe(3);
      expect(out).toContain("args:open two words");
      expect(out).toContain(`parent:${/shell:(\d+)/.exec(out)![1]}`);
    };
    const prefix = join(work, "prefix");
    await install(prefix, platformPack, mainPack);
    await runs(join(prefix, "bin", "pathlight"));

    // The unscoped name depends on the scoped package and runs its launcher in-process. Installed into a project (a global install would fetch the
    // dependency from the registry), the local tarballs satisfy that dependency.
    const pointed = join(work, "pointed");
    await mkdir(pointed);
    await run("npm", ["install", "--prefix", pointed, "--no-audit", "--no-fund", platformPack, mainPack, join(packs, "pathlight-9.9.9.tgz")]);
    await writeFile(join(work, "pointer"), `#!/bin/sh\nexec node "${join(pointed, "node_modules", "pathlight", "pointer.cjs")}" "$@"\n`);
    await chmod(join(work, "pointer"), 0o755);
    await runs(join(work, "pointer"));
  } finally { await rm(work, { recursive: true, force: true }); }
}, 180_000);
