import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Effect } from "effect";
import type { ActivityBinding } from "../activity";
import { failure, hasCode, io } from "../effects";
import { savedBrowser } from "../theme";

/**
 * Opening the browser page (plan 4d, step 2): one window per workspace, in a browser window of its own, served by a `pathlight web` that runs in
 * the background and stops when its last window closes. Two halves, kept apart so another host (a VS Code webview) can take the first alone:
 * `ensureServer` starts the workspace's server or finds the one running and returns its address; `openWindow` shows that address in a browser.
 *
 * The running server is recorded in the workspace's `.cache/pathlight/web.json` (ignored, regenerated state): its process, port and token. A
 * second open finds it there and asks it to bring its window forward at the view asked for, instead of opening another window.
 */

/** What a running server records about itself. The token is the address's: the file is the person's own, readable by them only. */
export interface WebRecord { pid: number; port: number; token: string; url: string; project: string }

export const recordPath = (workspace: string) => join(resolve(workspace), ".cache", "pathlight", "web.json");
/** Where the background server's errors go: it outlives whatever started it, so it holds no pipe to it. */
export const logPath = (workspace: string) => join(resolve(workspace), ".cache", "pathlight", "web.log");

/** Writes the record (the server does, once it listens). */
export const writeRecord = (workspace: string, record: WebRecord) => io("Web.writeRecord", async () => {
  const path = recordPath(workspace), next = `${path}.${process.pid}`;
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(next, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await chmod(next, 0o600);
  await rename(next, path);
});

/** Removes the record if it is still this process's (a newer server may have replaced it). */
export const removeRecord = (workspace: string, pid = process.pid) => io("Web.removeRecord", async () => {
  const record = await readRecordFile(workspace);
  if (record?.pid === pid) await rm(recordPath(workspace), { force: true });
});

const readRecordFile = async (workspace: string): Promise<WebRecord | undefined> => {
  const text = await readFile(recordPath(workspace), "utf8").catch(() => "");
  try {
    const value = JSON.parse(text) as Partial<WebRecord>;
    return typeof value.pid === "number" && typeof value.port === "number" && typeof value.token === "string" && typeof value.url === "string"
      ? { pid: value.pid, port: value.port, token: value.token, url: value.url, project: typeof value.project === "string" ? value.project : "" } : undefined;
  } catch { return undefined; }
};

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return hasCode(error, "EPERM"); } };

/**
 * Asks a recorded server to show `view` (and `select`) in its windows and bring them forward. Answers how many windows it has, or undefined
 * when nothing answers as that server (a stale record).
 */
