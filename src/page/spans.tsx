import { For, type JSX } from "solid-js";
import type { Span } from "../web/wire";

/** The style of one span: its color, its background (a pill or a cursor row) and its weight. */
const styleOf = (span: Span): JSX.CSSProperties => ({ color: span.fg, background: span.bg, "font-weight": span.bold ? "bold" : undefined });

/** Spans as text: the server's words, drawn as they come. */
export const Spans = (props: { spans: readonly Span[] }) => (
  <For each={props.spans}>{span => <span style={styleOf(span)}>{span.text}</span>}</For>
);

/** One line of the grid: a cell tall, no wrapping, cut at the edge. */
export const Line = (props: { spans: readonly Span[]; class?: string; onClick?: () => void; title?: string }) => (
  <div class={`line${props.class ? ` ${props.class}` : ""}`} onClick={props.onClick} title={props.title}><Spans spans={props.spans} /></div>
);

/** Lines of spans, each a cell tall. */
export const Lines = (props: { lines: readonly (readonly Span[])[] }) => <For each={props.lines}>{line => <Line spans={line} />}</For>;

/** Spans as SVG text runs, for a card's label. */
export const Runs = (props: { spans: readonly Span[] }) => (
  <For each={props.spans}>{span => <tspan fill={span.fg} font-weight={span.bold ? "bold" : undefined}>{span.text}</tspan>}</For>
);

export const textOf = (spans: readonly Span[]) => spans.map(span => span.text).join("");
