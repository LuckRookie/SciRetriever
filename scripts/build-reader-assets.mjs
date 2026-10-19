import { build } from "esbuild";
import { cp, mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function buildReaderAssets(outdir) {
  const repository = resolve(new URL("..", import.meta.url).pathname);
  const dependency = (name) =>
    resolve(repository, "apps/web/node_modules", name);
  await mkdir(resolve(outdir, "reader"), { recursive: true });
  await build({
    entryPoints: [resolve(repository, "apps/web/src/reading/entry.ts")],
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile: resolve(outdir, "reader.js"),
  });
  await copyFile(
    dependency("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    resolve(outdir, "reader/pdf.worker.mjs"),
  );
  for (const dir of ["cmaps", "standard_fonts", "wasm"])
    await cp(dependency(`pdfjs-dist/${dir}`), resolve(outdir, "reader", dir), {
      recursive: true,
    });
  await cp(dependency("katex/dist/fonts"), resolve(outdir, "reader/fonts"), {
    recursive: true,
  });
  await copyFile(
    dependency("katex/dist/katex.min.css"),
    resolve(outdir, "reader/katex.css"),
  );
  // Use the matching PDF.js text-layer rules; the rest of its viewer UI is not shipped.
  const { readFile, writeFile } = await import("node:fs/promises");
  const css = await readFile(
    dependency("pdfjs-dist/web/pdf_viewer.css"),
    "utf8",
  );
  const start = css.indexOf(".textLayer {"),
    end = css.indexOf(".annotationLayer", start);
  if (start < 0 || end < 0)
    throw new Error("PDF.js text layer CSS was not found");
  await writeFile(
    resolve(outdir, "reader/text-layer.css"),
    "/* PDF.js text layer — Copyright Mozilla Foundation; Apache-2.0. See third-party-notices.txt. */\n" +
      css.slice(start, end),
  );
  const licenses = await Promise.all(
    ["pdfjs-dist", "marked", "katex", "fflate"].map(
      async (name) =>
        `${name}\n${await readFile(dependency(`${name}/LICENSE`), "utf8")}`,
    ),
  );
  licenses.push(
    `core-js 3.50.0 (bundled by PDF.js legacy build)\n${await readFile(
      resolve(repository, "apps/web/public/core-js-LICENSE.txt"),
      "utf8",
    )}`,
  );
  await writeFile(
    resolve(outdir, "reader/third-party-notices.txt"),
    licenses.join("\n\n"),
  );
  await copyFile(
    resolve(repository, "apps/web/public/reading.css"),
    resolve(outdir, "reading.css"),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!process.argv[2]) throw new Error("An output directory is required");
  await buildReaderAssets(resolve(process.argv[2]));
}
