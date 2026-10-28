import { posix } from "node:path";
import { Effect } from "effect";
import type { ImportRef } from "../scan-imports";
import type { FrontEnd, Resolution, Workspace } from "./index";
import file from "./grammars/tree-sitter-python.wasm" with { type: "file" };
import { descendants, grammar } from "./tree-sitter";

const parser = grammar(file);

function imports(source: string): ImportRef[] {
  const found: ImportRef[] = [];
  for (const node of descendants(parser.parse(source))) {
    const line = node.startPosition.row + 1;
    if (node.type === "import_statement") {
      for (const name of node.childrenForFieldName("name")) if (name) found.push({ specifier: (name.type === "aliased_import" ? name.childForFieldName("name")! : name).text, line, kind: "import" });
    } else if (node.type === "import_from_statement") found.push({ specifier: node.childForFieldName("module_name")!.text, line, kind: "import" });
  }
  return found;
}

const resolver = (workspace: Workspace) => Effect.succeed((from: string, { specifier }: ImportRef): Resolution => {
  const level = /^\.*/.exec(specifier)![0].length;
  let base = level ? posix.dirname(from) : "";
  for (let up = 1; up < level; up++) base = posix.dirname(base);
  const module = specifier.slice(level).split(".").filter(Boolean).join("/");
  const stem = [base === "." ? "" : base, module].filter(Boolean).join("/");
  for (const candidate of [`${stem}.py`, `${stem}/__init__.py`]) if (workspace.files.has(candidate)) return { files: [{ to: candidate }] };
  return level ? { unresolved: "not-found" } : { external: specifier.split(".")[0]! };
});

export const python: FrontEnd = {
  languages: { ".py": "python" },
  load: parser.load,
  imports,
  exports: () => [],
  declaration: () => undefined,
  resolver,
};
