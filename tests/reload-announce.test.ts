import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./effects";

// Phase 6 step 4: a box the end of a turn drew announces itself: the news line (header line 2) names it, never the footer, and with follow on the
// camera goes to it without selecting it. With follow off the camera stays where the person put it.
const cli = (directory: string, ...args: string[]) => Bun.spawnSync([process.execPath, resolve("src/cli.ts"), ...args, "--workspace", directory], { stdout: "pipe", stderr: "pipe" });

const shop = async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-announce-"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "shop" }));
  for (const part of ["api", "store", "mail", "cart"]) {
    await mkdir(join(directory, `src/${part}`), { recursive: true });
    for (const name of ["a", "b", "c"]) await writeFile(join(directory, `src/${part}/${name}.ts`), part === "store" ? "export const save = () => 1;\n" : `import { save } from "../store/${name}";\nexport const h = () => save();\n`);
  }
  expect(cli(directory, "draft").exitCode).toBe(0);
  return directory;
};

const watch = async (follow: boolean) => {
  const directory = await shop();
  const socket = join("/tmp", `c4an-${process.pid}-${follow ? "f" : "n"}.sock`);
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "announce", "-x", "140", "-y", "40", "-P", "-F", "#{pane_id}",
      process.execPath, resolve("src/cli.ts"), "view", "index", "--workspace", directory, "--session", "turn", "--source", "claude");
    const screen = async () => (await tmux("capture-pane", "-p", "-t", pane)).split("\n");
    const until = async (predicate: (lines: string[]) => boolean, label: string) => {
      let lines: string[] = [];
      for (let attempt = 0; attempt < 160; attempt++) { lines = await screen(); if (predicate(lines)) return lines; await delay(50); }
      throw new Error(`Missing ${label}:\n${lines.join("\n")}`);
    };
    await until(lines => lines.some(line => line.includes("Selected:")), "the viewer");
    await delay(900);
    // Zoomed in on the top left corner: the person has put the camera somewhere.
    await tmux("send-keys", "-t", pane, "+", "+", "+", "+");
    await until(lines => lines.some(line => /zoom (2|3)\d\d%/.test(line)), "the zoom");
    if (follow) { await tmux("send-keys", "-t", pane, "a"); await until(lines => lines.some(line => line.includes("following")), "follow on"); }
    const selected = (await screen()).join("\n").match(/Selected: (\S+)/)?.[1];

    // The agent's turn ends: a folder no box claims, and the end of the turn redraws.
    await mkdir(join(directory, "src/zebra"), { recursive: true });
    for (const name of ["a", "b", "c"]) await writeFile(join(directory, `src/zebra/${name}.ts`), `import { save } from "../store/${name}";\nexport const z = () => save();\n`);
    expect(cli(directory, "refresh").exitCode).toBe(0);
    const after = await until(lines => lines[1]!.includes("+ zebra"), "the new box on the news line");
    expect(after.at(-1)).not.toContain("zebra");
    expect(after.join("\n").match(/Selected: (\S+)/)?.[1]).toBe(selected);
    await delay(800);
    // Whether the new card is on screen: its title inside a card's border, below the header.
    return (await screen()).slice(3).some(line => /│ zebra\s/.test(line));
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
};

test("a reload that adds a box names it on the news line and, with follow on, brings it into view without selecting it", async () => {
  expect(await watch(true)).toBe(true);
}, 90_000);

test("with follow off, a reload that adds a box leaves the camera where the person put it", async () => {
  expect(await watch(false)).toBe(false);
}, 90_000);
