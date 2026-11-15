import { spawn } from "node:child_process";
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

/** The two installed PDF readers have bounded input/output, address space, CPU and lifetime. */
export async function readPdfTool(
  bytes: Uint8Array,
  tool: "pdfinfo" | "pdftotext",
  timeoutMs = 10000,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw cancelled();
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000 ||
    !["pdfinfo", "pdftotext"].includes(tool)
  )
    throw new PdfAcceptanceError();
  return runPdfTool(bytes, tool, timeoutMs, signal);
}

async function runPdfTool(
  input: Uint8Array | number,
  tool: "pdfinfo" | "pdftotext",
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw cancelled();
  const source = typeof input === "number" ? "/proc/self/fd/3" : "-";
  const args =
    tool === "pdfinfo"
      ? [source]
      : ["-f", "1", "-l", "1", "-enc", "UTF-8", source, "-"];
  const limit = tool === "pdfinfo" ? 65536 : 131072;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "prlimit",
      [
        "--as=536870912",
        `--cpu=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
        "--",
        tool,
        ...args,
      ],
      {
        stdio:
          typeof input === "number"
            ? ["ignore", "pipe", "pipe", input]
            : ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
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
      if (total > limit) stop("pdf-reader-output-limit");
      else chunks.push(chunk);
    });
    child.stderr!.resume();
    child.stdin?.on("error", (cause: NodeJS.ErrnoException) => {
      if (cause.code !== "EPIPE") stop("pdf-reader-io-failed", cause);
    });
    child.on("error", (cause) => {
      failure ??= new PdfReaderFailure("pdf-reader-unavailable", cause);
    });
    child.on("close", (code, terminationSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (!failure && code === 127)
        failure = new PdfReaderFailure("pdf-reader-unavailable");
      if (!failure && ["SIGXCPU", "SIGKILL"].includes(terminationSignal ?? ""))
        failure = new PdfReaderFailure("pdf-reader-resource-limit");
      if (failure || code !== 0) reject(new PdfAcceptanceError(failure));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    if (input instanceof Uint8Array) child.stdin!.end(input);
  });
}

function acceptedReport(report: string): PdfAcceptance {
  if (/^Encrypted:\s+yes\b/mu.test(report))
    throw new PdfAcceptanceError(undefined, "encrypted-pdf");
  const pages = /^Pages:\s+(\d+)$/mu.exec(report);
  const count = Number(pages?.[1]);
  if (!Number.isSafeInteger(count) || count < 1) throw new PdfAcceptanceError();
  return Object.freeze({ accepted: true, page_count: count });
}

/** The storage scope supplies a seekable read-only descriptor; total input size is not its address-space budget. */
export async function acceptPdfFile(
  file: ScopedFileReader,
  timeoutMs = 10000,
  signal?: AbortSignal,
): Promise<PdfAcceptance> {
  if (signal?.aborted) throw cancelled();
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
    runPdfTool(fd, "pdfinfo", timeoutMs, signal),
  );
  return acceptedReport(report);
}

export async function acceptPdf(
  bytes: Uint8Array,
  timeoutMs = 10000,
  signal?: AbortSignal,
): Promise<PdfAcceptance> {
  if (
    !(bytes instanceof Uint8Array) ||
    !new TextDecoder().decode(bytes.slice(0, 8)).startsWith("%PDF-")
  )
    throw new PdfAcceptanceError(undefined, "non-pdf-file");
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
  const report = await readPdfTool(bytes, "pdfinfo", timeoutMs, signal);
  return acceptedReport(report);
}
