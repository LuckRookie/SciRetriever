import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMupdfRuntime, type MupdfRuntime } from "../proofread/mupdf.js";
import type { ScopedFileReader } from "../storage/files/reader.js";

export interface PdfAcceptance {
  readonly accepted: boolean;
  readonly page_count: number;
}
export class PdfAcceptanceError extends Error {
  readonly code = "pdf-acceptance" as const;
  constructor(
    cause?: unknown,
    readonly reason:
      | "pdf-invalid"
      | "non-pdf-file"
      | "encrypted-pdf" = "pdf-invalid",
  ) {
    super("pdf acceptance failed", { cause });
    this.name = "PdfAcceptanceError";
  }
}

export type PdfReaderFailureCode =
  | "pdf-reader-timeout"
  | "pdf-reader-cancelled"
  | "pdf-reader-unavailable"
  | "pdf-reader-output-limit"
  | "pdf-reader-resource-limit"
  | "pdf-reader-io-failed";
class PdfReaderFailure extends Error {
  constructor(
    readonly code: PdfReaderFailureCode,
    cause?: unknown,
  ) {
    super("PDF reader operation failed", { cause });
  }
}
function cancelled(): PdfAcceptanceError {
  return new PdfAcceptanceError(new PdfReaderFailure("pdf-reader-cancelled"));
}

/**
 * Runs inside `mutool run`. MuPDF opens the path itself (the scoped descriptor,
 * or a private copy of in-memory bytes), so the document size is not bounded by
 * an IPC message. Lazy object loading can repair the file, so `wasRepaired` is
 * read after the page count.
 */
const SCRIPT = String.raw`var doc=Document.openDocument(scriptArgs[0]);
if(typeof doc.disableJS==='function')doc.disableJS();
var r={format:String(doc.getMetaData('format')||''),needs_password:!!doc.needsPassword(),encryption:String(doc.getMetaData('encryption')||'')};
if(!r.needs_password)r.pages=doc.countPages();
r.repaired=typeof doc.wasRepaired==='function'?!!doc.wasRepaired():false;
print(JSON.stringify(r));`;
/** The script's file name; tests that stand in for the reader recognise it. */
export const PDF_ACCEPTANCE_SCRIPT = "pdf-accept.js";
const OUTPUT_LIMIT = 4096;

let runtimeLookup: Promise<MupdfRuntime | undefined> | undefined;
/** The verified bundle is found once per process; a missing one is looked up again next time. */
function mupdf(): Promise<MupdfRuntime | undefined> {
  const lookup = (runtimeLookup ??= resolveMupdfRuntime());
  void lookup.then((found) => {
    if (!found && runtimeLookup === lookup) runtimeLookup = undefined;
  });
  return lookup;
}

