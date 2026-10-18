import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { editorFile, nodeFiles } from "./effects";

test("mapped files are direct, deduplicated, and bounded to regular workspace files", async () => {
  const root = await mkdtemp(join(tmpdir(), "c4view-files-"));
  const workspace = join(root, "workspace");
  try {
    for (const directory of ["src", ".hidden", ".git", ".cache", "node_modules"]) {
      await mkdir(join(workspace, directory), { recursive: true });
      await writeFile(join(workspace, directory, "a.ts"), "");
    }
    await writeFile(join(root, "outside.ts"), "");
    await symlink(join(root, "outside.ts"), join(workspace, "src", "link.ts"));
    const files = await nodeFiles(workspace, { version: 1, project: "viewer", mappings: [
      { element: "parent.child", glob: "src/**" },
      { element: "parent.child", glob: "src/a.ts" },
      { element: "other", glob: "**/*.ts" },
    ] });
    expect(files.get("parent.child")).toEqual(["src/a.ts"]);
    expect(files.get("parent")).toBeUndefined();
    expect(files.get("other")).toEqual([".hidden/a.ts", "src/a.ts"]);
    expect(await editorFile(workspace, "src/a.ts")).toBe(join(workspace, "src/a.ts"));
    await expect(editorFile(workspace, "src/link.ts")).rejects.toThrow("outside this workspace");
    await expect(editorFile(workspace, "../outside.ts")).rejects.toThrow("outside this workspace");
    await expect(editorFile(workspace, "src")).rejects.toThrow("not a regular file");
  } finally { await rm(root, { recursive: true, force: true }); }
});
