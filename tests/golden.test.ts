import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { copyFile } from "node:fs/promises";
import { mappingIn, run, toolActivity, writeActivity } from "./effects";

/**
 * The approved look, kept as text. Each screen is what `pathlight see` prints for the frozen fixture at one size; a change to the diagram, the
 * inspector, the header or the footer shows here as a difference you can read. When a change is meant, look at the new screen and bless it:
 *
 *   UPDATE_GOLDEN=1 TMPDIR=/tmp/opencode bun test tests/golden.test.ts
 *
 * The files are plain text under tests/golden/, so a redesign reads as an ordinary diff in review.
 */
const see = (...args: string[]) => run(process.execPath, [resolve("src/cli.ts"), "see", "live", "--workspace", "tests/fixtures/viewer", "--project", "viewer", ...args]);
const screens: { name: string; args: string[] }[] = [
  { name: "list-70x24", args: ["--cols", "70", "--rows", "24"] },
  { name: "diagram-100x30", args: ["--cols", "100", "--rows", "30"] },
  { name: "overlay-100x30", args: ["--cols", "100", "--rows", "30", "--keys", "i"] },
  { name: "docked-140x36", args: ["--cols", "140", "--rows", "36"] },
  { name: "docked-launcher-140x36", args: ["--cols", "140", "--rows", "36", "--select", "launcher"] },
  { name: "docked-wide-260x50", args: ["--cols", "260", "--rows", "50", "--select", "viewer"] },
  { name: "help-140x36", args: ["--cols", "140", "--rows", "36", "--keys", "?"] },
  // The talk, opened with `t` beside a stand-in agent pane (`see --agent`): its tabs, toggles and offered question, with no session bound.
  { name: "talk-140x36", args: ["--cols", "140", "--rows", "36", "--agent", "--keys", "t"] },
  { name: "talk-overlay-100x30", args: ["--cols", "100", "--rows", "30", "--agent", "--keys", "t"] },
  { name: "talk-70x24", args: ["--cols", "70", "--rows", "24", "--agent", "--keys", "t"] },
];

// `run` trims its output, which would move the first row; `see` is read here through a file for the same reason.
const capture = async (args: string[]) => {
  const out = `${process.env.TMPDIR ?? "/tmp"}/pathlight-golden-${process.pid}-${Math.random().toString(36).slice(2)}.txt`;
  await run("sh", ["-c", `"$1" "$2" see live --workspace tests/fixtures/viewer --project viewer ${args.map(arg => `'${arg}'`).join(" ")} > "$3"`, "sh", process.execPath, resolve("src/cli.ts"), out]);
  return readFile(out, "utf8");
};

test.each(screens)("the $name screen matches its snapshot", async ({ name, args }) => {
  const screen = await capture(args);
  const file = `tests/golden/${name}.txt`;
  if (process.env.UPDATE_GOLDEN === "1") { await mkdir("tests/golden", { recursive: true }); await writeFile(file, screen); return; }
  const expected = await readFile(file, "utf8").catch(() => undefined);
  if (expected === undefined) throw new Error(`No snapshot for ${name}. Look at the screen, then run with UPDATE_GOLDEN=1 to keep it:\n${screen}`);
  expect(screen).toBe(expected);
}, 60_000);

test("the same view at the same size draws the same screen twice", async () => {
  const first = await capture(["--cols", "120", "--rows", "30"]);
  expect(await capture(["--cols", "120", "--rows", "30"])).toBe(first);
}, 60_000);

test("a key sent to the viewer changes the screen, and an unknown element is refused with a message", async () => {
  const plain = await capture(["--cols", "140", "--rows", "30"]);
  const folded = await capture(["--cols", "140", "--rows", "30", "--keys", "2"]);
  expect(folded).not.toBe(plain);
  await expect(see("--select", "nonesuch")).rejects.toThrow(/has no element 'nonesuch'/);
}, 60_000);

