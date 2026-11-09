import { For, Show } from "solid-js";
import type { Frame } from "../web/wire";
import { Line, Lines } from "./spans";

/**
 * The inspector (plan 4d, "The look", 5): the terminal's words for the selection, line for line. Its name, then what it is and the words about
 * it, a blank row, then Connects: its header and one row per relationship, who calls it first. A row that names a box selects it on a click,
 * as Enter on the terminal's Connects cursor shows it in the diagram.
 */
export const Inspector = (props: { frame: Frame; select: (id: string) => void }) => {
  const inspector = () => props.frame.inspector;
  return (
    <div class="inspector-body">
      <Line spans={inspector().title} />
      <Lines lines={inspector().what} />
      <Lines lines={inspector().about} />
      <div class="line" />
      <Show when={inspector().work}>{work => (
        <>
          <Line spans={work().header} />
          <Lines lines={work().lines} />
          <div class="line" />
        </>
      )}</Show>
      <Line spans={inspector().connects.header} />
      <For each={inspector().connects.lines}>{(line, index) => {
        const node = () => inspector().connects.rows[index()] ?? null;
        return <Line spans={line} class={node() ? "row" : undefined} onClick={() => { const id = node(); if (id) props.select(id); }} />;
      }}</For>
    </div>
  );
};
