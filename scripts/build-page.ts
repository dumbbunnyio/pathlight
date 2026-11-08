// Builds the browser page (src/page/, Solid) into dist/page/: main.js (minified, with Solid), page.css and index.html, then packs them, each
// gzipped, as dist/page/pathlight-page.gz, which pathlight web serves and scripts/build.sh embeds. Bun's own JSX transform is not Solid's, so
// .tsx files go through Solid's Babel preset here, in a plugin of our own.
import { transformAsync } from "@babel/core";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack, packNames } from "../src/web/page";

const root = join(import.meta.dir, "..");
const source = join(root, "src", "page"), out = join(root, "dist", "page"), files = join(out, "files");
const started = performance.now();

const solid: Bun.BunPlugin = {
  name: "solid",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
      const result = await transformAsync(await readFile(path, "utf8"), {
        filename: path, babelrc: false, configFile: false,
        presets: [["babel-preset-solid", { generate: "dom" }], ["@babel/preset-typescript", { onlyRemoveTypeImports: true }]],
      });
      if (!result?.code) throw new Error(`build-page: Babel gave nothing for ${path}`);
      return { contents: result.code, loader: "js" };
    });
  },
};

await rm(out, { recursive: true, force: true });
await mkdir(files, { recursive: true });
const built = await Bun.build({
  entrypoints: [join(source, "main.tsx")], outdir: files, naming: "main.js", target: "browser", format: "esm", minify: true, plugins: [solid],
  // Solid's browser build, never its server one.
  conditions: ["browser", "solid"],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!built.success) { for (const log of built.logs) console.error(log); process.exit(1); }
for (const name of ["index.html", "page.css"]) await writeFile(join(files, name), await readFile(join(source, name)));

const names = ["index.html", "main.js", "page.css"];
const packed = pack(await Promise.all(names.map(async path => ({ path, gzipped: gzipSync(await readFile(join(files, path)), { level: 9 }) }))));
await writeFile(join(out, packNames.page), packed);
const sizes = await Promise.all(names.map(async name => `${name} ${(await readFile(join(files, name))).byteLength}`));
console.log(`${join("dist", "page", packNames.page)}: ${packed.byteLength} bytes (${sizes.join(", ")}) in ${Math.round(performance.now() - started)} ms`);
