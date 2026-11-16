import type { ApiClient } from "./api.js";
import {
  detectFormat,
  IMPORT_FILE_LIMIT,
  intakeRoute,
  readBatch,
} from "./imports.js";

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
  readonly text: string;
  /** Null when neither the name nor the content tells the format. */
  readonly format: string | null;
}
export interface SortedDrop {
  readonly pdfs: readonly DroppedFile[];
  readonly exports: readonly DroppedExport[];
  readonly unknown: readonly DroppedFile[];
}

const EXPORT_EXTENSIONS = new Set(["bib", "ris", "json"]);
const extension = (name: string) =>
  name.includes(".") ? (name.toLowerCase().split(".").pop() ?? "") : "";
async function head(file: Blob, bytes: number) {
  return new Uint8Array(await file.slice(0, bytes).arrayBuffer());
}
const isPdfHead = (bytes: Uint8Array) =>
  String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";

/**
 * The recognition rules: `.pdf` or content starting `%PDF-` is a PDF;
 * `.bib`, `.ris`, `.json`, or content in BibTeX, RIS or CSL JSON form, is an
 * export (its format null when unclear); anything else is not recognized.
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
    const format = detectFormat(file.name, await file.slice(0, 65536).text());
    if (format || EXPORT_EXTENSIONS.has(ext))
      exports.push({
        ...dropped,
        text: file.size <= IMPORT_FILE_LIMIT ? await file.text() : "",
        format,
      });
    else unknown.push(dropped);
  }
  return { pdfs, exports, unknown };
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
