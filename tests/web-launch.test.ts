import { expect, test } from "bun:test";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addressOf, browserArgs, recordPath } from "../src/web/launch";

// The launch (plan 4d, step 2) through the real CLI: `pathlight web --open` starts the workspace's server in the background, records it, and opens
// one window; a second open brings that window forward at the view asked for instead of opening another; the server stops once its last window
// closes and removes its record. The browser is a stand-in that holds the page's event stream open the way a window does, so no real window opens.

const cli = resolve("src/cli.ts");

/** A stand-in Chromium: records its arguments, then reads the page's frames from --app's address until it is killed. */
const fakeBrowser = (directory: string) => `#!/bin/sh
printf '%s\\n' "$@" >> "${directory}/browser-args"
exec "${process.execPath}" "${directory}/window.ts" "$@"
`;
const fakeWindow = (directory: string) => `
const app = process.argv.find(arg => arg.startsWith("--app="))!.slice(6);
const address = new URL(app);
const events = new URL("/api/events", address);
events.searchParams.set("t", address.searchParams.get("t")!);
events.searchParams.set("cols", "140"); events.searchParams.set("rows", "40");
for (const key of ["view", "select"]) { const value = address.searchParams.get(key); if (value) events.searchParams.set(key, value); }
await Bun.write("${directory}/window.pid", String(process.pid));
const response = await fetch(events);
const reader = response.body!.getReader();
const decoder = new TextDecoder();
const { appendFileSync } = await import("node:fs");
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  appendFileSync("${directory}/frames", decoder.decode(value));
}
`;

const until = async <T>(what: string, check: () => Promise<T | undefined>, ms = 15_000) => {
  for (let waited = 0; waited < ms; waited += 100) { const value = await check(); if (value !== undefined) return value; await Bun.sleep(100); }
  throw new Error(`Timed out waiting for ${what}`);
};
const text = (path: string) => readFile(path, "utf8").catch(() => "");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("web --open starts one server and one window per workspace, raises it on a second open, and the server stops when the window closes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-launch-"));
  const workspace = join(directory, "parcel");
  let serverPid = 0, windowPid = 0;
  try {
    await cp(resolve("examples/parcel"), workspace, { recursive: true });
    await writeFile(join(directory, "fake-chromium"), fakeBrowser(directory));
    await chmod(join(directory, "fake-chromium"), 0o755);
    await writeFile(join(directory, "window.ts"), fakeWindow(directory));
    const env = { ...process.env, XDG_CONFIG_HOME: join(directory, "config"), XDG_CACHE_HOME: join(directory, "cache"), PATHLIGHT_THEME: "pathlight" };
    const pathlight = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, cli, ...args], { cwd: workspace, env, stdout: "pipe", stderr: "pipe" });
      return { out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text(), code: await child.exited };
    };
    expect((await pathlight("config", "set", "browser", join(directory, "fake-chromium"))).code).toBe(0);

    const first = await pathlight("web", "services", "--open", "--workspace", ".", "--select", "parcel.commerce.api");
    expect(first).toMatchObject({ code: 0, out: "Opened the map in fake-chromium.\n" });
    const record = JSON.parse(await text(recordPath(workspace))) as { pid: number; port: number; url: string; project: string };
    serverPid = record.pid;
    expect(record.project).toBe("parcel");
    expect(alive(serverPid)).toBe(true);
    // One window, in Pathlight's own profile, as an app window at the view and selection asked for.
    const args = (await text(join(directory, "browser-args"))).trim().split("\n");
    expect(args).toContain(`--user-data-dir=${join(directory, "cache", "pathlight", "browser")}`);
    expect(args.find(arg => arg.startsWith("--app="))).toBe(`--app=${addressOf(record.url, "services", "parcel.commerce.api")}`);
    windowPid = Number(await until("the window", async () => (await text(join(directory, "window.pid"))) || undefined));
    await until("the first frame", async () => (await text(join(directory, "frames"))).includes("\"selected\":\"parcel.commerce.api\"") || undefined);

    // A second open of the same workspace raises that window at the new view; no second window, no second server.
    const second = await pathlight("web", "checkout", "--open", "--workspace", ".");
    expect(second).toMatchObject({ code: 0, out: "The map is already open in its window; it now shows checkout.\n" });
    expect((await text(join(directory, "browser-args"))).trim().split("\n").filter(arg => arg.startsWith("--app="))).toHaveLength(1);
    expect(JSON.parse(await text(recordPath(workspace))).pid).toBe(serverPid);
    await until("the raised frame", async () => {
      const frames = (await text(join(directory, "frames"))).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
      return frames.some(frame => frame.raise === true && frame.frame.view === "checkout") || undefined;
    });

    // Closing the window stops the server a few seconds later, and its record goes with it.
    process.kill(windowPid, "SIGTERM");
    await until("the server to stop", async () => alive(serverPid) ? undefined : true, 15_000);
    expect(await text(recordPath(workspace))).toBe("");
    serverPid = 0;
  } finally {
    for (const pid of [windowPid, serverPid]) if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a Chromium-family browser gets its own profile and an app window; any other gets the address", () => {
  const url = "http://127.0.0.1:1/?t=x";
  expect(browserArgs({ name: "Brave", command: ["/usr/bin/brave-browser"], app: true }, url, "/p")).toEqual(["--user-data-dir=/p", `--app=${url}`, "--no-first-run", "--no-default-browser-check"]);
  expect(browserArgs({ name: "firefox", command: ["/usr/bin/firefox", "--new-window"], app: false }, url, "/p")).toEqual(["--new-window", url]);
  expect(addressOf(url, "services", "a.b")).toBe("http://127.0.0.1:1/?t=x&view=services&select=a.b");
});
