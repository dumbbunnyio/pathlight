/**
 * The character cell, the rhythm of the page (plan 4d, "The look", 1): one monospace face, the system's (nothing is downloaded), measured once.
 * A cell is a character's advance wide and twice that tall, the terminal's aspect, so the server's compact fit and routes, made for a cell of
 * 16 by 32 world units, apply unchanged. Every text element sits on this grid.
 */
export const fontFamily = `ui-monospace, "SF Mono", "Cascadia Mono", "JetBrains Mono", "DejaVu Sans Mono", "Liberation Mono", Menlo, Consolas, monospace`;
export const fontSize = 14;

export interface Cell { w: number; h: number }

export const measureCell = (): Cell => {
  const probe = document.createElement("span");
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${fontSize}px ${fontFamily}`;
  probe.textContent = "M".repeat(200);
  document.body.append(probe);
  const w = probe.getBoundingClientRect().width / 200;
  probe.remove();
  const width = w > 0 ? w : fontSize * 0.6;
  return { w: width, h: width * 2 };
};

/** World units in a cell at 100%. */
export const world = { x: 16, y: 32 };
