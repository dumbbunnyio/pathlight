import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import type { Diff } from "../src/diff";
import { firstChange } from "../src/editor";
import { decide, readDecisions, reviewItems, reviewMessage } from "../src/review";
import { run, mappingIn } from "./effects";

const diff = (undeclared: Diff["undeclared"]): Diff => ({ version: 1, basis: "static", base: "HEAD", sha: "abc", time: 1, relationships: [], undeclared });
const pair = (source: string, target: string) => ({ source, target, imports: 2, example: { from: `src/${source}.ts`, line: 3, to: `src/${target}.ts` } });

test("the review lists each new dependency with its verdict, undecided first, and a decision replaces the earlier one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-review-"));
  try {
    expect(reviewItems(undefined, { version: 1, decisions: [] })).toEqual([]);
    await Effect.runPromise(decide(directory, { source: "a", target: "b" }, "rejected"));
    await Effect.runPromise(decide(directory, { source: "a", target: "b" }, "accepted"));
    const decisions = await Effect.runPromise(readDecisions(directory));
    expect(decisions.decisions.map(item => item.verdict)).toEqual(["accepted"]);
    expect(reviewItems(diff([pair("a", "b"), pair("c", "d")]), decisions).map(item => [item.source, item.verdict])).toEqual([["c", undefined], ["a", "accepted"]]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("what the agent is asked names the pair, the import behind it, and carries no control characters", () => {
  const title = (id: string) => ({ ui: "Web page\x1b[31m", db: "Store" }[id] ?? id);
  const rejected = reviewMessage(pair("ui", "db"), "rejected", title);
  expect(rejected).toContain("Web page [31m (ui) → Store (db) is not wanted");
  expect(rejected).toContain("src/ui.ts:3, which imports src/db.ts, and 1 more import");
  expect(rejected).toContain("wait for me");
  expect(rejected).not.toMatch(/[\x00-\x1f\x7f]/);
  expect(reviewMessage(pair("ui", "db"), "accepted", title)).toContain("is intended");
});

test("on a drafted map, accepting the last undecided dependency redraws the map from the code, and the review empties", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-review-draft-"));
  const socket = join("/tmp", `c4rd-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  const cli = (...args: string[]) => run(process.execPath, [resolve("src/cli.ts"), ...args]);
  try {
    const write = async (path: string, text: string) => { await mkdir(join(directory, path, ".."), { recursive: true }); await writeFile(join(directory, path), text); };
    await write("package.json", JSON.stringify({ name: "shop" }));
    for (const [folder, files] of [["web", ["page.ts", "form.ts", "list.ts"]], ["store", ["db.ts", "rows.ts", "query.ts"]], ["api", ["route.ts", "auth.ts", "body.ts"]]] as const)
      for (const file of files) await write(`src/${folder}/${file}`, `export const ${file.replace(".ts", "")} = 1;\n`);
    await write("src/web/page.ts", `import { route } from "../api/route";\nexport const page = route;\n`);
    await write("src/api/route.ts", `import { db } from "../store/db";\nexport const route = db;\n`);
    const git = (...args: string[]) => run("git", ["-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    await cli("draft", "--workspace", directory);
    await git("init", "-q"); await git("add", "-A"); await git("commit", "-q", "-m", "first");
    // A turn makes the page read the store directly, and the Stop hook records the diff.
    await write("src/web/page.ts", `import { route } from "../api/route";\nimport { db } from "../store/db";\nexport const page = route + db;\n`);
    await cli("diff", "--workspace", directory, "--quiet");
    expect(await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8")).not.toMatch(/web -> store/);
    // A stand-in editor named nvim, so the viewer passes it a line; it records what it was given.
    await write("bin/nvim", `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(directory, "editor-args")}"\n`);
    await run("chmod", ["+x", join(directory, "bin/nvim")]);
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "review-draft", "-x", "160", "-y", "40", "-P", "-F", "#{pane_id}",
      "env", `VISUAL=${join(directory, "bin/nvim")}`, process.execPath, resolve("src/cli.ts"), "view", "index", "--workspace", directory);
    const until = async (predicate: (text: string) => boolean, label: string) => {
      let output = "";
      for (let attempt = 0; attempt < 200; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (predicate(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${label}:\n${output}`);
    };
    await until(text => text.includes("▲ 1 new dependency · c review"), "the header asking for a review");
    await tmux("send-keys", "-t", pane, "c");
    await until(text => text.includes("web → store") && text.includes("1 to decide"), "the review");
    // e reads the import behind it before deciding.
    await tmux("send-keys", "-t", pane, "e");
    await until(text => text.includes("Returned from src/web/page.ts:2"), "back from the import");
    expect((await readFile(join(directory, "editor-args"), "utf8")).trim().split("\n")).toEqual(["+2", join(await realpath(directory), "src/web/page.ts")]);
    await tmux("send-keys", "-t", pane, "y");
    await until(text => text.includes("The map now draws the dependency you accepted"), "the redraw");
    expect(await readFile(join(directory, ".pathlight", "pathlight.model.c4"), "utf8")).toMatch(/web -> \S*store/);
    await until(text => !text.includes("c review"), "the header after the redraw");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("c reviews a new dependency: the header asks for it, n rejects it, and the agent's pane is asked to take it out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-review-ui-"));
  const socket = join("/tmp", `c4r-${process.pid}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer", mappings: [{ glob: "plugins/**", element: "plugin" }] }));
    // What the Stop hook's `pathlight diff` leaves after a turn that made the plugin import the viewer.
    await mkdir(join(directory, ".cache", "pathlight"), { recursive: true });
    await writeFile(join(directory, ".cache", "pathlight", "diff.json"), JSON.stringify(diff([pair("plugin", "viewer")])));
    // `cat` stands in for the agent: it echoes whatever is typed into its pane.
    const harness = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "review-test", "-x", "170", "-y", "44", "-P", "-F", "#{pane_id}", "cat");
    const shown = JSON.parse(await run(process.execPath, [resolve("src/cli.ts"), "show", "live", "--workspace", directory,
      "--project", "viewer", "--pane", harness, "--socket", socket])) as { pane: string };
    const until = async (pane: string, predicate: (text: string) => boolean, label: string) => {
      let output = "";
      for (let attempt = 0; attempt < 120; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (predicate(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${label}:\n${output}`);
    };
    await until(shown.pane, text => text.includes("▲ 1 new dependency · c review"), "the header asking for a review");
    await tmux("send-keys", "-t", shown.pane, "c");
    const review = await until(shown.pane, text => text.includes("New dependencies since HEAD"), "the review");
    expect(review).toContain("Agent adapters → Persistent viewer");
    expect(review).toContain("src/plugin.ts:3 imports src/viewer.ts");
    expect(review).toContain("1 to decide");
    await tmux("send-keys", "-t", shown.pane, "n");
    await until(shown.pane, text => text.includes("rejected · still in the code"), "the verdict");
    const agent = await until(harness, text => text.includes("is not wanted"), "the request in the agent's pane");
    expect(agent).toContain("Take it out and tell me how");
    expect((await readFile(join(directory, ".cache", "pathlight", "decisions.json"), "utf8"))).toContain('"verdict":"rejected"');
    // Decided: the header stops asking.
    await tmux("send-keys", "-t", shown.pane, "Escape");
    await until(shown.pane, text => !text.includes("c review") && text.includes("Selected: plugin"), "the header after the verdict");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a file with uncommitted changes opens at its first change; one without, or outside git, at the top", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-first-change-"));
  try {
    await writeFile(join(directory, "a.ts"), "one\ntwo\nthree\nfour\n");
    expect(await Effect.runPromise(firstChange(directory, "a.ts"))).toBeUndefined();
    const git = (...args: string[]) => run("git", ["-C", directory, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
    await git("init", "-q"); await git("add", "-A"); await git("commit", "-q", "-m", "first");
    expect(await Effect.runPromise(firstChange(directory, "a.ts"))).toBeUndefined();
    await writeFile(join(directory, "a.ts"), "one\ntwo\nTHREE\nfour\nfive\n");
    expect(await Effect.runPromise(firstChange(directory, "a.ts"))).toBe(3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
