import {
  bibliographyEncodingAccepted,
  decodeBibliographyBytes,
  detectBibliographyFormat,
  isIntakeBibliographyFormat,
  type IntakeBibliographyFormat,
} from "@sciretriever/contracts";
import { intakeStrings } from "../strings.js";
import type { ApiClient } from "./api.js";
import { IMPORT_FILE_LIMIT, intakeRoute, readBatch } from "./imports.js";

/**
 * What one drop on the intake page holds (page specs “入库 · 文件”): the
 * files, each with the path it had inside a dropped or chosen folder.
 */
export interface DroppedFile {
  readonly file: File;
  /** `folder/sub/name.pdf` for a file from a folder; null for a loose file. */
  readonly path: string | null;
}
export interface DroppedExport extends DroppedFile {
  /** The whole file decoded; empty for one over the limit or not decodable. */
  readonly text: string;
  /** Null when neither the name nor the content tells the format. */
  readonly format: IntakeBibliographyFormat | null;
  /** How the bytes were read; null when they are neither UTF-8 nor GB18030, or not read. */
  readonly encoding:
    | ReturnType<typeof decodeBibliographyBytes>["encoding"]
    | null;
}
export interface SortedDrop {
  readonly pdfs: readonly DroppedFile[];
  readonly exports: readonly DroppedExport[];
  readonly unknown: readonly DroppedFile[];
}

const extension = (name: string) =>
  name.includes(".") ? (name.toLowerCase().split(".").pop() ?? "") : "";
async function head(file: Blob, bytes: number) {
  return new Uint8Array(await file.slice(0, bytes).arrayBuffer());
}
const isPdfHead = (bytes: Uint8Array) =>
  String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
/** The contract's decoding, or null when the bytes are not text it reads. */
function decoded(bytes: Uint8Array) {
  try {
    return decodeBibliographyBytes(bytes);
  } catch {
    return null;
  }
}

/**
 * The recognition rules: `.pdf` or content starting `%PDF-` is a PDF; a file
 * whose name or opening the contract's `detectBibliographyFormat` reads is an
 * export (literature materials 6.4.14). A loose `.xml` it cannot read is an
 * export whose format is chosen by hand; anything else is not recognized.
 */
export async function sortDrop(
  files: readonly DroppedFile[],
): Promise<SortedDrop> {
  const pdfs: DroppedFile[] = [],
    exports: DroppedExport[] = [],
    unknown: DroppedFile[] = [];
  for (const dropped of files) {
    const { file } = dropped,
      ext = extension(file.name);
    if (ext === "pdf" || isPdfHead(await head(file, 5))) {
      // A name the service cannot take is listed rather than sent.
      (acceptedName(file.name) ? pdfs : unknown).push(dropped);
      continue;
    }
    // The opening is enough to tell the format; an export is then read whole
    // (one over the limit is still an export, and the limit is said later).
    // An opening cut inside a character still shows its first line.
    const opening = await head(file, 65536),
      format = detectBibliographyFormat(
        file.name,
        decoded(opening)?.text ?? new TextDecoder().decode(opening),
      );
    if (format || (ext === "xml" && !dropped.path)) {
      const read =
        file.size <= IMPORT_FILE_LIMIT
          ? decoded(new Uint8Array(await file.arrayBuffer()))
          : null;
      exports.push({
        ...dropped,
        text: read?.text ?? "",
        format,
        encoding: read?.encoding ?? null,
      });
    } else unknown.push(dropped);
  }
  return { pdfs, exports, unknown };
}

/**
 * Why the export cannot be read in the chosen format (6.4.14 “编码”), or
 * null when it can.
 */
export function encodingProblem(
  exported: DroppedExport,
  format: string,
): string | null {
  // A file over the limit is not read; dropProblem says so.
  if (exported.file.size > IMPORT_FILE_LIMIT) return null;
  if (!exported.encoding) return intakeStrings.undecodable;
  return isIntakeBibliographyFormat(format) &&
    !bibliographyEncodingAccepted(format, exported.encoding)
    ? intakeStrings.encodingRefused(intakeStrings.formats[format])
    : null;
}

