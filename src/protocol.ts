import { Schema } from "effect";

export const protocols = ["auto", "kitty", "sixel", "blocks", "kitty-unicode"] as const;
export const Protocol = Schema.Literals(protocols);
export type Protocol = typeof Protocol.Type;
export const RenderMode = Schema.Literals(["native", "png"]);
export type RenderMode = typeof RenderMode.Type;

export function terminalProtocol(requested: Protocol, inTmux: boolean): Protocol {
  if (!inTmux) return requested;
  if (requested === "kitty" || requested === "sixel") {
    throw new Error(`${requested} image placement is not pane-safe with this OpenTUI/tmux integration. Use --protocol blocks, or run c4view view outside tmux.`);
  }
  return requested === "kitty-unicode" ? requested : "blocks";
}
