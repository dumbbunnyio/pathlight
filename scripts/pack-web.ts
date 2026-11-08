// Packs the Rune page built in DIR (index.html, boot.js, app.js, app_bg.wasm and wasm-bindgen's snippets) into OUT, each file gzipped,
// as src/web/page.ts reads it. Run by scripts/build-web.sh.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "../src/web/page";

const [dir, out] = process.argv.slice(2);
if (!dir || !out) throw new Error("Usage: bun scripts/pack-web.ts DIR OUT");
const walk = async (folder: string): Promise<string[]> => (await Promise.all((await readdir(folder, { withFileTypes: true }))
  .map(entry => entry.isDirectory() ? walk(join(folder, entry.name)) : Promise.resolve([join(folder, entry.name)])))).flat();
const files = (await walk(dir)).sort().map(path => relative(dir, path));
const packed = pack(await Promise.all(files.map(async path => ({ path, gzipped: gzipSync(await readFile(join(dir, path)), { level: 9 }) }))));
await writeFile(out, packed);
console.log(`${out}: ${files.length} files, ${packed.byteLength} bytes`);