// Watching a session keeps a row on every card for its activity counts. Two finished calls, written two and a half hours before the screen is
// taken so every age reads `2h`: a read of a file mapped to the launcher, then an edit of one mapped to activity.
test("the watched-140x36 screen matches its snapshot", async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "pathlight-golden-watched-"));
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src/activity.ts"), "export {};\n"); await writeFile(join(directory, "src/launcher.ts"), "export {};\n");
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer",
      mappings: [{ glob: "src/activity.ts", element: "activity" }, { glob: "src/launcher.ts", element: "launcher" }] }));
    const binding = { source: "claude" as const, session: "golden" }, edited = Date.now() - 150 * 60_000;
    for (const [call, tool, file, time] of [["read-1", "Read", "src/launcher.ts", edited - 5_000], ["edit-1", "Edit", "src/activity.ts", edited]] as const) {
      const started = toolActivity(directory, binding, call, tool, { file_path: join(directory, file) }, "started");
      await writeActivity(directory, { ...started, time: time - 1_000 });
      await writeActivity(directory, { ...started, phase: "completed", time });
    }
    const out = join(directory, "screen.txt");
    await run("sh", ["-c", `"$1" "$2" see live --workspace "$3" --project viewer --cols 140 --rows 36 --follow > "$4"`, "sh", process.execPath, resolve("src/cli.ts"), directory, out]);
    const screen = await readFile(out, "utf8"), file = "tests/golden/watched-140x36.txt";
    if (process.env.UPDATE_GOLDEN === "1") { await mkdir("tests/golden", { recursive: true }); await writeFile(file, screen); return; }
    expect(screen).toBe(await readFile(file, "utf8"));
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

// `n` names a box of a drafted map; the frozen fixture is a hand-written model, so a copy gets the keys file the draft would have written. The
// screen is the first step of the two, in the modal frame, with the generated name in its three-row field.
test("the name-140x36 screen matches its snapshot", async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "pathlight-golden-name-"));
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await mkdir(join(directory, ".cache", "pathlight"), { recursive: true });
    await writeFile(join(directory, ".cache", "pathlight", "keys.json"), JSON.stringify({ version: 1, keys: { plugin: "plugins" } }));
    const out = join(directory, "screen.txt");
    await run("sh", ["-c", `"$1" "$2" see live --workspace "$3" --project viewer --cols 140 --rows 36 --keys n > "$4"`, "sh", process.execPath, resolve("src/cli.ts"), directory, out]);
    const screen = await readFile(out, "utf8"), file = "tests/golden/name-140x36.txt";
    if (process.env.UPDATE_GOLDEN === "1") { await mkdir("tests/golden", { recursive: true }); await writeFile(file, screen); return; }
    expect(screen).toBe(await readFile(file, "utf8"));
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);

// The talk after its first request, beside a recorded session whose pointer names the conversation fixture; its turn ended half a minute ago, so the
// state line says `done`. Times are shown on the person's clock, so the screen is taken in UTC.
test.each([{ name: "talk-reply-140x36", keys: "t,Enter" }, { name: "talk-wide-140x36", keys: "t,Enter,z" }])("the $name screen matches its snapshot", async ({ name, keys }) => {
  const directory = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "pathlight-golden-talk-"));
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await writeFile(mappingIn(directory), JSON.stringify({ version: 1, project: "viewer", mappings: [] }));
    const binding = { source: "claude" as const, session: "talk-golden" };
    await writeActivity(directory, { ...toolActivity(directory, binding, "c1", "Read", { file_path: join(directory, "model.c4") }, "completed"), time: Date.now() - 60_000 });
    await copyFile("tests/fixtures/conversation/claude.jsonl", join(directory, "conversation.jsonl"));
    await mkdir(join(directory, ".cache", "pathlight", "sessions"), { recursive: true });
    await writeFile(join(directory, ".cache", "pathlight", "sessions", "claude-talk-golden.json"), JSON.stringify({ version: 1, source: "claude", session: "talk-golden",
      transcript: join(directory, "conversation.jsonl"), waiting: false, ended: Date.now() - 30_000 }));
    const out = join(directory, "screen.txt");
    await run("sh", ["-c", `TZ=UTC "$1" "$2" see live --workspace "$3" --project viewer --cols 140 --rows 36 --agent --follow --keys "$5" > "$4"`, "sh", process.execPath, resolve("src/cli.ts"), directory, out, keys]);
    const screen = await readFile(out, "utf8"), file = `tests/golden/${name}.txt`;
    if (process.env.UPDATE_GOLDEN === "1") { await mkdir("tests/golden", { recursive: true }); await writeFile(file, screen); return; }
    expect(screen).toBe(await readFile(file, "utf8"));
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
