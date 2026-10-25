import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { run } from "./effects";
import { observeOpenCode } from "./opencode-observe";

// The npm package, packed and unpacked somewhere with no checkout beside it: it must load in the real OpenCode with its skills and tracer agent, and name nothing
// of the repository. (A real registry install is the one thing this cannot show; OpenCode loads a folder and an npm name through the same loader.)
test.skipIf(!Bun.which("opencode"))("the packed OpenCode plugin loads on its own, with the skills and the tracer agent, and carries no path from the repository", async () => {
  const work = await mkdtemp(join(tmpdir(), "pathlight-opencode-pack-"));
  try {
    await run("sh", [resolve("scripts/build-opencode.sh"), "9.9.9"]);
    const dist = resolve("plugins/opencode/dist");
    await run("sh", ["-c", `cd "${dist}" && bun pm pack --destination "${work}"`]);
    const tarball = (await readdir(work)).find(name => name.endsWith(".tgz"))!;
    expect(tarball).toBe("pathlight-opencode-9.9.9.tgz");
    await run("tar", ["-xzf", join(work, tarball), "-C", work]);
    const unpacked = join(work, "package");
    expect((await readdir(unpacked)).sort()).toEqual(["README.md", "index.js", "package.json", "skills", "tui.js"]);
    const manifest = JSON.parse(await readFile(join(unpacked, "package.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({ name: "pathlight-opencode", version: "9.9.9", exports: { ".": "./index.js", "./tui": "./tui.js" }, peerDependencies: { effect: "^4.0.0" } });
    expect(manifest.license).toBeUndefined();
    const code = await readFile(join(unpacked, "index.js"), "utf8") + await readFile(join(unpacked, "tui.js"), "utf8");
    expect(code).not.toContain(resolve("."));
    expect(code).not.toMatch(/src\/cli\.ts/);
    expect(code).not.toContain('"bun", [cli');

    const observed = await observeOpenCode(unpacked, ["ANTHROPIC_API_KEY=placeholder"]);
    expect(observed.skills).toEqual(expect.arrayContaining(["pathlight", "pathlight-behavior"]));
    expect(observed.agent).toMatchObject({ mode: "subagent", model: { providerID: "anthropic" } });
    expect(observed.agent!.system).toContain("pathlight flow add");
  } finally { await rm(work, { recursive: true, force: true }); }
}, 180_000);