const raise = (record: WebRecord, view?: string, select?: string) => io("Web.raise", async signal => {
  const response = await fetch(`http://127.0.0.1:${record.port}/api/raise?t=${encodeURIComponent(record.token)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view, select }), signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
  });
  if (!response.ok) return undefined;
  const body = await response.json() as { windows?: unknown };
  return typeof body.windows === "number" ? body.windows : undefined;
}).pipe(Effect.catch(() => Effect.succeed(undefined)));

/** How to run this same Pathlight again: the binary itself, or Bun with this checkout's CLI when running from source. */
export const selfCommand = (): string[] => {
  const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.includes("~BUN");
  return compiled ? [process.execPath] : [process.execPath, join(import.meta.dir, "..", "cli.ts")];
};

export interface Served { url: string; record: WebRecord; windows: number; started: boolean }

/**
 * The workspace's server: the running one if its record answers, else a new one started in the background (`pathlight web --until-closed`),
 * which records itself, serves until its last window closes and gives up if no window comes within a minute.
 */
export const ensureServer = Effect.fn("Web.ensureServer")(function* (options: { workspace: string; view: string; project: string; select?: string | undefined; activity?: ActivityBinding | undefined }) {
  const workspace = resolve(options.workspace);
  const known = yield* io("Web.readRecord", () => readRecordFile(workspace));
  if (known && alive(known.pid) && (!known.project || known.project === options.project)) {
    const windows = yield* raise(known, options.view, options.select);
    if (windows !== undefined) return { url: known.url, record: known, windows, started: false } satisfies Served;
  }
  const command = selfCommand();
  // The session it shows: the one named (the conversation that opened it), else the newest recorded one.
  const session = options.activity ? ["--session", options.activity.session, "--source", options.activity.source] : [];
  const args = [...command.slice(1), "web", options.view, "--workspace", workspace, "--project", options.project, ...session, "--until-closed"];
  const errorsFile = yield* io("Web.log", async () => { await mkdir(join(logPath(workspace), ".."), { recursive: true }); return openSync(logPath(workspace), "w"); });
  const child = yield* Effect.try({
    try: () => spawn(command[0]!, args, { detached: true, stdio: ["ignore", "ignore", errorsFile], cwd: workspace }),
    catch: cause => failure("Web.start", cause),
  }).pipe(Effect.ensuring(Effect.sync(() => closeSync(errorsFile))));
  let exited: number | null | undefined;
  child.once("exit", code => { exited = code; });
  const record = yield* io("Web.waitForServer", async () => {
    // Reading the model takes a few hundred milliseconds; a large workspace longer.
    for (let waited = 0; waited < 30_000; waited += 100) {
      const found = await readRecordFile(workspace);
      if (found?.pid === child.pid) return found;
      if (exited !== undefined) break;
      await Bun.sleep(100);
    }
    return undefined;
  });
  child.unref();
  if (!record) {
    if (exited === undefined) { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already gone */ } }
    const errors = yield* io("Web.logRead", () => readFile(logPath(workspace), "utf8")).pipe(Effect.catch(() => Effect.succeed("")));
    const said = errors.trim().split("\n").filter(Boolean).at(-1);
    return yield* Effect.fail(failure("Web.start", said ?? "pathlight web did not start in time"));
  }
  return { url: record.url, record, windows: 0, started: true } satisfies Served;
});

/** A browser to open the page with: `app` when it is Chromium-family, so it gets a window of its own (`--app`) in Pathlight's own profile. */
export interface Browser { name: string; command: string[]; app: boolean }

const chromium: readonly [string, string][] = [
  ["brave-browser", "Brave"], ["brave", "Brave"], ["google-chrome-stable", "Chrome"], ["google-chrome", "Chrome"], ["chromium", "Chromium"],
  ["chromium-browser", "Chromium"], ["microsoft-edge-stable", "Edge"], ["microsoft-edge", "Edge"], ["vivaldi-stable", "Vivaldi"], ["vivaldi", "Vivaldi"],
];
const macApps: readonly [string, string][] = [
  ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "Brave"], ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "Chrome"],
  ["/Applications/Chromium.app/Contents/MacOS/Chromium", "Chromium"], ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "Edge"],
  ["/Applications/Vivaldi.app/Contents/MacOS/Vivaldi", "Vivaldi"],
];
const chromiumNames = /brave|chrom|edge|vivaldi|opera/i;

/**
 * The browser: the one the person set (`pathlight config set browser COMMAND`), else the first Chromium-family browser found, else the system's
 * opener (a tab in the default browser, without a window of its own). Undefined when there is none at all.
 */
export const findBrowser = Effect.fn("Web.findBrowser")(function* (chosen?: string) {
  const setting = chosen ?? (yield* savedBrowser().pipe(Effect.catch(() => Effect.succeed(undefined))));
  if (setting) {
    const words = setting.split(/\s+/).filter(Boolean);
    const path = words[0]!.includes("/") ? (existsSync(words[0]!) ? words[0]! : undefined) : Bun.which(words[0]!) ?? undefined;
    if (!path) return undefined;
    return { name: basename(words[0]!), command: [path, ...words.slice(1)], app: chromiumNames.test(basename(words[0]!)) } satisfies Browser;
  }
  for (const [command, name] of chromium) { const path = Bun.which(command); if (path) return { name, command: [path], app: true } satisfies Browser; }
  if (process.platform === "darwin") for (const [path, name] of macApps) if (existsSync(path)) return { name, command: [path], app: true } satisfies Browser;
  const opener = Bun.which(process.platform === "darwin" ? "open" : "xdg-open");
  return opener ? { name: "your default browser", command: [opener], app: false } satisfies Browser : undefined;
});

/** Pathlight's own browser profile, so its window opens as an app window whatever the person's own browser is doing, and never touches their profile. */
export const profileDir = () => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pathlight", "browser");

/** The browser's arguments for one window on `url`. */
export const browserArgs = (browser: Browser, url: string, profile = profileDir()) =>
  browser.app ? [...browser.command.slice(1), `--user-data-dir=${profile}`, `--app=${url}`, "--no-first-run", "--no-default-browser-check"] : [...browser.command.slice(1), url];

/** Opens one window on `url`, detached: the browser outlives whatever opened it. */
export const openWindow = Effect.fn("Web.openWindow")(function* (url: string, browser: Browser) {
  if (browser.app) yield* io("Web.profile", () => mkdir(profileDir(), { recursive: true }));
  const child = yield* Effect.try({
    try: () => spawn(browser.command[0]!, browserArgs(browser, url), { detached: true, stdio: "ignore" }),
    catch: cause => failure("Web.browser", cause),
  });
  // A command that cannot run fails at once; one that runs is left alone.
  const failed = yield* io("Web.browserStarted", () => new Promise<Error | undefined>(done => {
    child.once("error", error => done(error));
    setTimeout(() => done(undefined), 150);
  }));
  child.unref();
  if (failed) return yield* Effect.fail(failure("Web.browser", `${browser.name} did not start: ${failed.message}`));
});

/** The page's address at a view and selection (the page opens where its address says). */
export const addressOf = (url: string, view?: string, select?: string) => {
  const address = new URL(url);
  if (view) address.searchParams.set("view", view);
  if (select) address.searchParams.set("select", select);
  return address.toString();
};

/**
 * `pathlight web --open`, `B` and `/pathlight:open web`: the workspace's one window, at `view`. An open window is brought forward and shown the
 * view; otherwise one is opened. Answers one line for the person.
 */
export const launchWeb = Effect.fn("Web.launch")(function* (options: { workspace: string; view: string; project: string; select?: string | undefined; browser?: string; activity?: ActivityBinding | undefined }) {
  const browser = yield* findBrowser(options.browser);
  if (!browser) return yield* Effect.fail(failure("Web.browser", "No browser found. Set one with pathlight config set browser COMMAND, or run pathlight web and open its address."));
  const served = yield* ensureServer(options);
  if (served.windows > 0) return `The map is already open in its window; it now shows ${options.view}.`;
  yield* openWindow(addressOf(served.url, options.view, options.select), browser);
  return `Opened the map in ${browser.name}${browser.app ? "" : " (a tab: a Chromium-family browser gives it a window of its own)"}.`;
});
