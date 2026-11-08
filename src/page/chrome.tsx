import { For, Show } from "solid-js";
import type { Frame, RailRow } from "../web/wire";
import { Line, Lines, Spans } from "./spans";

/**
 * The frame around the diagram (plan 4d, "The look", 2), text on the background as in the terminal: header line 1 where you are with its
 * right-hand side, line 2 the box count, a rule; the footer answering only the person's own keys; `?` as the terminal's help. The views rail is
 * the page's own, in the words of the terminal's view picker.
 */
export const Header = (props: { frame: Frame }) => (
  <header class="header">
    <div class="line split"><span><Spans spans={[{ text: " " }, ...props.frame.header.line1]} /></span><span><Spans spans={props.frame.header.badge} /></span></div>
    <Line spans={[{ text: " " }, ...props.frame.header.line2]} />
  </header>
);

export const Footer = (props: { frame: Frame }) => (
  <footer class="footer line split">
    <span><Spans spans={[{ text: " " }, ...props.frame.footer.left]} /></span>
    <span><Spans spans={[...props.frame.footer.right, { text: " " }]} /></span>
  </footer>
);

/** The views, the one shown marked; a click opens one. */
export const Rail = (props: { rows: readonly RailRow[]; current: string; open: (view: string) => void }) => (
  <nav class="rail">
    <For each={props.rows}>{row => (
      <div class="line row" classList={{ here: row.view === props.current }} title={row.holder ? `${row.holder} / ${row.name}` : row.name} onClick={() => props.open(row.view)}>
        <span class="mark">{row.view === props.current ? "› " : "  "}</span><span class="name">{row.name}</span><span class="detail">{row.detail}</span>
      </div>
    )}</For>
  </nav>
);

/** `?`: the terminal's help frame, for the keys the page has. */
export const Help = (props: { frame: Frame; close: () => void }) => (
  <div class="scrim" onClick={props.close}>
    <div class="help" onClick={event => event.stopPropagation()}>
      <div class="line split frame-top"><span>◆ Keyboard shortcuts</span><span><Spans spans={props.frame.help.meta} /></span></div>
      <div class="help-body"><Lines lines={props.frame.help.lines} /></div>
      <div class="line frame-foot"><span class="key">esc</span> close</div>
    </div>
  </div>
);

/** Under 80 columns: the node list in place of the diagram. */
export const NodeList = (props: { frame: Frame; select: (id: string) => void }) => (
  <Show when={props.frame.list}>{list => (
    <div class="node-list">
      <For each={list().lines}>{(line, index) => <Line spans={line} class="row" onClick={() => { const id = list().ids[index()]; if (id) props.select(id); }} />}</For>
    </div>
  )}</Show>
);