/** Why a drop cannot form a batch, or null when it can. */
export function dropProblem(drop: SortedDrop): string | null {
  if (drop.exports.length > 1)
    return `一次只接受一个导出文件，这次放进了 ${drop.exports.length} 个。`;
  const exported = drop.exports[0];
  if (exported && exported.file.size > IMPORT_FILE_LIMIT)
    return "导出文件超过 7 MiB，请拆成几个文件分别放入。";
  return null;
}

const bytes = (value: string) => new TextEncoder().encode(value).length;
/**
 * The headers a file goes with (product interface 2.4.2): its name, and the
 * path inside its folder when that path is one the service accepts — it is
 * only used to pair the file with an export's reference.
 */
export function fileHeaders(dropped: DroppedFile): Record<string, string> {
  const name = dropped.file.name;
  const headers: Record<string, string> = {
    "X-Sciretriever-File-Name": encodeURIComponent(name),
  };
  const path = dropped.path;
  if (path) {
    const parts = path.split("/");
    if (
      bytes(path) <= 1024 &&
      !path.includes("\\") &&
      parts.every((part) => part && part !== "." && part !== "..") &&
      parts.at(-1) === name
    )
      headers["X-Sciretriever-Relative-Path"] = encodeURIComponent(path);
  }
  return headers;
}

/** A file name the service takes: 1–255 bytes, no path separators. */
const acceptedName = (name: string) =>
  bytes(name) >= 1 &&
  bytes(name) <= 255 &&
  !name.includes("/") &&
  !name.includes("\\");

/** System files a folder carries (`.DS_Store` and the like) are left out. */
export const hiddenInFolder = (dropped: DroppedFile) =>
  !!dropped.path && dropped.file.name.startsWith(".");

/** Files from a drag, folders walked level by level. */
export async function droppedFiles(
  transfer: DataTransfer,
): Promise<DroppedFile[]> {
  const entries = [...transfer.items]
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => !!entry);
  if (!entries.length)
    return [...transfer.files].map((file) => ({ file, path: null }));
  const out: DroppedFile[] = [];
  const walk = async (entry: FileSystemEntry, inFolder: boolean) => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      out.push({
        file,
        path: inFolder ? entry.fullPath.replace(/^\/+/u, "") : null,
      });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // A directory reader returns its entries in batches until an empty one.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (!batch.length) break;
      for (const child of batch) await walk(child, true);
    }
  };
  for (const entry of entries) await walk(entry, false);
  return out;
}
/** Files from “选择文件” or “选择文件夹”, with their folder paths. */
export const pickedFiles = (list: FileList | null): DroppedFile[] =>
  [...(list ?? [])].map((file) => ({
    file,
    path: file.webkitRelativePath || null,
  }));

/**
 * One drop becomes one batch (page specs “入库 · 文件”): an export goes in as
 * its data and the PDFs beside it as file items the service pairs by path;
 * PDFs alone become file-only items. Nothing is written to the library here.
 */
export async function submitDrop(
  api: ApiClient,
  drop: SortedDrop,
  format: string | null,
  progress: (sent: number, total: number) => void,
): Promise<string> {
  const exported = drop.exports[0];
  if (exported && !format) throw new Error("请选择导出文件的格式。");
  const { batch } = await api.call("/api/v1/intake/batches", {
    format: exported ? format : "file",
    source: null,
    scope: exported
      ? `网页上传 ${exported.file.name}`
      : `网页上传 ${drop.pdfs.length} 个 PDF`,
    file_name: exported ? exported.file.name : null,
  });
  const id = readBatch(batch).batch_id;
  if (exported)
    await api.call(intakeRoute(id, "data"), {
      sequence: 0,
      data: exported.text,
    });
  let sent = 0;
  progress(sent, drop.pdfs.length);
  for (const pdf of drop.pdfs) {
    await api.send(
      intakeRoute(id, "file-items"),
      pdf.file,
      undefined,
      fileHeaders(pdf),
    );
    progress(++sent, drop.pdfs.length);
  }
  return id;
}