/** MuPDF in a separate process with bounded output, address space, CPU and lifetime. */
async function readPdf(
  input: Uint8Array | number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  path: string | undefined,
): Promise<string> {
  if (signal?.aborted) throw cancelled();
  const runtime = await mupdf();
  if (signal?.aborted) throw cancelled();
  if (!runtime)
    throw new PdfAcceptanceError(
      new PdfReaderFailure("pdf-reader-unavailable"),
    );
  let directory: string | undefined;
  try {
    const script = join(
        (directory = await mkdtemp(join(tmpdir(), "sciretriever-pdf-accept-"))),
        PDF_ACCEPTANCE_SCRIPT,
      ),
      // In-memory bytes go to a private file: MuPDF needs a seekable input.
      copy = join(directory, "input.pdf");
    try {
      await writeFile(script, SCRIPT, { mode: 0o600 });
      if (typeof input !== "number")
        await writeFile(copy, input, { mode: 0o600 });
    } catch (cause) {
      throw new PdfAcceptanceError(
        new PdfReaderFailure("pdf-reader-io-failed", cause),
      );
    }
    if (signal?.aborted) throw cancelled();
    return await new Promise((resolve, reject) => {
      const child = spawn(
        "prlimit",
        [
          "--as=536870912",
          `--cpu=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
          "--",
          runtime.executable,
          "run",
          script,
          typeof input === "number" ? "/proc/self/fd/3" : copy,
        ],
        {
          stdio:
            typeof input === "number"
              ? ["ignore", "pipe", "pipe", input]
              : ["ignore", "pipe", "pipe"],
          env: { PATH: path ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
        },
      );
      const chunks: Buffer[] = [];
      let total = 0;
      let failure: PdfReaderFailure | undefined;
      const stop = (code: PdfReaderFailureCode, cause?: unknown) => {
        failure ??= new PdfReaderFailure(code, cause);
        child.kill("SIGKILL");
      };
      const cancel = () => stop("pdf-reader-cancelled");
      const timer = setTimeout(() => stop("pdf-reader-timeout"), timeoutMs);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      child.stdout!.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > OUTPUT_LIMIT) stop("pdf-reader-output-limit");
        else chunks.push(chunk);
      });
      child.stderr!.resume();
      child.on("error", (cause) => {
        failure ??= new PdfReaderFailure("pdf-reader-unavailable", cause);
      });
      child.on("close", (code, terminationSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        if (!failure && code === 127)
          failure = new PdfReaderFailure("pdf-reader-unavailable");
        if (
          !failure &&
          ["SIGXCPU", "SIGKILL"].includes(terminationSignal ?? "")
        )
          failure = new PdfReaderFailure("pdf-reader-resource-limit");
        if (failure || code !== 0) reject(new PdfAcceptanceError(failure));
        else resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
  } catch (error) {
    if (error instanceof PdfAcceptanceError) throw error;
    throw new PdfAcceptanceError(
      new PdfReaderFailure("pdf-reader-io-failed", error),
    );
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

/** The rules of acceptance: a PDF, no password, no encryption, not repaired, at least one page. */
function acceptedReport(report: string): PdfAcceptance {
  let facts: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(report.trim().split("\n").at(-1) ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("pdf-reader-output");
    facts = parsed as Record<string, unknown>;
  } catch {
    throw new PdfAcceptanceError();
  }
  // The byte check already found `%PDF-`; another format is an unusable PDF.
  if (typeof facts.format !== "string" || !/^PDF\b/u.test(facts.format))
    throw new PdfAcceptanceError();
  if (
    facts.needs_password !== false ||
    (facts.encryption !== "None" && facts.encryption !== "")
  )
    throw new PdfAcceptanceError(undefined, "encrypted-pdf");
  // A repaired cross-reference is what an interrupted download looks like.
  if (facts.repaired !== false) throw new PdfAcceptanceError();
  const count = facts.pages;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1)
    throw new PdfAcceptanceError();
  return Object.freeze({ accepted: true, page_count: count });
}

/** The storage scope supplies a seekable read-only descriptor; total input size is not its address-space budget. */
export async function acceptPdfFile(
  file: ScopedFileReader,
  timeoutMs = 10000,
  signal?: AbortSignal,
): Promise<PdfAcceptance> {
  if (signal?.aborted) throw cancelled();
  const path = process.env.PATH;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000 ||
    file.size < 1
  )
    throw new PdfAcceptanceError();
  const decoder = new TextDecoder();
  const head = await file.readRange(0, Math.min(8, file.size));
  if (!decoder.decode(head).startsWith("%PDF-"))
    throw new PdfAcceptanceError(undefined, "non-pdf-file");
  const length = Math.min(file.size, 2 * 1024 * 1024);
  const prefix = decoder.decode(await file.readRange(0, length));
  const tail = decoder.decode(await file.readRange(file.size - length, length));
  if (/\/Encrypt\b/u.test(prefix) || /\/Encrypt\b/u.test(tail))
    throw new PdfAcceptanceError(undefined, "encrypted-pdf");
  const report = await file.withDescriptor((fd) =>
    readPdf(fd, timeoutMs, signal, path),
  );
  return acceptedReport(report);
}

export async function acceptPdf(
  bytes: Uint8Array,
  timeoutMs = 10000,
  signal?: AbortSignal,
): Promise<PdfAcceptance> {
  const path = process.env.PATH;
  if (
    !(bytes instanceof Uint8Array) ||
    !new TextDecoder().decode(bytes.slice(0, 8)).startsWith("%PDF-")
  )
    throw new PdfAcceptanceError(undefined, "non-pdf-file");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
    throw new PdfAcceptanceError();
  // An encrypted document must never reach the identity extractor. The
  // encryption dictionary is normally in the trailer, so inspect both the
  // header and a bounded tail without decoding the full input as text.
  const decoder = new TextDecoder();
  const prefix = decoder.decode(
    bytes.slice(0, Math.min(bytes.byteLength, 2 * 1024 * 1024)),
  );
  const tailStart = Math.max(0, bytes.byteLength - 2 * 1024 * 1024);
  const tail = decoder.decode(bytes.slice(tailStart));
  if (/\/Encrypt\b/u.test(prefix) || /\/Encrypt\b/u.test(tail))
    throw new PdfAcceptanceError(undefined, "encrypted-pdf");
  const report = await readPdf(bytes, timeoutMs, signal, path);
  return acceptedReport(report);
}
