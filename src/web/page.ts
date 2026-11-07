import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * The browser page's files (`web/`, built by `scripts/build-web.sh`) travel as one pack: `PLPAGE1`, the length of a JSON index, the index, then
 * each file gzipped. One file, so the binary embeds it under a single name (`bun build --compile ... --loader .gz:file`, which hashes and
 * flattens names, and would otherwise lose the page's own folders). From a checkout the pack is read from `web/dist`. A checkout that has not
 * built the page has none, and `pathlight web` says how to build it.
 */
export interface PageFile { path: string; type: string; body: Uint8Array<ArrayBuffer> }
export interface Page { files: ReadonlyMap<string, PageFile> }

const magic = "PLPAGE1\n";
export const packName = "pathlight-page.gz";
export const sourcePack = join(import.meta.dir, "..", "..", "web", "dist", packName);

export const typeOf = (path: string) => path.endsWith(".html") ? "text/html; charset=utf-8" : path.endsWith(".js") ? "text/javascript; charset=utf-8"
  : path.endsWith(".wasm") ? "application/wasm" : path.endsWith(".css") ? "text/css; charset=utf-8" : path.endsWith(".json") ? "application/json" : "application/octet-stream";

/** Packs page files (already gzipped) as `pathlight web` reads them. */
export const pack = (files: readonly { path: string; gzipped: Uint8Array }[]) => {
  let offset = 0;
  const index = files.map(file => { const entry = { path: file.path, type: typeOf(file.path), offset, length: file.gzipped.byteLength }; offset += file.gzipped.byteLength; return entry; });
  const head = new TextEncoder().encode(JSON.stringify({ files: index }));
  return Buffer.concat([Buffer.from(magic), Buffer.from(`${head.byteLength}\n`), head, ...files.map(file => file.gzipped)]);
};

export const unpack = (bytes: Uint8Array<ArrayBuffer>): Page => {
  const text = new TextDecoder();
  if (text.decode(bytes.subarray(0, magic.length)) !== magic) throw new Error("Not a Pathlight page pack");
  const newline = bytes.indexOf(10, magic.length);
  const length = Number(text.decode(bytes.subarray(magic.length, newline)));
  const index = JSON.parse(text.decode(bytes.subarray(newline + 1, newline + 1 + length))) as { files: { path: string; type: string; offset: number; length: number }[] };
  const start = newline + 1 + length;
  return { files: new Map(index.files.map(file => [file.path, { path: file.path, type: file.type, body: bytes.subarray(start + file.offset, start + file.offset + file.length) }])) };
};

/** The page: embedded in the binary, else built in this checkout, else none. */
export const loadPage = async (): Promise<Page | undefined> => {
  const embedded = Bun.embeddedFiles.find(file => (file as Blob & { name?: string }).name?.startsWith("pathlight-page"));
  if (embedded) return unpack(new Uint8Array(await embedded.arrayBuffer()));
  const bytes = await readFile(sourcePack).catch(() => undefined);
  return bytes ? unpack(new Uint8Array(bytes)) : undefined;
};

/** A file's own bytes, for a client that does not take gzip (none of the browsers the page runs on; kept for tests). */
export const plain = (file: PageFile) => gunzipSync(file.body);
