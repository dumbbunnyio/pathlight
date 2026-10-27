import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { run } from "./effects";

// `npm i -g pathlight` as a user runs it, from packed tarballs into a private prefix, with a stand-in for the binary: the launcher must find the
// package for this platform, pass the arguments, the exit code and whose child it is (so `open` typed at a prompt still takes over the pane).
test.skipIf(!Bun.which("npm"))("the npm launcher runs the binary of this platform's package, and says what to do when none was installed", async () => {
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
    expect(manifest).toMatchObject({ name: "pathlight", version: "9.9.9", license: "MIT", bin: { pathlight: "launcher.cjs" },
      optionalDependencies: { [`pathlight-${here}`]: "9.9.9", [`pathlight-${other}`]: "9.9.9" } });
    expect(JSON.parse(await readFile(join(dist, `pathlight-${other}`, "package.json"), "utf8"))).toMatchObject({ os: [other.split("-")[0]], cpu: [other.split("-")[1]] });

    const packs = join(work, "packs");
    await mkdir(packs);
    for (const name of [`pathlight-${here}`, "pathlight"]) await run("sh", ["-c", `cd "${join(dist, name)}" && npm pack --silent --pack-destination "${packs}"`]);
    expect((await readdir(packs)).sort()).toEqual(["pathlight-9.9.9.tgz", `pathlight-${here}-9.9.9.tgz`]);

    // Without the platform package the launcher says so rather than failing obscurely.
    const bare = join(work, "bare");
    await run("npm", ["install", "-g", "--prefix", bare, "--no-optional", "--no-audit", "--no-fund", join(packs, "pathlight-9.9.9.tgz")]);
    const missing = Bun.spawn([join(bare, "bin", "pathlight"), "--help"], { stderr: "pipe" });
    expect(await missing.exited).toBe(1);
    expect(await new Response(missing.stderr).text()).toContain(`no build for ${here}`);

    const prefix = join(work, "prefix");
    await run("npm", ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", join(packs, `pathlight-${here}-9.9.9.tgz`), join(packs, "pathlight-9.9.9.tgz")]);
    // Not the last command, so the shell stays the launcher's parent as at a prompt (sh -c would otherwise exec it in its own place).
    const child = Bun.spawn(["sh", "-c", `echo "shell:$$"; "$0" open "two words"; exit $?`, join(prefix, "bin", "pathlight")], { stdout: "pipe" });
    const [out, code] = [await new Response(child.stdout).text(), await child.exited];
    expect(code).toBe(3);
    const shell = /shell:(\d+)/.exec(out)![1];
    expect(out).toContain("args:open two words");
    expect(out).toContain(`parent:${shell}`);
  } finally { await rm(work, { recursive: true, force: true }); }
}, 120_000);
