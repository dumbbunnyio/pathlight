import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, basename, join } from "node:path";
import { Config, Effect, Schema } from "effect";
import { hasCode, io, json, failure } from "./effects";
import { type Palette, palette } from "./ui";
import { bundledThemes } from "./themes";

// Themes use OpenCode's file format so its themes work here unchanged: `defs` names colours, and `theme` maps roles to a hex value,
// a name from `defs` or another role, an ANSI colour number, `transparent`, or `{ dark, light }`. Only the roles Pathlight draws with are
// read; the rest (diff, markdown, syntax) are ignored. Pathlight's own shades (grid, hot, pick, ...) are derived unless a theme sets them.
const Leaf = Schema.Union([Schema.String, Schema.Number]);
const ColorValue = Schema.Union([Leaf, Schema.Struct({ dark: Leaf, light: Leaf })]);
export const ThemeFile = Schema.Struct({
  defs: Schema.optionalKey(Schema.Record(Schema.String, ColorValue)),
  theme: Schema.Record(Schema.String, Schema.Union([ColorValue, Schema.Number, Schema.Undefined])),
});
export interface ThemeFile extends Schema.Schema.Type<typeof ThemeFile> {}
export type Mode = "dark" | "light";

const ansi16 = ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"];
const hexOf = (rgb: number[]) => `#${rgb.map(value => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0")).join("")}`;
const rgbOf = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
export const ansiHex = (code: number) => {
  if (code < 16) return ansi16[code]!;
  if (code < 232) {
    const index = code - 16, level = (value: number) => value === 0 ? 0 : value * 40 + 55;
    return hexOf([level(Math.floor(index / 36)), level(Math.floor(index / 6) % 6), level(index % 6)]);
  }
  return code < 256 ? hexOf(Array(3).fill((code - 232) * 10 + 8)) : "#000000";
};

