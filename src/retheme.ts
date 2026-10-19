import { BaseRenderable, RGBA, rgbToHex } from "@opentui/core";
import type { Palette } from "./ui";

/**
 * Recolours existing widgets when the theme changes. Widgets are built with palette colours that OpenTUI copies, so each colour a widget
 * holds is matched to the role it was drawn from (the palette keeps one distinct colour per role, see `setPalette`) and set to that role's
 * new colour through the widget's own setter. Text content is rebuilt by the viewer's normal update.
 */
export const retheme = (roots: readonly BaseRenderable[], from: Palette, to: Palette) => {
  const map = new Map<string, string>();
  for (const key of Object.keys(from) as (keyof Palette)[]) map.set(from[key].toLowerCase(), to[key]);
  const seen = new Set<unknown>();
  const visit = (node: unknown) => {
    if (!(node instanceof BaseRenderable) || seen.has(node)) return;
    seen.add(node);
    const record = node as unknown as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (value instanceof RGBA && key.startsWith("_") && value.a > 0) {
        const next = map.get(rgbToHex(value).toLowerCase());
        // Text keeps its colours as `_defaultFg` / `_defaultBg` behind `fg` / `bg`; everything else is `_name` behind `name`.
        const name = key.startsWith("_default") ? key.charAt(8).toLowerCase() + key.slice(9) : key.slice(1);
        // OpenTUI's borderColor setter switches all four borders on for a box that has none, so borderless boxes are left alone.
        if (next && name in node && !(name === "borderColor" && record._border === false)) {
          try { record[name] = next; } catch { /* a getter-only mirror of another colour */ }
        }
      } else if (value instanceof BaseRenderable) visit(value);
    }
    for (const child of node.getChildren()) visit(child);
  };
  for (const root of roots) visit(root);
};
