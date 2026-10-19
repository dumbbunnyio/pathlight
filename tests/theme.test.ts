import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigProvider, Effect } from "effect";
import { derivePalette, loadThemes, modeOf, paletteOf, resolveRoles, systemTheme, themeDirectories, type ThemeFile } from "../src/theme";

const file = (theme: ThemeFile["theme"], defs?: ThemeFile["defs"]): ThemeFile => ({ theme, ...(defs ? { defs } : {}) });

test("every bundled theme resolves to a complete palette in both modes", async () => {
  const themes = await Effect.runPromise(loadThemes("/nonexistent-workspace"));
  expect(themes.size).toBeGreaterThanOrEqual(30);
  for (const [name, entry] of themes) for (const mode of ["dark", "light"] as const) {
    const palette = paletteOf(entry, mode);
    for (const [role, value] of Object.entries(palette)) expect(value, `${name}/${mode}/${role}`).toMatch(/^#[0-9a-f]{6}$/);
  }
});

test("the pathlight theme reproduces the original palette exactly", async () => {
  const themes = await Effect.runPromise(loadThemes("/nonexistent-workspace"));
  expect(paletteOf(themes.get("pathlight")!, "dark")).toEqual({
    background: "#0e1116", panel: "#11151b", text: "#eef1f5", body: "#c9d0da", muted: "#7d8796", border: "#4f5866", rule: "#2b3441",
    accent: "#e8b45a", incoming: "#6fcad6", outgoing: "#e8b45a", purple: "#7466b0", green: "#86c48b", failure: "#e07a7a",
    grid: "#1a2029", hot: "#1a212b", pick: "#294052", edgeDim: "#3a4352", cardEdge: "#2b3441", keycap: "#26323f", scrim: "#080b10",
    node: "#0e1116", section: "#11151b", command: "#7d8796",
  });
});

test("references, ansi numbers, modes, alpha and transparency resolve as OpenCode's themes expect", () => {
  const roles = resolveRoles(file({
    background: "base", text: { dark: "#ffffff", light: "#000000" }, textMuted: "text", primary: 1, border: "#fff", warning: "#ff000080", info: "transparent",
  }, { base: "#102030" }), "dark");
  expect(roles).toMatchObject({ background: "#102030", text: "#ffffff", textMuted: "#ffffff", primary: "#800000", border: "#ffffff", info: undefined });
  expect(roles.warning).toBe("#881018");
  expect(resolveRoles(file({ text: { dark: "#ffffff", light: "#000000" } }), "light").text).toBe("#000000");
});

test("a bad reference or a cycle is an error naming it", () => {
  expect(() => resolveRoles(file({ text: "nowhere" }), "dark")).toThrow('"nowhere"');
  expect(() => resolveRoles(file({ text: "muted", muted: "text" }), "dark")).toThrow(/Circular/);
});

test("a transparent background falls back to the terminal's, and incoming stays apart from accent", () => {
  const roles = resolveRoles(file({ background: "transparent", text: "#ffffff", primary: "#e8b45a", info: "#e8b45b", secondary: "#6fcad6" }), "dark");
  const palette = derivePalette(roles, "dark", "#202020");
  expect(palette.background).toBe("#202020");
  expect(palette.incoming).toBe("#6fcad6");
});

test("user themes are found in the config and workspace directories, and a broken file is skipped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pathlight-themes-"));
  try {
    const config = join(directory, "config"), workspace = join(directory, "work");
    await mkdir(join(config, "pathlight", "themes"), { recursive: true });
    await mkdir(join(workspace, ".pathlight", "themes"), { recursive: true });
    await writeFile(join(config, "pathlight", "themes", "mine.json"), JSON.stringify({ theme: { background: "#111111", text: "#eeeeee" } }));
    await writeFile(join(config, "pathlight", "themes", "broken.json"), "{ nope");
    await writeFile(join(workspace, ".pathlight", "themes", "nord.json"), JSON.stringify({ theme: { background: "#010203" } }));
    const provided = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { XDG_CONFIG_HOME: config } })));
    expect((await Effect.runPromise(provided(themeDirectories(workspace))))[0]).toBe(join(config, "pathlight"));
    const themes = await Effect.runPromise(provided(loadThemes(workspace)));
    expect(themes.get("mine")?.source).toBe("user");
    expect(themes.has("broken")).toBe(false);
    // The workspace copy replaces the bundled theme of the same name.
    expect(themes.get("nord")?.source).toBe("user");
    expect(themes.get("dracula")?.source).toBe("bundled");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("system takes the terminal's own colours and is light or dark with its background", () => {
  const ansi = ["#1d1f21", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#c5c8c6"];
  const dark = systemTheme({ palette: ansi, defaultForeground: "#c5c8c6", defaultBackground: "#1d1f21" });
  expect(dark.source).toBe("terminal");
  expect(paletteOf(dark, "dark")).toMatchObject({ background: "#1d1f21", text: "#c5c8c6", accent: "#f0c674", incoming: "#8abeb7", green: "#b5bd68", failure: "#cc6666", purple: "#b294bb" });
  // Entries the terminal did not report come from the standard ANSI table.
  expect(paletteOf(systemTheme({ palette: [], defaultForeground: null, defaultBackground: "#ffffff" }), "light").failure).toBe("#800000");
  expect(modeOf("#1d1f21")).toBe("dark");
  expect(modeOf("#fdf6e3")).toBe("light");
  expect(modeOf(undefined)).toBeUndefined();
});
