import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { composeConnectors, terminalConnectors } from "../src/connectors";
import { run } from "./effects";

test("terminal arrows stay outside node boxes and respect head and tail markers", () => {
  const nodes = [
    { x: 1, y: 1, width: 3, height: 3, children: [] },
    { x: 8, y: 1, width: 3, height: 3, children: [] },
  ];
  const routes = terminalConnectors({ bounds: { x: 0, y: 0 }, edges: [
    { points: [[0, 32], [128, 32], [128, 32], [128, 32]], head: "normal", tail: "normal" },
    { points: [[0, 32], [128, 32]], head: "none", tail: "none" },
    { points: [[0, 32], [128, 32]], head: "diamond", tail: "odot" },
  ] }, nodes);
  expect(routes[0]?.cells.map(cell => [cell.x, cell.y, cell.glyph, cell.strong])).toEqual([
    [4, 2, "─", "━"], [5, 2, "─", "━"], [6, 2, "─", "━"], [7, 2, "─", "━"],
  ]);
  expect(routes[0]?.arrows.map(cell => [cell.x, cell.y, cell.glyph])).toEqual([[4, 2, "◀"], [7, 2, "▶"]]);
  expect(routes[1]?.arrows).toEqual([]);
  expect(routes[2]?.arrows.map(cell => cell.glyph)).toEqual(["○", "◆"]);
});

test("Bezier routes follow the curve rather than control polygon and remain visible inside groups", () => {
  const [route] = terminalConnectors({ bounds: { x: 0, y: 0 }, edges: [
    { points: [[0, 0], [0, 320], [320, 320], [320, 0]], head: "normal" },
  ] }, [{ x: 1, y: 0, width: 24, height: 14, children: ["child"] }]);
  expect(route?.cells.some(cell => cell.x === 12 && cell.y >= 8 && /[\u2801-\u28ff]/.test(cell.glyph))).toBe(true);
  expect(Math.max(...route?.cells.map(cell => cell.y) ?? [])).toBe(9);
  expect(route?.arrows).toEqual([]);
});

test("arrowheads on curved connectors are dots on the line, so the tip is centred on it", () => {
  const curve = (head: "none" | "normal") => terminalConnectors({ bounds: { x: 0, y: 0 }, edges: [
    { points: [[0, 0], [100, 60], [200, 120], [320, 200]] satisfies [number, number][], head },
  ] } as never, [])[0];
  const bare = curve("none"), headed = curve("normal");
  expect(headed?.arrows).toEqual([]);
  expect(headed?.cells.length).toBeGreaterThan(bare?.cells.length ?? 0);
  expect(headed?.cells.every(cell => /[\u2800-\u28ff]/.test(cell.glyph))).toBe(true);
  // Straight axis-aligned connectors keep their glyph arrowhead.
  const [straight] = terminalConnectors({ bounds: { x: 0, y: 0 }, edges: [{ points: [[0, 32], [128, 32]], head: "normal" }] }, []);
  expect(straight?.arrows.map(cell => cell.glyph)).toEqual(["▶"]);
});

test("zoomed horizontal connectors meet their arrowheads on the same row outside node borders", () => {
  for (const { zoom, width, target, row, columns } of [
    { zoom: 0.5, width: 2, target: 6, row: 2, columns: [4, 5] },
    { zoom: 1, width: 4, target: 10, row: 2, columns: [6, 7, 8, 9] },
    { zoom: 1.5, width: 6, target: 14, row: 3, columns: [8, 9, 10, 11, 12, 13] },
  ]) {
    const routes = terminalConnectors({ bounds: { x: 0, y: 0 }, edges: [
      { source: "a", target: "b", points: [[0, 32], [128, 32]], head: "normal" },
    ] }, [{ x: 2, y: 1, width, height: 4, children: [] },
      { x: target, y: 1, width, height: 4, children: [] }], zoom);
    const cells = [...composeConnectors(routes, undefined)];
    expect(cells.map(cell => [cell.x, cell.y])).toEqual(columns.map(x => [x, row]));
    expect(cells.map(cell => cell.glyph).join("")).toBe("─".repeat(columns.length - 1) + "▶");
  }
});

