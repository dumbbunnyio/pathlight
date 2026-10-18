import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { run } from "./effects";

test("show forwards editor configuration and shutdown stops a non-exec editor wrapper's process group", async () => {
  const directory = await mkdtemp(join(tmpdir(), "c4view-editor-stop-"));
  const socket = join(directory, "tmux.sock");
  const wrapper = join(directory, "editor.sh");
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("examples/viewer", directory, { recursive: true });
    await writeFile(join(directory, "code.txt"), "example\n");
    await writeFile(join(directory, "c4view.activity.json"), JSON.stringify({ version: 1, project: "viewer",
      mappings: [{ glob: "code.txt", element: "plugin" }] }));
    await writeFile(wrapper, `printf '%s' "$$" > "$0.group"
trap '' TERM
sh -c 'trap "" TERM; printf "%s" "$$" > "$1"; printf "\\033[2J\\033[HWRAPPER EDITOR READY"; while :; do sleep 1; done' sh "$0.pid" &
wait
`);
    const parent = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "editor-stop", "-x", "160", "-y", "36",
      "-P", "-F", "#{pane_id}", "sleep", "120");
    const child = Bun.spawn([process.execPath, resolve("src/cli.ts"), "show", "live", "--project", "viewer",
      "--workspace", directory, "--pane", parent, "--socket", socket], {
      env: { ...process.env, VISUAL: `sh '${wrapper.replaceAll("'", "'\\''")}'`, EDITOR: "nonexistent-editor" }, stdout: "pipe", stderr: "pipe",
    });
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(error).toBe(""); expect(code).toBe(0);
    const { pane } = z.object({ pane: z.string() }).parse(JSON.parse(output));
    await tmux("set-option", "-p", "-t", pane, "remain-on-exit", "on");
    await tmux("send-keys", "-t", pane, "e");
    await delay(100);
    await tmux("send-keys", "-t", pane, "Enter");
    let screen = "";
    for (let i = 0; i < 100; i++) {
      screen = await tmux("capture-pane", "-p", "-t", pane);
      if (screen.includes("WRAPPER EDITOR READY")) break;
      await delay(50);
    }
    expect(screen).toContain("WRAPPER EDITOR READY");
    const editorPid = Number(await readFile(`${wrapper}.pid`, "utf8"));
    const viewerPid = Number(await tmux("display-message", "-p", "-t", pane, "#{pane_pid}"));
    process.kill(viewerPid, "SIGTERM");
    let dead = "";
    for (let i = 0; i < 100; i++) {
      dead = await tmux("display-message", "-p", "-t", pane, "#{pane_dead}");
      if (dead === "1") break;
      await delay(50);
    }
    expect(dead).toBe("1");
    const status = await readFile(`/proc/${editorPid}/stat`, "utf8").catch(error => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    });
    expect(status === "" || status.slice(status.lastIndexOf(")") + 2).startsWith("Z ")).toBe(true);
    expect(await tmux("display-message", "-p", "-t", parent, "#{pane_current_command}")).toBe("sleep");
  } finally {
    const group = Number(await readFile(`${wrapper}.group`, "utf8").catch(() => ""));
    if (group > 0) { try { process.kill(-group, "SIGKILL"); } catch {} }
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
