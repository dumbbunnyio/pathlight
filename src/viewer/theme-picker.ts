import { type Renderable, StyledText, type createCliRenderer } from "@opentui/core";
import { Effect } from "effect";
import { io } from "../effects";
import { retheme } from "../retheme";
import { type Mode, modeOf, paletteOf, saveTheme, systemTheme, type ThemeEntry } from "../theme";
import { borderHints, palette, setPalette } from "../ui";
import { hints } from "./keys";
import { themeContent } from "./pickers";
import type { createWidgets } from "./widgets";

/**
 * Themes (`T`): the palette is swapped in place and every widget recoloured, so moving through the picker previews each one live; Enter keeps and
 * saves it, Esc puts the one you had back. The terminal's own colours are asked for once, in the background (OSC queries; tmux must pass them
 * through). Until they arrive, or if they never do, `system` is simply absent from the picker. They also decide light or dark for themes with both,
 * unless PATHLIGHT_MODE says otherwise (`fixedMode`).
 */
export function createThemePicker(options: {
  renderer: Awaited<ReturnType<typeof createCliRenderer>>; picker: ReturnType<typeof createWidgets>["picker"]; recolour: () => Renderable[];
  themes: Map<string, ThemeEntry>; names: string[]; order: (a: string, b: string) => number; name: string; mode: Mode; wanted: string; fixedMode: boolean;
  say: (message: string) => void; redraw: () => void; update: () => void; run: (effect: Effect.Effect<void>) => unknown; closing: () => boolean;
}) {
  const { renderer, picker, themes, names } = options;
  let name = options.name, mode = options.mode, index = 0, base = name, top = 0;
  const apply = (next: string) => {
    const entry = themes.get(next);
    if (!entry) return false;
    let colours: ReturnType<typeof paletteOf>;
    try { colours = paletteOf(entry, mode); } catch (error) { options.say(`Theme ${next} cannot be used: ${error instanceof Error ? error.message : String(error)}`); options.update(); return false; }
    const before = { ...palette };
    setPalette(colours);
    retheme(options.recolour(), before, palette);
    renderer.setBackgroundColor(palette.background);
    name = next; options.redraw();
    return true;
  };
  const rows = () => Math.max(3, Math.min(names.length, renderer.height - 8));
  const render = () => {
    const shown = rows();
    if (index < top) top = index;
    if (index >= top + shown) top = index - shown + 1;
    const made = themeContent(names, { index, top, rows: shown, base, mode, source: theme => themes.get(theme)?.source ?? "bundled",
      preview: theme => { const entry = themes.get(theme); if (!entry) return undefined; try { return paletteOf(entry, mode); } catch { return undefined; } } });
    picker.content.content = made.content; picker.meta.content = made.meta;
    picker.foot.content = new StyledText(borderHints(hints.themes));
    picker.place(Math.min(64, renderer.width - 4), shown + 4);
  };
  const move = (to: number) => { index = (to + names.length) % names.length; apply(names[index]!); render(); };
  options.run(io("Native.terminalColors", () => renderer.getPalette({ timeout: 1000 })).pipe(
    Effect.flatMap(colors => Effect.sync(() => {
      if (options.closing() || !colors.defaultBackground) return;
      themes.set("system", systemTheme(colors));
      names.splice(0, names.length, ...[...themes.keys()].sort(options.order));
      const detected = options.fixedMode ? undefined : modeOf(colors.defaultBackground);
      if (detected && detected !== mode) mode = detected;
      if (picker.visible) { render(); return; }
      if (options.wanted === "system" || detected) apply(options.wanted === "system" ? "system" : name);
    })),
    Effect.catch(() => Effect.void)));
  return {
    begin() { base = name; index = Math.max(0, names.indexOf(name)); top = 0; picker.open(Math.min(64, renderer.width - 4), rows() + 4); render(); options.update(); },
    move(to: "up" | "down" | "pageup" | "pagedown" | "home" | "end") {
      move({ up: index - 1, down: index + 1, pageup: Math.max(0, index - rows()), pagedown: Math.min(names.length - 1, index + rows()), home: 0, end: names.length - 1 }[to]);
    },
    cancel() { picker.close(); if (name !== base) apply(base); options.update(); },
    keep() {
      picker.close(); base = name; options.say(`Theme: ${name}`);
      options.run(saveTheme(name).pipe(Effect.catch(error => Effect.sync(() => { options.say(`Theme ${name} is in use but was not saved: ${error.message}`); options.update(); }))));
      options.update();
    },
  };
}
