import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import { loadThemes, paletteOf } from "../src/theme";
import { run } from "./effects";

const rgb = (hex: string) => `48;2;${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(";")}`;

// The picker previews each theme live over the diagram, Esc puts the old one back, Enter keeps it and remembers it for the next run.
test("T previews themes live, Esc restores, Enter keeps and the choice survives a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-theme-picker-"));
  const config = join(directory, "config");
  const socket = join("/tmp", `c4t-${process.pid}.sock`), restarted = join("/tmp", `c4t-${process.pid}-b.sock`);
  const tmuxOn = (path: string) => (...args: string[]) => run("tmux", ["-S", path, ...args]);
  let tmux = tmuxOn(socket);
  try {
    await cp("tests/fixtures/viewer", join(directory, "work"), { recursive: true });
    const themes = await Effect.runPromise(loadThemes(directory));
    const names = [...themes.keys()].sort((a, b) => a === "pathlight" ? -1 : b === "pathlight" ? 1 : a.localeCompare(b));
    const target = names.indexOf("dracula");
    const drawn = (name: string) => rgb(paletteOf(themes.get(name)!, "dark").background);
    const start = (session: string) => tmux("-f", "/dev/null", "new-session", "-d", "-s", session, "-x", "140", "-y", "40", "-P", "-F", "#{pane_id}",
      "env", `XDG_CONFIG_HOME=${config}`, "COLORTERM=truecolor", process.execPath, resolve("src/cli.ts"), "view", "live", "--workspace", join(directory, "work"));
    const pane = await start("picker");
    const until = async (check: (screen: string) => boolean, what: string, colours = false) => {
      let screen = "";
      for (let attempt = 0; attempt < 100; attempt++) {
        screen = await tmux("capture-pane", ...(colours ? ["-e"] : []), "-p", "-t", pane);
        if (check(screen)) return screen;
        await delay(50);
      }
      throw new Error(`Never saw ${what}:\n${screen}`);
    };
    await until(screen => screen.includes("Selected:"), "the diagram");
    await until(screen => screen.includes(drawn("pathlight")), "the built-in theme", true);

    await tmux("send-keys", "-t", pane, "T");
    await until(screen => screen.includes("Theme") && screen.includes(`1/${names.length}`), "the picker");
    for (let step = 0; step < target; step++) await tmux("send-keys", "-t", pane, "Down");
    await until(screen => screen.includes(`${target + 1}/${names.length}`), "the cursor on dracula");
    await until(screen => screen.includes(drawn("dracula")) && !screen.includes(drawn("pathlight")), "dracula drawn over the diagram", true);

    await tmux("send-keys", "-t", pane, "Escape");
    await until(screen => screen.includes(drawn("pathlight")) && !screen.includes(drawn("dracula")), "the built-in theme restored", true);

    await tmux("send-keys", "-t", pane, "T");
    await until(screen => screen.includes(`1/${names.length}`), "the picker again");
    for (let step = 0; step < target; step++) await tmux("send-keys", "-t", pane, "Down");
    await tmux("send-keys", "-t", pane, "Enter");
    await until(screen => screen.includes("Theme: dracula"), "the confirmation");
    await until(screen => screen.includes(drawn("dracula")), "dracula kept", true);
    expect(JSON.parse(await readFile(join(config, "pathlight", "config.json"), "utf8"))).toEqual({ theme: "dracula" });
    await tmux("kill-server");

    // A fresh server for the restart: a killed one can still be shutting down.
    tmux = tmuxOn(restarted);
    const second = await start("again");
    const screen = await (async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const text = await tmux("capture-pane", "-e", "-p", "-t", second);
        if (text.includes("Selected:")) return text;
        await delay(50);
      }
      throw new Error("The second viewer never drew");
    })();
    expect(screen).toContain(drawn("dracula"));
    expect(screen).not.toContain(drawn("pathlight"));
  } finally {
    await tmux("kill-server").catch(() => {});
    await tmuxOn(socket)("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