/** `amount` of `over` laid on `base`. */
export const mix = (base: string, over: string, amount: number) => {
  const [a, b] = [rgbOf(base), rgbOf(over)];
  return hexOf(a.map((value, index) => value + (b[index]! - value) * amount));
};
export const distance = (a: string, b: string) => Math.hypot(...rgbOf(a).map((value, index) => value - rgbOf(b)[index]!));
export const luminance = (hex: string) => { const [r, g, b] = rgbOf(hex); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
const channel = (value: number) => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const relative = (hex: string) => { const [r, g, b] = rgbOf(hex); return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); };
export const contrast = (a: string, b: string) => { const [x, y] = [relative(a), relative(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

/** Resolve every role of a theme for one mode to `#rrggbb`; `undefined` is transparent. */
export const resolveRoles = (file: ThemeFile, mode: Mode) => {
  const defs = file.defs ?? {};
  // A colour with an alpha channel (`#rrggbbaa`) is laid over the theme's background, as the terminal would show it.
  let canvas = mode === "dark" ? "#000000" : "#ffffff";
  const resolve = (value: unknown, chain: readonly string[]): string | undefined => {
    if (typeof value === "number") return ansiHex(value);
    if (typeof value === "string") {
      if (value === "transparent" || value === "none") return undefined;
      if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
      if (/^#[0-9a-f]{8}$/i.test(value)) return mix(canvas, value.slice(0, 7).toLowerCase(), parseInt(value.slice(7), 16) / 255);
      if (/^#[0-9a-f]{3}$/i.test(value)) return `#${[...value.slice(1)].map(digit => digit + digit).join("")}`.toLowerCase();
      if (chain.includes(value)) throw new Error(`Circular colour reference: ${[...chain, value].join(" -> ")}`);
      const next = defs[value] ?? file.theme[value];
      if (next === undefined) throw new Error(`Colour reference "${value}" is not in defs or theme`);
      return resolve(next, [...chain, value]);
    }
    if (value && typeof value === "object" && mode in value) return resolve((value as Record<Mode, unknown>)[mode], chain);
    throw new Error(`Unusable colour value ${JSON.stringify(value)}`);
  };
  const background = file.theme.background === undefined ? undefined : resolve(file.theme.background, []);
  if (background) canvas = background;
  const roles: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(file.theme)) if (value !== undefined) roles[name] = resolve(value, []);
  return roles;
};

/** Pathlight's palette from a theme's roles. `canvas` stands in for a transparent background (the terminal's own, when known). */
export const derivePalette = (roles: Record<string, string | undefined>, mode: Mode, canvas?: string): Palette => {
  const dark = mode === "dark";
  const pick = (name: string, fallback: string) => roles[name] ?? fallback;
  const background = roles.background ?? canvas ?? (dark ? "#0e1116" : "#fafafa");
  const text = pick("text", dark ? "#eef1f5" : "#1a1a1a");
  const muted = pick("textMuted", mix(background, text, 0.55));
  const panel = pick("backgroundPanel", mix(background, text, 0.04));
  const element = pick("backgroundElement", mix(background, text, 0.1));
  const border = pick("borderActive", pick("border", mix(background, text, 0.3)));
  const rule = pick("borderSubtle", pick("border", mix(background, text, 0.15)));
  const accent = pick("accent", pick("primary", "#e8b45a"));
  const incoming = pick("info", pick("secondary", accent));
  // `incoming` (live, search) and `accent` (selection, focus) must stay apart; a theme that gives both the same colour loses the difference.
  const apart = distance(incoming, accent) < 60 ? pick("secondary", mix(incoming, dark ? "#ffffff" : "#000000", 0.35)) : incoming;
  return {
    background, panel, text, body: pick("body", mix(text, muted, 0.4)), muted, border, rule, accent, incoming: apart,
    outgoing: pick("warning", accent), purple: pick("secondary", accent), green: pick("success", "#86c48b"), failure: pick("error", "#e07a7a"),
    grid: pick("grid", mix(background, border, 0.2)), hot: pick("hot", mix(background, border, 0.15)), pick: pick("pick", mix(panel, apart, 0.25)),
    edgeDim: pick("edgeDim", mix(background, border, 0.65)), cardEdge: pick("cardEdge", rule), keycap: pick("keycap", mix(panel, border, 0.3)),
    scrim: pick("scrim", mix(background, "#000000", 0.4)), node: background, section: panel, command: muted,
  };
};

export interface ThemeEntry { readonly name: string; readonly file: ThemeFile; readonly source: "bundled" | "user" | "terminal" }

const decode = Schema.decodeUnknownEffect(ThemeFile);

/** Directories searched for user themes (`<dir>/themes/*.json`), later ones overriding earlier ones by name. */
export const themeDirectories = Effect.fn("Theme.directories")(function* (workspace: string) {
  const configHome = yield* Config.String("XDG_CONFIG_HOME").pipe(Config.withDefault(""));
  return [join(configHome || join(homedir(), ".config"), "pathlight"), join(workspace, ".pathlight")];
});

const readDirectory = Effect.fn("Theme.readDirectory")(function* (directory: string) {
  const entries = yield* io("Theme.list", () => readdir(join(directory, "themes"), { withFileTypes: true })).pipe(
    Effect.catchIf(error => hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR"), () => Effect.succeed([])));
  const found: ThemeEntry[] = [];
  for (const entry of entries.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && extname(entry.name) === ".json").sort((a, b) => a.name.localeCompare(b.name))) {
    // A broken theme file must not stop the viewer: it is skipped and the rest still load.
    const file = yield* io("Theme.read", () => readFile(join(directory, "themes", entry.name), "utf8")).pipe(
      Effect.flatMap(json), Effect.flatMap(decode), Effect.option);
    if (file._tag === "Some") found.push({ name: basename(entry.name, ".json"), file: file.value, source: "user" });
  }
  return found;
});

export const loadThemes = Effect.fn("Theme.load")(function* (workspace: string) {
  const themes = new Map<string, ThemeEntry>();
  for (const [name, raw] of Object.entries(bundledThemes)) themes.set(name, { name, file: yield* decode(raw), source: "bundled" });
  for (const directory of yield* themeDirectories(workspace)) for (const entry of yield* readDirectory(directory)) themes.set(entry.name, entry);
  return themes;
});

/** The palette for a named theme, or a failure naming the problem (a bad reference, say) so the picker can say so. */
export const paletteOf = (entry: ThemeEntry, mode: Mode, canvas?: string) => derivePalette(resolveRoles(entry.file, mode), mode, canvas);
export const paletteFor = (entry: ThemeEntry, mode: Mode, canvas?: string) => Effect.try({
  try: () => paletteOf(entry, mode, canvas),
  catch: cause => failure("Theme.resolve", cause),
});

// The chosen theme is remembered in `$XDG_CONFIG_HOME/pathlight/config.json` (only its name; nothing about any workspace).
const ThemeChoice = Schema.Struct({ theme: Schema.optionalKey(Schema.String) });
const configFile = Effect.fn("Theme.configFile")(function* () {
  const configHome = yield* Config.String("XDG_CONFIG_HOME").pipe(Config.withDefault(""));
  return join(configHome || join(homedir(), ".config"), "pathlight", "config.json");
});

export const savedTheme = Effect.fn("Theme.saved")(function* () {
  const file = yield* configFile();
  const text = yield* io("Theme.readChoice", () => readFile(file, "utf8")).pipe(Effect.catchIf(error => hasCode(error, "ENOENT"), () => Effect.succeed("")));
  if (!text) return undefined;
  return (yield* json(text).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ThemeChoice)), Effect.option)).pipe(option => option._tag === "Some" ? option.value.theme : undefined);
});

export const saveTheme = Effect.fn("Theme.save")(function* (name: string) {
  const file = yield* configFile();
  yield* io("Theme.writeChoice", async () => {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, `${JSON.stringify({ theme: name }, null, 2)}\n`);
  });
});

export const themeFromEnvironment = Effect.fn("Theme.environment")(function* () {
  const name = yield* Config.String("PATHLIGHT_THEME").pipe(Config.withDefault(""));
  const mode = yield* Config.String("PATHLIGHT_MODE").pipe(Config.withDefault(""));
  return { name, mode: mode === "light" || mode === "dark" ? mode : undefined } as { name: string; mode: Mode | undefined };
});

/**
 * "system": the terminal's own colours, as OpenCode's system theme does. Its background and foreground are used as they are, the accents
 * come from its ANSI colours, and the shades between are blended from those, so Pathlight looks like part of whatever terminal it is in.
 */
export const systemTheme = (colors: { palette: readonly (string | null)[]; defaultForeground: string | null; defaultBackground: string | null }): ThemeEntry => {
  const colour = (index: number) => colors.palette[index] ?? ansiHex(index);
  const background = colors.defaultBackground ?? colour(0), text = colors.defaultForeground ?? colour(7);
  return { name: "system", source: "terminal", file: { theme: {
    background, text, primary: colour(3), accent: colour(3), secondary: colour(5), info: colour(6), warning: colour(3), success: colour(2), error: colour(1),
  } } };
};

/** Light or dark from the terminal's background, when it told us. */
export const modeOf = (background: string | undefined): Mode | undefined => background ? (luminance(background) > 0.5 ? "light" : "dark") : undefined;

export { palette };
