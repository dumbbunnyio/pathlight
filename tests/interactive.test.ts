import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { run } from "./effects";
import { activityDirectory, toolActivity, writeActivity } from "./effects";

test("mapped files filter without live recording and round-trip through a real terminal editor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "c4view-editor-"));
  const socket = join(directory, "tmux.sock");
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await mkdir(join(directory, "src"));
    const filename = "src/it's a file.ts";
    await writeFile(join(directory, filename), "initial\n");
    for (const name of ["b", "c", "d", "e", "f"]) await writeFile(join(directory, "src", `${name}.ts`), "initial\n");
    await writeFile(join(directory, "c4view.activity.json"), JSON.stringify({ version: 1, project: "viewer",
      mappings: [{ glob: "src/**", element: "plugin" }, { glob: "src/b.ts", element: "plugin" }] }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "editor-test", "-x", "100", "-y", "36",
      "-P", "-F", "#{pane_id}", "env", "VISUAL=nvim -u NONE -i NONE -n", "EDITOR=nonexistent-editor",
      process.execPath, resolve("src/cli.ts"), "view", "live", "--project", "viewer", "--workspace", directory);
    const capture = async (text: string | RegExp) => {
      let output = "";
      for (let attempt = 0; attempt < 120; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (typeof text === "string" ? output.includes(text) : text.test(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${text}:\n${output}`);
    };
    await capture("Selected: plugin");
    await delay(700);
    await tmux("send-keys", "-t", pane, "0");
    await capture("zoom 100%");
    await delay(700);
    await tmux("send-keys", "-t", pane, "Right", "Down");
    await delay(300);
    // Below 120 columns the inspector overlays the right half; compare only the diagram columns.
    const diagram = (text: string) => text.split("\n").slice(3, 22).map(line => line.slice(0, 46)).join("\n");
    await tmux("send-keys", "-t", pane, "e");
    await capture(/Files[─\s]+1\/6/);
    const listing = (await capture("b.ts")).split("\n");
    const row = listing.findIndex(line => line.includes("b.ts"));
    const column = listing[row]!.indexOf("b.ts");
    await tmux("send-keys", "-t", pane, "-l", `\x1b[<0;${column + 2};${row + 1}M\x1b[<0;${column + 2};${row + 1}m`);
    await capture("Click again or Enter to open");
    await tmux("send-keys", "-t", pane, "-l", "b.ts");
    await capture(/Files[─\s]+1\/1/);
    await tmux("send-keys", "-t", pane, "C-u");
    await capture(/Files[─\s]+1\/6/);
    // Compare editor return with the same notice-row geometry.
    await tmux("send-keys", "-t", pane, "C-r");
    await capture("Files refreshed");
    await delay(700);
    const before = diagram(await tmux("capture-pane", "-p", "-t", pane));
    await tmux("send-keys", "-t", pane, "-l", "\x1b[<65;15;10M");
    await delay(100);
    expect(diagram(await tmux("capture-pane", "-p", "-t", pane))).toBe(before);
    await tmux("send-keys", "-t", pane, "Down", "Down", "Down", "Down");
    expect(await capture(/› [├└]─ f\.ts/)).toMatch(/Files[─\s]+5\/6/);
    await tmux("send-keys", "-t", pane, "-l", "it's");
    expect(await capture(/Files[─\s]+1\/1/)).toContain("it's a file.ts");
    await tmux("send-keys", "-t", pane, "Enter");
    await capture("initial");
    await tmux("resize-window", "-t", pane, "-x", "120", "-y", "40");
    await delay(200);
    await tmux("send-keys", "-t", pane, "-l", ":call writefile([string(&columns), string(&lines)], 'editor-size.txt')");
    await tmux("send-keys", "-t", pane, "Enter");
    for (let i = 0; i < 50 && !await Bun.file(join(directory, "editor-size.txt")).exists(); i++) await delay(50);
    expect(await readFile(join(directory, "editor-size.txt"), "utf8")).toBe("120\n40\n");
    await tmux("resize-window", "-t", pane, "-x", "100", "-y", "36");
    await delay(200);
    await tmux("send-keys", "-t", pane, "-l", ":%s/initial/edited/");
    await tmux("send-keys", "-t", pane, "Enter");
    await tmux("send-keys", "-t", pane, "-l", ":wq");
    await tmux("send-keys", "-t", pane, "Enter");
    expect(await capture("Returned from editor:")).toMatch(/Files[─\s]+1\/1/);
    expect(await readFile(join(directory, filename), "utf8")).toBe("edited\n");
    await delay(700);
    const returned = await tmux("capture-pane", "-p", "-t", pane);
    expect(returned).toContain("zoom 100%");
    expect(returned).toContain("Selected: plugin");
    expect(diagram(returned)).toBe(before);
    await tmux("send-keys", "-t", pane, "Enter");
    await capture("edited");
    await tmux("send-keys", "-t", pane, "-l", ":cq");
    await tmux("send-keys", "-t", pane, "Enter");
    expect(await capture("Editor exited with status 1")).toMatch(/Files[─\s]+1\/1/);
    await rename(join(directory, filename), join(directory, "src", "renamed.ts"));
    await tmux("send-keys", "-t", pane, "Enter");
    await capture("ENOENT");
    await tmux("send-keys", "-t", pane, "C-r");
    await capture(/Files[─\s]+0\/0/);
    await tmux("send-keys", "-t", pane, "C-u");
    await capture(/Files[─\s]+1\/6/);
    await tmux("send-keys", "-t", pane, "Escape");
    expect(await capture(/diagram\s+Selected/)).toContain("zoom 100%");
    await tmux("send-keys", "-t", pane, "Tab");
    await capture("Selected: catalog");
    await tmux("send-keys", "-t", pane, "e");
    expect(await capture(/Files[─\s]+0\/0/)).toContain("No files mapped");
    await tmux("send-keys", "-t", pane, "C-c");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("native diagram supports keyboard, mouse after pan/resize, and live node activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "c4view-native-"));
  const socket = join(directory, "tmux.sock");
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    await writeFile(join(directory, "c4view.activity.json"), JSON.stringify({ version: 1, project: "viewer",
      mappings: [{ glob: "src/activity.ts", element: "activity" }] }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "native-test", "-x", "100", "-y", "42",
      "-P", "-F", "#{pane_id}", "sleep", "120");
    await tmux("set-option", "-w", "remain-on-exit", "on");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = [process.execPath, resolve("src/cli.ts"), "view", "live", "--project", "viewer",
      "--workspace", directory, "--session", "native-test", "--source", "claude"].map(quote).join(" ");
    await writeFile(join(directory, "run.sh"), `${command}\nprintf '%s' "$?" > ${quote(join(directory, "exit-status"))}\n`);
    await tmux("respawn-pane", "-k", "-t", pane, "sh", join(directory, "run.sh"));
    const capture = async (text: string | RegExp) => {
      let output = "";
      for (let attempt = 0; attempt < 120; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (typeof text === "string" ? output.includes(text) : text.test(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${text}:\n${output}`);
    };
    await capture("Selected: plugin");
    await capture("adapters");
    await delay(700);
    await tmux("send-keys", "-t", pane, "0");
    await capture("zoom 100%");
    await delay(300);
    await tmux("send-keys", "-t", pane, "Tab");
    await capture("Selected: catalog");
    const clickTitle = async (title: string, id: string) => {
      const output = await capture(title);
      const lines = output.split("\n");
      const y = lines.findIndex(line => line.includes(title));
      const x = (lines[y]?.indexOf(title) ?? -1) + 1;
      expect(y).toBeGreaterThanOrEqual(0);
      await tmux("send-keys", "-t", pane, "-l", `\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
      return capture(`Selected: ${id}`);
    };
    expect(await clickTitle("Activity", "activity")).toContain("Selected: activity");
    await tmux("send-keys", "-t", pane, "+", "+");
    await capture("zoom 156%");
    await delay(700);
    expect(await clickTitle("Activity", "activity")).toContain("Selected: activity");
    await tmux("send-keys", "-t", pane, "0");
    await capture("zoom 100%");
    await delay(300);
    await tmux("send-keys", "-t", pane, "Right", "Right");
    await tmux("resize-window", "-t", pane, "-x", "90", "-y", "36");
    await delay(200);
    await tmux("send-keys", "-t", pane, "Tab");
    await capture("Selected: launcher");
    expect(await clickTitle("Activity", "activity")).toContain("Selected: activity");
    const event = toolActivity(directory, { source: "claude", session: "native-test" }, "edit-1", "Edit",
      { file_path: join(directory, "src/activity.ts") }, "started");
    await writeActivity(directory, event);
    expect(await capture("[edit]")).toContain("Selected: activity");
    await clickTitle("tmux launcher", "launcher");
    await delay(300);
    const activeFrames = new Set<string>();
    for (let frame = 0; frame < 4; frame++) {
      activeFrames.add(await tmux("capture-pane", "-e", "-p", "-t", pane));
      await delay(300);
    }
    expect(activeFrames.size).toBeGreaterThan(1);
    await clickTitle("Activity", "activity");
    await writeActivity(directory, { ...event, phase: "failed", time: Date.now() });
    expect(await capture("[failed]")).toContain("Selected: activity");
    const finishedFrame = await tmux("capture-pane", "-e", "-p", "-t", pane);
    await delay(600);
    expect(await tmux("capture-pane", "-e", "-p", "-t", pane)).toBe(finishedFrame);
    const journal = await activityDirectory(directory, event);
    await rename(journal, `${journal}.saved`);
    await writeFile(journal, "unavailable");
    await tmux("send-keys", "-t", pane, "pagedown", "pagedown", "pagedown", "pagedown");
    await capture("Activity unavailable");
    await tmux("send-keys", "-t", pane, "4");
    await delay(5200);
    const unavailable = await tmux("capture-pane", "-p", "-t", pane);
    expect(unavailable).toContain("Activity unavailable");
    expect(unavailable).not.toContain("[failed]");
    await tmux("send-keys", "-t", pane, "q");
    for (let i = 0; i < 50; i++) {
      if (await Bun.file(join(directory, "exit-status")).exists()) break;
      await delay(50);
    }
    expect(await readFile(join(directory, "exit-status"), "utf8")).toBe("0");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("search isolates typing, cycles matches, accepts without navigation, and cancels to the original viewport", async () => {
  const directory = await mkdtemp(join(tmpdir(), "c4view-search-"));
  const socket = join(directory, "tmux.sock");
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("examples/parcel", directory, { recursive: true, filter: path => !path.includes(".cache") });
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "search-test", "-x", "90", "-y", "36",
      "-P", "-F", "#{pane_id}", process.execPath, resolve("src/cli.ts"), "view", "services",
      "--workspace", directory, "--project", "parcel");
    const capture = async (text: string | RegExp) => {
      let output = "";
      for (let attempt = 0; attempt < 120; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (typeof text === "string" ? output.includes(text) : text.test(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${text}:\n${output}`);
    };
    await capture("Service architecture");
    await delay(700);
    await tmux("send-keys", "-t", pane, "0", "Tab", "Tab", "Tab", "Right", "Down");
    await capture("Selected: parcel.commerce");
    await delay(700);
    const before = await tmux("capture-pane", "-p", "-t", pane);
    await tmux("send-keys", "-t", pane, "/");
    expect(await capture("Search 0/0")).toMatch(/type a name or id/);
    await tmux("send-keys", "-t", pane, "-l", "qbohjkl");
    const absent = await capture("No matches in this view");
    expect(absent).toContain("qbohjkl");
    expect(absent).toContain("Selected: parcel.commerce");
    await tmux("send-keys", "-t", pane, "Enter");
    expect(await capture("Search 0/0")).toContain("No matches in this view");
    await tmux("send-keys", "-t", pane, "Escape");
    await capture("Service architecture");
    await delay(700);
    const diagramCells = (text: string) => text.split("\n").slice(1, 25).map(line => line.padEnd(90).slice(0, 86)).join("\n");
    expect(diagramCells(await tmux("capture-pane", "-p", "-t", pane))).toBe(diagramCells(before));
    await tmux("send-keys", "-t", pane, "/");
    await tmux("send-keys", "-t", pane, "-l", "commerce");
    await capture("Search 1/6");
    await delay(300);
    const searching = await capture("Checkout API");
    const lines = searching.split("\n");
    const row = lines.findIndex(line => line.includes("Checkout API"));
    const column = lines[row]?.indexOf("Checkout API") ?? -1;
    expect(column).toBeGreaterThanOrEqual(0);
    await tmux("send-keys", "-t", pane, "-l", `\x1b[<0;${column + 2};${row + 1}M\x1b[<0;${column + 2};${row + 1}m`);
    expect(await capture("Search 1/6")).toContain("Selected: parcel.commerce");
    await tmux("send-keys", "-t", pane, "-l", "x");
    expect(await capture("No matches in this view")).toContain("commercex");
    await tmux("send-keys", "-t", pane, "BSpace");
    await capture("Search 1/6");
    await tmux("send-keys", "-t", pane, "-l", "\x1b[200~x\x1b[201~");
    expect(await capture("No matches in this view")).toContain("commercex");
    await tmux("send-keys", "-t", pane, "BSpace");
    await capture("Search 1/6");
    await tmux("send-keys", "-t", pane, "-l", "\x1b[<0;1;2M\x1b[<0;1;2m");
    await tmux("send-keys", "-t", pane, "-l", "x");
    expect(await capture("No matches in this view")).toContain("commercex");
    await tmux("send-keys", "-t", pane, "BSpace");
    await capture("Search 1/6");
    await tmux("send-keys", "-t", pane, "Up");
    expect(await capture("Search 6/6")).toContain("Selected: parcel.commerce.stock");
    await tmux("send-keys", "-t", pane, "Tab", "Down");
    expect(await capture("Search 2/6")).toContain("Selected: parcel.commerce.api");
    await tmux("resize-window", "-t", pane, "-x", "80", "-y", "32");
    await delay(300);
    await tmux("send-keys", "-t", pane, "BSpace");
    expect(await capture("Search 1/6")).toContain("commerc");
    await tmux("resize-window", "-t", pane, "-x", "90", "-y", "36");
    await delay(300);
    await tmux("send-keys", "-t", pane, "Escape");
    await capture("Service architecture");
    await delay(100);
    expect(diagramCells(await tmux("capture-pane", "-p", "-t", pane))).toBe(diagramCells(before));
    await tmux("send-keys", "-t", pane, "/");
    await tmux("send-keys", "-t", pane, "-l", "\x1b[200~cHeCkOuT aPi\x1b[201~");
    expect(await capture("Search 1/1")).toContain("Selected: parcel.commerce.api");
    await tmux("send-keys", "-t", pane, "Enter");
    expect(await capture("back 0")).toContain("Selected: parcel.commerce.api");
    await tmux("send-keys", "-t", pane, "/");
    await tmux("send-keys", "-t", pane, "-l", "commerce");
    await capture("Search 1/6");
    await tmux("send-keys", "-t", pane, "Enter");
    expect(await capture("back 0")).toContain("Selected: parcel.commerce");
    await tmux("send-keys", "-t", pane, "o");
    await capture("back 1");
    await delay(100);
    await tmux("send-keys", "-t", pane, "/");
    await tmux("send-keys", "-t", pane, "-l", "parcel.commerce.api");
    await capture("Search 1/1");
    await tmux("send-keys", "-t", pane, "Enter");
    expect(await capture("back 1")).toContain("Selected: parcel.commerce.api");
    await tmux("send-keys", "-t", pane, "Enter");
    await capture("back 2");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("linked views keep one process and restore selection, scroll, and live activity on back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "c4view-navigation-"));
  const socket = join(directory, "tmux.sock");
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("examples/parcel", directory, { recursive: true, filter: path => !path.includes(".cache") });
    const viewsFile = join(directory, "views.c4");
    await writeFile(viewsFile, (await readFile(viewsFile, "utf8")).replace("include customer, parcel, payments, carrier, email",
      "include customer, parcel, payments, carrier, email\n include email with { navigateTo empty }") + "\nviews { view empty { title 'Empty' } }\n");
    await writeFile(join(directory, "c4view.activity.json"), JSON.stringify({ version: 1, project: "parcel",
      mappings: [{ glob: "src/api.ts", element: "parcel.commerce.api" }] }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "navigation-test", "-x", "90", "-y", "36",
      "-P", "-F", "#{pane_id}", "sleep", "120");
    await tmux("set-option", "-w", "remain-on-exit", "on");
    await tmux("respawn-pane", "-k", "-t", pane, process.execPath, resolve("src/cli.ts"), "view", "index",
      "--workspace", directory, "--project", "parcel", "--session", "navigation-test", "--source", "claude");
    const capture = async (text: string | RegExp) => {
      let output = "";
      for (let attempt = 0; attempt < 120; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (typeof text === "string" ? output.includes(text) : text.test(output)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${text}:\n${output}`);
    };
    await capture("System context");
    const pid = await tmux("display-message", "-p", "-t", pane, "#{pane_pid}");
    await tmux("send-keys", "-t", pane, "o");
    expect(await capture("No linked view")).toContain("System context");
    await tmux("send-keys", "-t", pane, "b");
    expect(await capture("No previous view")).toContain("System context");
    await tmux("send-keys", "-t", pane, "BTab");
    await capture("Selected: email");
    await tmux("send-keys", "-t", pane, "Enter");
    const rejected = await capture("View 'empty' has no nodes.");
    expect(rejected).toContain("back 0");
    expect(rejected).toContain("Selected: email");
    await tmux("send-keys", "-t", pane, "Tab");
    await tmux("send-keys", "-t", pane, "Tab", "Enter");
    await capture("back 1");
    await delay(100);
    await tmux("send-keys", "-t", pane, "Tab", "Tab", "Tab");
    await capture("Selected: parcel.commerce");
    await tmux("send-keys", "-t", pane, "0", "+");
    await capture("zoom 125%");
    await delay(700);
    await tmux("send-keys", "-t", pane, "Right", "Down");
    await delay(700);
    const before = await tmux("capture-pane", "-p", "-t", pane);
    await tmux("send-keys", "-t", pane, "o");
    await capture("back 2");
    await delay(100);
    await tmux("send-keys", "-t", pane, "b");
    await capture("back 1");
    await delay(100);
    const diagramCells = (text: string) => text.split("\n").slice(1, 25).map(line => line.padEnd(90).slice(0, 89)).join("\n");
    const returned = await tmux("capture-pane", "-p", "-t", pane);
    expect(returned).toContain("Selected: parcel.commerce");
    expect(returned).toContain("zoom 125%");
    expect(diagramCells(returned)).toBe(diagramCells(before));
    await tmux("send-keys", "-t", pane, "o");
    await capture("back 2");
    await delay(100);
    await tmux("send-keys", "-t", pane, "Tab", "Tab", "Enter");
    await capture("Selected: parcel.commerce.api");
    await tmux("send-keys", "-t", pane, "0", "r");
    await delay(700);
    const event = toolActivity(directory, { source: "claude", session: "navigation-test" }, "api-edit", "Edit", { path: "src/api.ts" }, "started");
    await writeActivity(directory, event);
    await capture("[edit]");
    await tmux("send-keys", "-t", pane, "Enter");
    await capture("back 3");
    await delay(100);
    await tmux("send-keys", "-t", pane, "b");
    const restored = await capture("Selected: parcel.commerce.api");
    expect(restored).toContain("[edit]");
    await writeActivity(directory, { ...event, phase: "failed", time: Date.now() });
    expect(await capture("[failed]")).toContain("Selected: parcel.commerce.api");
    expect(await tmux("display-message", "-p", "-t", pane, "#{pane_pid}")).toBe(pid);
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test.each([
  { view: "checkout", initial: "parcel", rootChildren: 2, commerceChildren: 4 },
  { view: "services", initial: "customer", rootChildren: 3, commerceChildren: 5 },
])("Parcel $view groups remain selectable through pan, resize, and activity", async scenario => {
  const directory = await mkdtemp(join(tmpdir(), "c4view-groups-"));
  const socket = join(directory, "tmux.sock");
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("examples/parcel", directory, { recursive: true, filter: path => !path.includes(".cache") });
    await writeFile(join(directory, "c4view.activity.json"), JSON.stringify({ version: 1, project: "parcel", mappings: [
      { glob: "src/api.ts", element: "parcel.commerce.api" },
      { glob: "src/system.ts", element: "parcel.commerce" },
    ] }));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "groups-test", "-x", "120", "-y", "45",
      "-P", "-F", "#{pane_id}", process.execPath, resolve("src/cli.ts"), "view", scenario.view,
      "--workspace", directory, "--project", "parcel", "--session", "group-test", "--source", "claude");
    const capture = async (text: string) => {
      let output = "";
      for (let attempt = 0; attempt < 120; attempt++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (text.startsWith("Selected:") ? new RegExp(`${text.replace(/\./g, "\\.")}(?=\\s|$)`, "m").test(output) : output.includes(text)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${text}:\n${output}`);
    };
    const click = async (text: string, id: string) => {
      const output = await capture(text);
      const lines = output.split("\n");
      const y = lines.findIndex((line, index) => index >= 3 && line.includes(text));
      const x = lines[y]?.indexOf(text) ?? -1;
      expect(x).toBeGreaterThanOrEqual(0);
      await tmux("send-keys", "-t", pane, "-l", `\x1b[<0;${x + 2};${y + 1}M\x1b[<0;${x + 2};${y + 1}m`);
      return capture(`Selected: ${id}`);
    };
    const rootSelection = "Selected: parcel";
    const commerceSelection = "Selected: parcel.commerce";
    await capture(`Selected: ${scenario.initial}`);
    await delay(700);
    const initial = await click("Parcel", "parcel");
    expect(initial).toContain("Parcel");
    expect(initial).toContain("Commerce");
    await tmux("send-keys", "-t", pane, "Enter");
    await capture("Selected: parcel.storefront");
    await tmux("send-keys", "-t", pane, "BSpace");
    await capture(rootSelection);
    await tmux("send-keys", "-t", pane, "f");
    await delay(700);
    await click("Commerce", "parcel.commerce");
    await tmux("send-keys", "-t", pane, "Enter");
    await capture("Selected: parcel.commerce.api");
    await tmux("send-keys", "-t", pane, "Down", "Right");
    await tmux("resize-window", "-t", pane, "-x", "90", "-y", "36");
    await delay(700);
    await tmux("send-keys", "-t", pane, "BSpace");
    await capture(commerceSelection);
    await tmux("send-keys", "-t", pane, "0", "Enter");
    await delay(700);
    await tmux("send-keys", "-t", pane, "BSpace");
    await delay(700);
    await click("Checkout API", "parcel.commerce.api");
    await click("Commerce", "parcel.commerce");
    const binding = { source: "claude", session: "group-test" } satisfies Parameters<typeof toolActivity>[1];
    await writeActivity(directory, toolActivity(directory, binding, "api-edit", "Edit", { path: "src/api.ts" }, "started"));
    await writeActivity(directory, toolActivity(directory, binding, "group-read", "Read", { path: "src/system.ts" }, "started"));
    const active = await capture("Commerce [read]");
    expect(active).toContain("[edit]");
    expect(active).toContain("Checkout API");
    await click("Checkout API", "parcel.commerce.api");
    await tmux("send-keys", "-t", pane, "BSpace");
    await capture(commerceSelection);
    await tmux("send-keys", "-t", pane, "BSpace");
    await capture(rootSelection);
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