test("straight curves on half-cell boundaries remain straight and continuous", () => {
  const [horizontal, vertical] = terminalConnectors({ bounds: { x: 0, y: 0 }, edges: [
    { points: [[0, 16], [80, 16], [240, 16], [320, 16]] },
    { points: [[8, 0], [8, 160], [8, 480], [8, 640]] },
  ] }, []);
  expect([...new Set(horizontal?.cells.map(cell => cell.y))]).toEqual([2]);
  expect([...new Set(horizontal?.cells.map(cell => cell.glyph))]).toEqual(["─"]);
  expect(horizontal?.cells.map(cell => cell.x)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
  expect([...new Set(vertical?.cells.map(cell => cell.x))]).toEqual([3]);
  expect([...new Set(vertical?.cells.map(cell => cell.glyph))]).toEqual(["│"]);
  expect(vertical?.cells.map(cell => cell.y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
});

test("diagonals combine Braille dots within cells and leave node interiors clear", () => {
  const diagram = { bounds: { x: 0, y: 0 }, edges: [
    { points: [[0, 0], [16, 32]] satisfies [[number, number], ...[number, number][]], head: "none" as const },
  ] };
  const [open] = terminalConnectors(diagram, []);
  expect(open?.cells.map(cell => [cell.x, cell.y, cell.glyph])).toEqual([
    [2, 1, "⠠"], [3, 1, "⡀"], [3, 2, "⠱"],
  ]);
  const [clipped] = terminalConnectors(diagram, [{ x: 3, y: 2, width: 1, height: 1, children: [] }]);
  expect(clipped?.cells.map(cell => [cell.x, cell.y, cell.glyph])).toEqual([
    [2, 1, "⠠"], [3, 1, "⡀"],
  ]);
});

test("crossing curves retain both dot patterns when selection changes", () => {
  const routes = terminalConnectors({ bounds: { x: 0, y: 0 }, edges: [
    { source: "a", target: "b", points: [[0, 0], [16, 32]], head: "none" },
    { source: "c", target: "d", points: [[0, 32], [16, 0]], head: "none" },
  ] }, []);
  for (const selected of [undefined, "a", "b", "c", "d"]) {
    const crossing = [...composeConnectors(routes, selected)].find(cell => cell.x === 3 && cell.y === 1);
    const quiet = 0xe0; // the quiet-stroke dots of both curves in this cell
    expect((crossing?.glyph.codePointAt(0) ?? 0) & quiet).toBe(quiet);
    expect(crossing?.glyph).toBe(selected === undefined ? "⣠" : crossing?.glyph);
    expect(crossing?.emphasis).toBe(selected === undefined ? "none" : selected === "a" || selected === "c" ? "outgoing" : "incoming");
  }
});

test("native relationship emphasis follows selection and long labels wrap and scroll without panning the diagram", async () => {
  const directory = await mkdtemp(join(tmpdir(), "c4view-relations-"));
  const socket = join(directory, "tmux.sock");
  const tmux = (...args: string[]) => run("tmux", ["-S", socket, ...args]);
  try {
    await cp("tests/fixtures/viewer", directory, { recursive: true });
    const model = join(directory, "model.c4");
    await writeFile(model, (await readFile(model, "utf8")).replace("Records tool lifecycle",
      "Records tool lifecycle with workspace attribution and bounded retention so each agent session remains separate. " +
      "Long relationship descriptions must remain readable while the diagram stays stationary. ".repeat(8)));
    const pane = await tmux("-f", "/dev/null", "new-session", "-d", "-s", "relations-test", "-x", "180", "-y", "24",
      "-P", "-F", "#{pane_id}", process.execPath, resolve("src/cli.ts"), "view", "live", "--workspace", directory, "--project", "viewer");
    const capture = async (text: string) => {
      let output = "";
      for (let i = 0; i < 120; i++) {
        output = await tmux("capture-pane", "-p", "-t", pane);
        if (output.includes(text)) return output;
        await delay(50);
      }
      throw new Error(`Missing ${text}:\n${output}`);
    };
    await capture("→ Activity metadata");
    await delay(700);
    const initial = await tmux("capture-pane", "-p", "-t", pane);
    const connectorColors = async () => {
      const colors = new Set<string>();
      let foreground = "";
      for (const match of (await tmux("capture-pane", "-e", "-p", "-t", pane)).matchAll(/\x1b\[([0-9;]*)m|([\u2801-\u28ff])/g)) {
        if (match[2]) colors.add(foreground);
        else {
          const codes = match[1]!.split(";").map(Number);
          for (let i = 0; i < codes.length; i++) {
            if (codes[i] === 38 && codes[i + 1] === 2) { foreground = codes.slice(i + 2, i + 5).join(";"); i += 4; }
            else if (codes[i] === 48 && codes[i + 1] === 2) i += 4;
            else if (codes[i] === 0 || codes[i] === 39) foreground = "";
          }
        }
      }
      return colors;
    };
    expect(initial).toContain("Records tool lifecycle");
    expect(initial).toMatch(/[\u2801-\u28ff]/);
    expect(initial).toMatch(/[▶◀▲▼]/);
    expect(await connectorColors()).toContain("233;189;112");
    const diagram = (text: string) => text.split("\n").slice(3, 22).map(line => line.padEnd(180).slice(0, 135)).join("\n");
    const before = diagram(initial);
    await tmux("send-keys", "-t", pane, "-l", "\x1b[<65;165;20M");
    await delay(200);
    const wheeled = await tmux("capture-pane", "-p", "-t", pane);
    expect(wheeled).not.toBe(initial);
    expect(diagram(wheeled)).toBe(before);
    await tmux("send-keys", "-t", pane, "pagedown");
    await delay(200);
    const paged = await tmux("capture-pane", "-p", "-t", pane);
    expect(paged).not.toBe(wheeled);
    expect(paged).toContain("Selected: plugin");
    const after = diagram(await tmux("capture-pane", "-p", "-t", pane));
    expect(after).toBe(before);
    expect(paged).toContain("Opens a view");
    await tmux("send-keys", "-t", pane, "/");
    await tmux("send-keys", "-t", pane, "-l", "activity");
    await capture("Search 1/1");
    await tmux("send-keys", "-t", pane, "Enter");
    expect(await capture("← Agent adapters")).toContain("Selected: activity");
    await delay(700);
    expect(await connectorColors()).toContain("104;207;218");
    await tmux("send-keys", "-t", pane, "q");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
