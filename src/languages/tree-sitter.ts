import { Language, Parser, type Node, type Tree } from "web-tree-sitter";
import runtime from "./grammars/tree-sitter.wasm" with { type: "file" };

export type { Node };

/**
 * A tree-sitter grammar compiled into the binary (`with { type: "file" }` embeds the `.wasm`, so nothing is read from a checkout or downloaded).
 * The runtime and each grammar are loaded once per process, the first time a file of that language is read; a scan of a workspace with no file
 * in the language never loads it.
 */
const bytes = async (path: string) => new Uint8Array(await Bun.file(path).arrayBuffer());
let started: Promise<void> | undefined;
const start = () => started ??= (async () => Parser.init({ wasmBinary: await bytes(runtime) } as Parameters<typeof Parser.init>[0]))();

export function grammar(file: string) {
  let parser: Parser | undefined, loading: Promise<void> | undefined;
  // The last tree, kept because a scan asks for a file's imports and then its exports: one parse serves both. Trees live in the runtime's memory, so the
  // one replaced is freed.
  let last: { source: string; tree: Tree } | undefined;
  return {
    load: () => loading ??= (async () => {
      await start();
      const next = new Parser();
      next.setLanguage(await Language.load(await bytes(file)));
      parser = next;
    })(),
    /** The syntax tree's root. `load` must have finished. */
    parse(source: string): Node {
      if (last?.source === source) return last.tree.rootNode;
      if (!parser) throw new Error(`The grammar ${file} is not loaded.`);
      const tree = parser.parse(source);
      if (!tree) throw new Error(`The grammar ${file} could not parse the file.`);
      last?.tree.delete();
      last = { source, tree };
      return tree.rootNode;
    },
  };
}

/** Every node under `node` (itself included) in source order, without recursion: a long file is deep. */
export function* descendants(node: Node): Generator<Node> {
  const cursor = node.walk();
  try {
    for (let depth = 0; ;) {
      yield cursor.currentNode;
      if (cursor.gotoFirstChild()) { depth++; continue; }
      while (depth > 0 && !cursor.gotoNextSibling()) { cursor.gotoParent(); depth--; }
      if (depth === 0) return;
    }
  } finally { cursor.delete(); }
}
