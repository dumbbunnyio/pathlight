import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { run } from "./effects";

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
