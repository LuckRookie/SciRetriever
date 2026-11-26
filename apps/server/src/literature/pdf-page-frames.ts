import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMupdfRuntime } from "../proofread/mupdf.js";
import type { ScopedFileReader } from "../storage/files/reader.js";
import type { PdfPageFrame } from "./zotero-annotations.js";

export interface PdfPageFrames {
  readonly page_count: number;
  /** 0-based page index to its frame; only the pages asked for that exist. */
  readonly frames: ReadonlyMap<number, PdfPageFrame>;
}
export class PdfPageFrameError extends Error {
  constructor(
    readonly code:
      | "pdf-frames-unavailable"
      | "pdf-frames-failed"
      | "pdf-frames-cancelled",
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

/**
 * Runs inside `mutool run`. MuPDF's page transform maps PDF user space to page
 * space with the CropBox (within the MediaBox), /Rotate and inheritance
 * applied, the same frame pdf.js renders at scale 1.
 */
const SCRIPT = String.raw`var doc=Document.openDocument(scriptArgs[0]);
if(typeof doc.disableJS==='function')doc.disableJS();
if(doc.needsPassword())throw new Error('encrypted');
var n=doc.countPages(),r={page_count:n,pages:{}},want=scriptArgs[1]?scriptArgs[1].split(','):[];
for(var i=0;i<want.length;i++){var k=Number(want[i]);if(k>=0&&k<n&&!r.pages[k]){var p=doc.loadPage(k);r.pages[k]={bounds:p.getBounds(),matrix:p.getTransform()};}}
print(JSON.stringify(r));`;
const MAX_PAGES = 5000;
const OUTPUT_LIMIT = 1024 * 1024;
let runtimeLookup: ReturnType<typeof resolveMupdfRuntime> | undefined;

/** Page frames of the asked pages, read by a separate bounded MuPDF process. */
export async function readPdfPageFrames(
  file: ScopedFileReader,
  pages: readonly number[],
  signal?: AbortSignal,
  timeoutMs = 10000,
): Promise<PdfPageFrames> {
  const wanted = [...new Set(pages)]
    .filter((p) => Number.isSafeInteger(p) && p >= 0)
    .sort((a, b) => a - b)
    .slice(0, MAX_PAGES);
  const lookup = (runtimeLookup ??= resolveMupdfRuntime());
  const runtime = await lookup;
  if (!runtime) {
    if (runtimeLookup === lookup) runtimeLookup = undefined;
    throw new PdfPageFrameError("pdf-frames-unavailable");
  }
  if (signal?.aborted) throw new PdfPageFrameError("pdf-frames-cancelled");
  const directory = await mkdtemp(join(tmpdir(), "sciretriever-pdf-frames-"));
  try {
    const script = join(directory, "pdf-frames.js");
    await writeFile(script, SCRIPT, { mode: 0o600 });
    const output = await file.withDescriptor(
      (fd) =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(
            "prlimit",
            [
              "--as=536870912",
              `--cpu=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
              "--",
              runtime.executable,
              "run",
              script,
              "/proc/self/fd/3",
              wanted.join(","),
            ],
            {
              stdio: ["ignore", "pipe", "pipe", fd],
              env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
            },
          );
          const chunks: Buffer[] = [];
          let total = 0,
            failure: PdfPageFrameError | undefined;
          const stop = (code: PdfPageFrameError["code"]) => {
            failure ??= new PdfPageFrameError(code);
            child.kill("SIGKILL");
          };
          const cancel = () => stop("pdf-frames-cancelled");
          const timer = setTimeout(() => stop("pdf-frames-failed"), timeoutMs);
          signal?.addEventListener("abort", cancel, { once: true });
          child.stdout!.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > OUTPUT_LIMIT) stop("pdf-frames-failed");
            else chunks.push(chunk);
          });
          child.stderr!.resume();
          child.on("error", (cause) => {
            failure ??= new PdfPageFrameError("pdf-frames-unavailable", {
              cause,
            });
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", cancel);
            if (failure) reject(failure);
            else if (code !== 0)
              reject(new PdfPageFrameError("pdf-frames-failed"));
            else resolve(Buffer.concat(chunks).toString("utf8"));
          });
        }),
    );
    return parseFrames(output, wanted);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseFrames(output: string, wanted: readonly number[]) {
  let value: {
    page_count?: unknown;
    pages?: Record<string, { bounds?: unknown; matrix?: unknown }>;
  };
  try {
    value = JSON.parse(output.trim().split("\n").at(-1) ?? "");
  } catch (cause) {
    throw new PdfPageFrameError("pdf-frames-failed", { cause });
  }
  const numbers = (v: unknown, n: number): number[] | null =>
    Array.isArray(v) &&
    v.length === n &&
    v.every((x) => typeof x === "number" && Number.isFinite(x))
      ? (v as number[])
      : null;
  const count = value.page_count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    throw new PdfPageFrameError("pdf-frames-failed");
  const frames = new Map<number, PdfPageFrame>();
  for (const page of wanted) {
    const entry = value.pages?.[String(page)];
    if (!entry) continue;
    const bounds = numbers(entry.bounds, 4),
      m = numbers(entry.matrix, 6);
    if (!bounds || !m) throw new PdfPageFrameError("pdf-frames-failed");
    // Page space starts at the bounds' corner, normally (0, 0).
    const z = (n: number) => n + 0;
    frames.set(page, {
      width: z(bounds[2]! - bounds[0]!),
      height: z(bounds[3]! - bounds[1]!),
      matrix: [
        z(m[0]!),
        z(m[1]!),
        z(m[2]!),
        z(m[3]!),
        z(m[4]! - bounds[0]!),
        z(m[5]! - bounds[1]!),
      ],
    });
  }
  return { page_count: count, frames };
}
