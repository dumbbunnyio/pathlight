import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** `pathlight config`: where the Claude Code plugin's /pathlight:open draws the viewer, kept beside the theme in Pathlight's own settings file. */
const config = async (home: string, ...args: string[]) => {
  const child = Bun.spawn([process.execPath, resolve("src/cli.ts"), "config", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, XDG_CONFIG_HOME: home } });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
};

test("config get claude prints nothing until set, set keeps the theme and any other key, and nonsense is refused", async () => {
  const home = await mkdtemp(join(tmpdir(), "pathlight-config-"));
  try {
    expect(await config(home, "get", "claude")).toMatchObject({ out: "", code: 0 });
    await mkdir(join(home, "pathlight"));
    await writeFile(join(home, "pathlight", "config.json"), JSON.stringify({ theme: "nord", later: 1 }));
    expect((await config(home, "set", "claude", "tmux")).code).toBe(0);
    expect(await config(home, "get", "claude")).toMatchObject({ out: "tmux\n", code: 0 });
    expect(JSON.parse(await readFile(join(home, "pathlight", "config.json"), "utf8"))).toEqual({ theme: "nord", later: 1, claude: "tmux" });
    expect((await config(home, "set", "claude", "pane")).code).toBe(0);
    expect((await config(home, "get", "claude")).out).toBe("pane\n");
    expect((await config(home, "set", "claude", "web")).code).toBe(0);
    expect((await config(home, "get", "claude")).out).toBe("web\n");
    expect((await config(home, "set", "claude", "pane")).code).toBe(0);
    // The browser is any command; an empty one goes back to the first browser found.
    expect(await config(home, "get", "browser")).toMatchObject({ out: "", code: 0 });
    expect((await config(home, "set", "browser", "sh")).out).toContain("in a tab");
    expect((await config(home, "get", "browser")).out).toBe("sh\n");
    expect((await config(home, "set", "browser", "no-such-browser-here")).out).toContain("was not found");
    expect((await config(home, "set", "browser", "")).code).toBe(0);
    expect((await config(home, "get", "browser")).out).toBe("");
    expect(JSON.parse(await readFile(join(home, "pathlight", "config.json"), "utf8"))).toEqual({ theme: "nord", later: 1, claude: "pane" });
    for (const args of [["set", "claude", "browser"], ["get", "theme"], ["set", "claude"], ["drop", "claude"], ["set", "browser"]]) expect((await config(home, ...args)).code).not.toBe(0);
    // A value it does not understand reads as unset.
    await writeFile(join(home, "pathlight", "config.json"), JSON.stringify({ theme: "nord", claude: "both" }));
    expect((await config(home, "get", "claude")).out).toBe("");
  } finally { await rm(home, { recursive: true, force: true }); }
}, 30_000);
