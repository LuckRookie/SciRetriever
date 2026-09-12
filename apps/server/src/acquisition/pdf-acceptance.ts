import { spawn } from "node:child_process";

export interface PdfAcceptance {
  readonly accepted: boolean;
  readonly page_count: number;
}
export class PdfAcceptanceError extends Error {
  readonly code = "pdf-acceptance" as const;
  constructor() {
    super("pdf acceptance failed");
    this.name = "PdfAcceptanceError";
  }
}

/** The two installed PDF readers have bounded input/output, address space, CPU and lifetime. */
export async function readPdfTool(
  bytes: Uint8Array,
  tool: "pdfinfo" | "pdftotext",
  timeoutMs = 10000,
  signal?: AbortSignal,
): Promise<string> {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > 512 * 1024 * 1024 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000 ||
    signal?.aborted ||
    !["pdfinfo", "pdftotext"].includes(tool)
  )
    throw new PdfAcceptanceError();
  const args =
    tool === "pdfinfo"
      ? ["-"]
      : ["-f", "1", "-l", "1", "-enc", "UTF-8", "-", "-"];
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
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
      },
    );
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    const cancel = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(cancel, timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) cancel();
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on("error", cancel);
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (failed || code !== 0) reject(new PdfAcceptanceError());
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.end(bytes);
  });
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
    throw new PdfAcceptanceError();
  const report = await readPdfTool(bytes, "pdfinfo", timeoutMs, signal);
  const pages = /^Pages:\s+(\d+)$/mu.exec(report);
  const count = Number(pages?.[1]);
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    /^Encrypted:\s+yes\b/mu.test(report)
  )
    throw new PdfAcceptanceError();
  return Object.freeze({ accepted: true, page_count: count });
}
