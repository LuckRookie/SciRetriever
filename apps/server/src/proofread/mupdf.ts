import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PageRegion } from "@sciretriever/contracts";
import type { AgentImagePart } from "../agents/protocol.js";

/** The bundled MuPDF release; scripts/vendor/build-mupdf.mjs pins the same source. */
export const MUPDF_VERSION = "1.28.6";
/** Cache identity of page images; the geometry matches the previous PDF.js rendering. */
export const PAGE_IMAGE_METHOD = `mupdf-${MUPDF_VERSION}:margin8:scale2:pixels2000000`;

/** What a missing reader costs and how to restore it (doctor, `sciretriever web`). */
export const MUPDF_MISSING_HINT =
  "导入的 PDF 读不出标题、作者和 DOI，也不能生成全文；在仓库目录执行 `pnpm vendor:mupdf`";

export interface MupdfRuntime {
  readonly executable: string;
  readonly version: string;
}

const platform = `${process.platform}-${process.arch}`;
const serverRoot = new URL("../../", import.meta.url);
/**
 * SCIRETRIEVER_MUPDF names a bundle directory; otherwise the portable package's
 * runtime/mupdf, then the workspace build output of `pnpm vendor:mupdf`.
 */
export function mupdfBundleCandidates(
  environment = process.env.SCIRETRIEVER_MUPDF,
): readonly string[] {
  if (environment !== undefined)
    return environment.startsWith("/") ? [environment] : [];
  return [
    fileURLToPath(new URL("../../../../runtime/mupdf/", serverRoot)),
    fileURLToPath(new URL(`../../build/vendor/mupdf/${platform}/`, serverRoot)),
  ];
}

/** Returns the first bundle whose manifest, version and executable digest all agree. */
export async function resolveMupdfRuntime(
  candidates = mupdfBundleCandidates(),
): Promise<MupdfRuntime | undefined> {
  for (const bundle of candidates) {
    try {
      const manifest = JSON.parse(
        await readFile(join(bundle, "manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      if (
        manifest.name !== "mupdf" ||
        manifest.version !== MUPDF_VERSION ||
        manifest.platform !== platform ||
        manifest.executable !== "bin/mutool" ||
        typeof manifest.executable_sha256 !== "string"
      )
        continue;
      const executable = join(bundle, "bin", "mutool");
      const stat = await lstat(executable);
      if (!stat.isFile() || !(stat.mode & 0o100)) continue;
      const digest = createHash("sha256")
        .update(await readFile(executable))
        .digest("hex");
      if (digest === manifest.executable_sha256)
        return { executable, version: MUPDF_VERSION };
    } catch {
      continue;
    }
  }
  return undefined;
}

// Runs inside `mutool run` (MuPDF's JavaScript). Page bounds follow the CropBox
// and /Rotate; the region, margin and pixel budget match the earlier renderer.
const SCRIPT = `var a = scriptArgs
var page = Document.openDocument(a[0]).loadPage(Number(a[1]))
var b = page.getBounds(), W = b[2] - b[0], H = b[3] - b[1], m = 8
var r = [Math.max(0, Number(a[2]) - m), Math.max(0, Number(a[3]) - m), Math.min(1000, Number(a[4]) + m), Math.min(1000, Number(a[5]) + m)]
var rw = W * (r[2] - r[0]) / 1000, rh = H * (r[3] - r[1]) / 1000
var s = Math.min(2, Math.sqrt(2000000 / (rw * rh)))
var x = Math.floor(W * s * r[0] / 1000), y = Math.floor(H * s * r[1] / 1000)
var pix = new Pixmap(ColorSpace.DeviceRGB, [x, y, x + Math.max(1, Math.ceil(rw * s)), y + Math.max(1, Math.ceil(rh * s))], false)
pix.clear(255)
var dev = new DrawDevice(Matrix.identity, pix)
page.run(dev, [s, 0, 0, s, -b[0] * s, -b[1] * s])
dev.close()
pix.saveAsPNG(a[6])
print(JSON.stringify({ width: pix.getWidth(), height: pix.getHeight() }))
`;

/**
 * Page images rendered by a separate `mutool` process. The PDF is written once
 * per content hash to a private directory that `close()` removes; MuPDF reads
 * the file itself, so document size is not bounded by an IPC message.
 */
export class MupdfPageRenderer {
  private directory: Promise<string> | null = null;
  private readonly documents = new Map<string, Promise<string>>();
  constructor(
    private readonly runtime: MupdfRuntime,
    private readonly timeoutMs = 60_000,
  ) {}
  private workspace() {
    this.directory ??= (async () => {
      const directory = await mkdtemp(join(tmpdir(), "sciretriever-mupdf-"));
      await writeFile(join(directory, "render.js"), SCRIPT, { mode: 0o600 });
      return directory;
    })();
    return this.directory;
  }
  private document(bytes: Uint8Array, hash: string) {
    let path = this.documents.get(hash);
    if (!path) {
      path = this.workspace().then(async (directory) => {
        const file = join(directory, `${hash}.pdf`);
        await writeFile(file, bytes, { mode: 0o600 });
        return file;
      });
      this.documents.set(hash, path);
      // Keep the few documents a page batch is reading; drop the oldest file.
      if (this.documents.size > 4) {
        const [oldest, evicted] = this.documents.entries().next().value!;
        this.documents.delete(oldest);
        void evicted.then((file) => rm(file, { force: true })).catch(() => {});
      }
    }
    return path;
  }
  /** `page` is zero-based; `region` uses 0-1000 page coordinates. */
  async render(
    bytes: Uint8Array,
    hash: string,
    page: number,
    region: PageRegion | null,
    signal?: AbortSignal,
  ): Promise<AgentImagePart> {
    signal?.throwIfAborted();
    const directory = await this.workspace(),
      file = await this.document(bytes, hash),
      output = join(
        directory,
        `${hash}-${page}-${createHash("sha256").update(JSON.stringify(region)).digest("hex").slice(0, 16)}-${process.hrtime.bigint()}.png`,
      ),
      [x0, y0, x1, y1] = region ?? [0, 0, 1000, 1000];
    try {
      const stdout = await new Promise<string>((resolve, reject) =>
        execFile(
          this.runtime.executable,
          [
            "run",
            join(directory, "render.js"),
            file,
            String(page),
            ...[x0, y0, x1, y1].map(String),
            output,
          ],
          {
            timeout: this.timeoutMs,
            maxBuffer: 64 * 1024,
            env: {},
            ...(signal ? { signal } : {}),
          },
          (error, out) =>
            error
              ? reject(new Error("proofread-render-failed", { cause: error }))
              : resolve(out),
        ),
      );
      const size = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as {
        width: number;
        height: number;
      };
      return {
        media_type: "image/png",
        data: await readFile(output),
        width: size.width,
        height: size.height,
      };
    } finally {
      await rm(output, { force: true });
    }
  }
  async close() {
    const directory = this.directory;
    this.directory = null;
    this.documents.clear();
    if (directory)
      await rm(await directory, { recursive: true, force: true }).catch(
        () => {},
      );
  }
}
