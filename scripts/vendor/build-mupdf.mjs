// Builds the pinned MuPDF command-line tool from the official source release
// into build/vendor/mupdf/<platform>/. Proofreading renders page images with it.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MUPDF = Object.freeze({
  version: "1.28.6",
  source_url:
    "https://github.com/ArtifexSoftware/mupdf-downloads/releases/download/1.28.6/mupdf-1.28.6-source.tar.gz",
  source_sha256:
    "dc85000640a45d90ca9b77b061f6ca67cce0c4d4fbecf8819647baf573eef101",
  license: "AGPL-3.0-or-later",
  // Bundled third-party libraries only; no X11, OpenGL, curl, OpenSSL, OCR or barcodes.
  make_flags: [
    "build=release",
    "HAVE_X11=no",
    "HAVE_GLUT=no",
    "HAVE_CURL=no",
    "HAVE_LIBCRYPTO=no",
    "tesseract=no",
    "barcode=no",
    "USE_SYSTEM_LIBS=no",
  ],
});

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function source(work) {
  const local = option("--source");
  const bytes = local
    ? await readFile(resolve(local))
    : Buffer.from(
        await (async () => {
          const response = await globalThis.fetch(MUPDF.source_url);
          if (!response.ok)
            throw new Error(`MuPDF download failed (${response.status})`);
          return response.arrayBuffer();
        })(),
      );
  if (sha256(bytes) !== MUPDF.source_sha256)
    throw new Error("MuPDF source does not match the pinned SHA-256");
  const archive = join(work, "source.tar.gz");
  await writeFile(archive, bytes);
  return archive;
}

async function main() {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("MuPDF bundling is supported on linux-x64 only");
  const output = resolve(
    option("--output") ??
      join(
        repository,
        "build/vendor/mupdf",
        `${process.platform}-${process.arch}`,
      ),
  );
  if (existsSync(output)) throw new Error(`${output} already exists`);
  const work = await mkdtemp(join(tmpdir(), "sciretriever-mupdf-"));
  try {
    const archive = await source(work);
    execFileSync("tar", ["-xzf", archive, "-C", work]);
    const tree = join(work, `mupdf-${MUPDF.version}-source`);
    execFileSync(
      "make",
      [`-j${availableParallelism()}`, ...MUPDF.make_flags, "tools"],
      { cwd: tree, stdio: ["ignore", "ignore", "inherit"] },
    );
    const staging = `${output}.partial-${process.pid}`;
    await mkdir(join(staging, "bin"), { recursive: true });
    const executable = join(staging, "bin", "mutool");
    await copyFile(join(tree, "build/release/mutool"), executable);
    await chmod(executable, 0o755);
    await copyFile(join(tree, "COPYING"), join(staging, "COPYING"));
    const glibc = execFileSync("objdump", ["-T", executable], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .match(/GLIBC_[0-9.]+/g)
      ?.map((v) => v.slice(6))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .at(-1);
    const manifest = {
      schema_version: 1,
      name: "mupdf",
      version: MUPDF.version,
      platform: `${process.platform}-${process.arch}`,
      license: MUPDF.license,
      source_url: MUPDF.source_url,
      source_sha256: MUPDF.source_sha256,
      make_flags: MUPDF.make_flags,
      executable: "bin/mutool",
      executable_sha256: sha256(await readFile(executable)),
      minimum_glibc: glibc ?? null,
    };
    await writeFile(
      join(staging, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await mkdir(dirname(output), { recursive: true });
    await rename(staging, output);
    process.stdout.write(`${output}\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
