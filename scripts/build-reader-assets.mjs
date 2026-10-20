import {
  cp,
  mkdir,
  copyFile,
  mkdtemp,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

export async function buildReaderAssets(outdir) {
  await mkdir(outdir, { recursive: true });
  // Concurrent package tests may read the existing output while another build
  // refreshes it. fs.cp removes overwritten files first, exposing a missing
  // asset window. Build outside the published paths, then replace whole files.
  const staging = await mkdtemp(
    resolve(tmpdir(), "sciretriever-reader-build-"),
  );
  let publication;
  let sequence = 0;
  const publish = async (source, target) => {
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const from = resolve(source, entry.name),
        to = resolve(target, entry.name);
      if (entry.isDirectory()) await publish(from, to);
      else {
        // Extensionless, outside reader/** and the package's *.js/css/html
        // globs. This also keeps rename on the destination filesystem.
        const file = resolve(publication, String(sequence++));
        await copyFile(from, file);
        await rename(file, to);
      }
    }
  };
  const failures = [];
  try {
    await prepareReaderAssets(staging);
    publication = await mkdtemp(resolve(outdir, ".reader-publish-"));
    await publish(staging, outdir);
  } catch (error) {
    failures.push(error);
  }
  const cleanup = await Promise.allSettled(
    [staging, publication]
      .filter(Boolean)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
  for (const result of cleanup)
    if (result.status === "rejected") failures.push(result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(
      failures,
      "Reader asset build and cleanup failed",
      { cause: failures[0] },
    );
}

async function prepareReaderAssets(outdir) {
  const repository = resolve(new URL("..", import.meta.url).pathname);
  const dependency = (name) =>
    resolve(repository, "apps/web/node_modules", name);
  await mkdir(resolve(outdir, "reader"), { recursive: true });
  await copyFile(
    dependency("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    resolve(outdir, "reader/pdf.worker.mjs"),
  );
  await copyFile(dependency("pdfjs-dist/legacy/build/pdf.mjs"), resolve(outdir, "reader/pdf.mjs"));
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
    `@noble/hashes 2.4.0\n${await readFile(resolve(repository, "packages/contracts/node_modules/@noble/hashes/LICENSE"), "utf8")}`,
    `core-js 3.50.0 (bundled by PDF.js legacy build)\n${await readFile(
      resolve(repository, "apps/web/public/core-js-LICENSE.txt"),
      "utf8",
    )}`,
  );
  await writeFile(
    resolve(outdir, "reader/third-party-notices.txt"),
    licenses.join("\n\n"),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!process.argv[2]) throw new Error("An output directory is required");
  await buildReaderAssets(resolve(process.argv[2]));
}
