import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importObject,
  importInteger,
  type Identifier,
  type IntakeCluesUnreadReason,
} from "@sciretriever/contracts";
import {
  acceptPdfFile,
  PdfAcceptanceError,
} from "../acquisition/pdf-acceptance.js";
import { resolveMupdfRuntime, type MupdfRuntime } from "../proofread/mupdf.js";
import type { ScopedFileReader } from "../storage/files/reader.js";
import {
  clueArxiv,
  clueDois,
  clueText,
  uniqueIdentifiers,
} from "./import-clues.js";

export interface FileClues {
  /** Basename without its extension, used only as a recognition clue. */
  readonly file_name: string;
  readonly status: "read" | "image-only" | "unavailable" | "rejected";
  readonly reason:
    | "clues-timeout"
    | "clues-unavailable"
    | "non-pdf-file"
    | "encrypted-pdf"
    | "pdf-invalid"
    | null;
  /**
   * Why no text clue was read, or null when it was. `reason` keeps its older
   * values; this field separates a missing reader from a failed one.
   */
  readonly unread: IntakeCluesUnreadReason | null;
  readonly info: {
    readonly title: string | null;
    readonly subject: string | null;
    readonly keywords: string | null;
  };
  readonly xmp: {
    readonly title: string | null;
    readonly identifier: string | null;
    readonly dois: readonly string[];
  };
  readonly pages: readonly {
    readonly page_index: number;
    readonly text: string;
  }[];
  readonly prominent_titles: readonly string[];
  readonly identifiers: readonly Identifier[];
}
interface Line {
  text: string;
  font_size: number;
  bbox: number[];
  block: number;
}
interface PdfClueOutput {
  info: FileClues["info"];
  xmp: string;
  pages: { page_index: number; text: string }[];
  first_page_lines: Line[];
  bounds: number[];
}
function parseToolOutput(value: unknown): PdfClueOutput {
  const r = importObject(
      value,
      ["info", "xmp", "pages", "first_page_lines", "bounds"],
      ["restore_passes"],
    ),
    info = importObject(r.info, ["title", "subject", "keywords"]);
  const string = (value: unknown, limit: number) => {
    if (typeof value !== "string" || value.length > limit)
      throw new Error("intake-clues-reader-output");
    return value;
  };
  const box = (value: unknown) => {
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      value.some((v) => typeof v !== "number" || !Number.isFinite(v))
    )
      throw new Error("intake-clues-reader-output");
    return value as number[];
  };
  if (
    !Array.isArray(r.pages) ||
    !r.pages.length ||
    r.pages.length > 2 ||
    !Array.isArray(r.first_page_lines) ||
    r.first_page_lines.length > 2000
  )
    throw new Error("intake-clues-reader-output");
  return {
    info: {
      title: info.title === null ? null : string(info.title, 20000),
      subject: info.subject === null ? null : string(info.subject, 20000),
      keywords: info.keywords === null ? null : string(info.keywords, 20000),
    },
    xmp: string(r.xmp, 262144),
    bounds: box(r.bounds),
    pages: r.pages.map((value, index) => {
      const p = importObject(value, ["page_index", "text"]);
      if (p.page_index !== index) throw new Error("intake-clues-reader-output");
      return {
        page_index: importInteger(p.page_index, 1),
        text: string(p.text, 40000),
      };
    }),
    first_page_lines: r.first_page_lines.map((value) => {
      const l = importObject(value, ["text", "font_size", "bbox", "block"]);
      if (typeof l.font_size !== "number" || !Number.isFinite(l.font_size))
        throw new Error("intake-clues-reader-output");
      return {
        text: string(l.text, 1000),
        font_size: l.font_size,
        bbox: box(l.bbox),
        block: importInteger(l.block),
      };
    }),
  };
}

// Only the supplied read-only descriptor is passed to MuPDF. No PDF, page image
// or whole-file buffer crosses IPC; the child has bounded CPU, memory and output.
// XMP bytes are joined in 64-byte pieces: one string per byte made MuJS hold
// hundreds of MiB for a 44 KB packet. 64 keeps `apply` within MuJS's stack.
// A first page with characters MuPDF cannot name (U+FFFD) is read twice more:
// simple fonts whose /Differences glyph names are a letter or two and the
// character code (C68, G3A) get the character back; see restoreFirstPage.
const SCRIPT = String.raw`var doc=Document.openDocument(scriptArgs[0]);doc.disableJS();
function bounded(s,n){s=String(s||'').slice(0,n);var c=s.charCodeAt(s.length-1);return c>=55296&&c<=56319?s.slice(0,-1):s;}
var info={title:bounded(doc.getMetaData('info:Title'),20000)||null,subject:bounded(doc.getMetaData('info:Subject'),20000)||null,keywords:bounded(doc.getMetaData('info:Keywords'),20000)||null};
function streamText(m){var b=m.readStream(),n=Math.min(b.length,262144),parts=[];for(var i=0;i<n;i+=64){var c=[];for(var k=i;k<Math.min(n,i+64);k++)c.push(b[k]);parts.push(String.fromCharCode.apply(null,c));}return parts.join('');}
var metadata=doc.getTrailer().get('Root').get('Metadata'),xmp=metadata&&metadata.isStream()?streamText(metadata):'';
var pages=[],lines=[],bounds=null,restorePasses=0;
function count(s){s=s.replace(/\s+/g,' ').replace(/^\s+|\s+$/g,'');return s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g,'x').length;}
var cp1252={128:8364,130:8218,131:402,132:8222,133:8230,134:8224,135:8225,136:710,137:8240,138:352,139:8249,140:338,142:381,145:8216,146:8217,147:8220,148:8221,149:8226,150:8211,151:8212,152:732,153:8482,154:353,155:8250,156:339,158:382,159:376};
function glyphChar(name){if(!name)return null;name=name.replace(/[._].*$/,'');var m=/^[A-Za-z]{1,2}([0-9]{2,3})$/.exec(name),v=m?parseInt(m[1],10):null;
  if(v===null){m=/^[A-Za-z]{1,2}([0-9A-Fa-f]{2})$/.exec(name);v=m?parseInt(m[1],16):null;}
  if(v===null||v<32||v>255)return null;return String.fromCharCode(cp1252[v]||v);}
function differences(page){var names={};
  function collect(res,depth){if(!res||depth>3)return;var fonts=res.get('Font');
    if(fonts&&fonts.isDictionary())fonts.forEach(function(f){if(!f.isDictionary())return;var e=f.get('Encoding');if(!e||!e.isDictionary())return;var d=e.get('Differences');if(!d||!d.isArray())return;
      var base=String(f.get('BaseFont')).replace(/^\//,''),map=names[base]||{},code=0;
      for(var i=0;i<d.length;i++){var v=d.get(i);if(v.isNumber())code=v.valueOf();else if(v.isName()){map[code]=String(v).replace(/^\//,'');code++;}}names[base]=map;});
    var xo=res.get('XObject');if(xo&&xo.isDictionary())xo.forEach(function(x){if(x.isStream()&&String(x.get('Subtype'))==='/Form')collect(x.get('Resources'),depth+1);});}
  collect(page.getObject().get('Resources'),0);return names;}
// MuPDF marks an unnamed character with flag 128 and gives its CID, which is the
// character code for a simple font. Its inserted word spaces carry the same flag,
// so a pass without inserted spaces tells them apart by origin.
function restoreFirstPage(page){var names=differences(page),A=[],B=[];
  page.toStructuredText('use-cid-for-unknown-unicode,preserve-whitespace,inhibit-spaces').walk({onChar:function(c,o){A.push([c.charCodeAt(0),o[0],o[1]]);}});
  page.toStructuredText('use-cid-for-unknown-unicode,preserve-whitespace').walk({beginTextBlock:function(){B.push(1);},beginLine:function(bbox){B.push([2,bbox]);},onChar:function(c,o,font,size,q,argb,flags){B.push([c,o[0],o[1],flags&128,font.getName(),size]);},endLine:function(){B.push(3);}});
  restorePasses+=2;
  function same(a,b){return a&&b&&typeof b==='object'&&b.length===6&&a[0]===b[0].charCodeAt(0)&&Math.abs(a[1]-b[1])<0.01&&Math.abs(a[2]-b[2])<0.01;}
  var text='',out=[],line=null,block=0,ai=0,restored=0;
  for(var j=0;j<B.length;j++){var b=B[j];
    if(b===1){block++;continue;}
    if(b===3){if(text.length<40000)text+='\n';if(line&&out.length<2000)out.push(line);line=null;continue;}
    if(b.length===2){line={text:'',font_size:0,bbox:b[1],block:block};continue;}
    var c=b[0];
    if(c===' '&&(!same(A[ai],b)||same(A[ai],B[j+1])))c=' ';
    else{if(!same(A[ai],b)){for(var k=1;k<=5&&ai+k<A.length;k++)if(same(A[ai+k],b)){ai+=k;break;}}ai++;
      if(b[3]){var map=names[b[4]],r=map?glyphChar(map[c.charCodeAt(0)]):null;if(r){c=r;restored++;}else c='\uFFFD';}
      else if(/^[\u0009\u00A0\u1680\u180E\u2000-\u200A\u202F\u205F\u3000]$/.test(c))c=' ';}
    if(text.length<40000)text+=c;
    if(line&&line.text.length<1000){line.text+=c;line.font_size=Math.max(line.font_size,b[5]);}}
  return {text:text,lines:out,restored:restored};}
for(var n=0;n<Math.min(2,doc.countPages());n++){
  if(n===1&&count(pages[0].text)>=200)break;
  var page=doc.loadPage(n),text='',line=null,block=0,unknown=0;
  if(n===0)bounds=page.getBounds();
  page.toStructuredText().walk({beginTextBlock:function(){block++;},beginLine:function(bbox){line={text:'',font_size:0,bbox:bbox,block:block};},onChar:function(c,origin,font,size){
    if(c==='\uFFFD')unknown++;
    if(text.length<40000)text+=c;
    if(n===0&&line&&line.text.length<1000){line.text+=c;line.font_size=Math.max(line.font_size,size);}
  },endLine:function(){if(text.length<40000)text+='\n';if(n===0&&line&&lines.length<2000)lines.push(line);line=null;}});
  if(n===0&&unknown>0){var restored=restoreFirstPage(page);if(restored.restored>0){text=restored.text;lines=restored.lines;}}
  pages.push({page_index:n,text:bounded(text,40000)});
}
print(JSON.stringify({info:info,xmp:xmp,pages:pages,first_page_lines:lines,bounds:bounds,restore_passes:restorePasses}));`;
/** The clue script, exported so tests can run it directly and see its passes. */
export const FILE_CLUE_SCRIPT = SCRIPT;

function xmlText(value: string): string {
  let plain = "",
    tag = false;
  for (const c of value) {
    if (c === "<") {
      tag = true;
      plain += " ";
    } else if (c === ">") tag = false;
    else if (!tag) plain += c;
  }
  return clueText(
    plain.replace(
      /&#(?:x([0-9a-f]+)|(\d+));|&(amp|lt|gt|quot|apos);/giu,
      (
        all,
        hex: string | undefined,
        dec: string | undefined,
        named: string | undefined,
      ) => {
        if (named)
          return (
            { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<
              string,
              string
            >
          )[named.toLowerCase()]!;
        const n = Number.parseInt(hex ?? dec!, hex ? 16 : 10);
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
          ? String.fromCodePoint(n)
          : all;
      },
    ),
  );
}
function xmpFields(source: string): FileClues["xmp"] {
  // Scan bounded, untrusted XML linearly, including malformed repeated tags.
  const lower = source.toLowerCase();
  const values = (key: string) => {
    const result: string[] = [];
    let offset = 0;
    while (offset < source.length) {
      const start = lower.indexOf(`<${key}`, offset);
      if (start < 0) break;
      offset = start + key.length + 1;
      if (!/[\s>]/u.test(source[offset] ?? "")) continue;
      const body = source.indexOf(">", offset);
      if (body < 0) break;
      let end = lower.indexOf(`</${key}`, body + 1);
      while (end >= 0 && !/[\s>]/u.test(source[end + key.length + 2] ?? ""))
        end = lower.indexOf(`</${key}`, end + key.length + 2);
      if (end < 0) break;
      const after = source.indexOf(">", end + key.length + 2);
      if (after < 0) break;
      const text = xmlText(source.slice(body + 1, end));
      if (text) result.push(text);
      offset = after + 1;
    }
    return result;
  };
  return {
    title: values("dc:title")[0] ?? null,
    identifier: values("dc:identifier")[0] ?? null,
    dois: [...values("prism:doi"), ...values("pdfx:doi")],
  };
}
function prominentTitles(lines: readonly Line[], bounds: readonly number[]) {
  const blocks: Line[] = [];
  for (const line of lines) {
    if (
      !Number.isFinite(line.font_size) ||
      line.font_size <= 0 ||
      line.bbox.length !== 4 ||
      !line.bbox.every(Number.isFinite) ||
      line.bbox[1]! >= (bounds[1]! + bounds[3]!) / 2
    )
      continue;
    const old = blocks.at(-1),
      text = clueText(line.text);
    if (!text) continue;
    if (
      old &&
      old.block === line.block &&
      Math.abs(old.font_size - line.font_size) < 1e-6 &&
      line.bbox[1]! >= old.bbox[1]! &&
      line.bbox[1]! - old.bbox[3]! <= line.font_size
    ) {
      old.text += ` ${text}`;
      old.bbox[3] = Math.max(old.bbox[3]!, line.bbox[3]!);
    } else blocks.push({ ...line, text, bbox: [...line.bbox] });
  }
  return blocks
    .filter((b) => {
      const n = [...b.text].length;
      return n >= 10 && n <= 300;
    })
    .sort((a, b) => b.font_size - a.font_size || a.bbox[1]! - b.bbox[1]!)
    .slice(0, 3)
    .map((b) => b.text);
}
function readTool(
  runtime: MupdfRuntime,
  script: string,
  descriptor: number,
  signal: AbortSignal,
): Promise<PdfClueOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "prlimit",
      [
        "--as=536870912",
        "--cpu=10",
        "--",
        runtime.executable,
        "run",
        script,
        "/proc/self/fd/3",
      ],
      {
        stdio: ["ignore", "pipe", "pipe", descriptor],
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      },
    );
    const chunks: Buffer[] = [];
    let size = 0,
      failed = false;
    const abort = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout!.on("data", (part: Buffer) => {
      size += part.length;
      if (size > 768 * 1024) abort();
      else chunks.push(part);
    });
    child.stderr!.resume();
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (failed || code !== 0) {
        reject(new Error("intake-clues-reader-failed"));
        return;
      }
      try {
        resolve(
          parseToolOutput(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
        );
      } catch (error) {
        reject(new Error("intake-clues-reader-output", { cause: error }));
      }
    });
  });
}
class ClueReaderMissing extends Error {
  constructor() {
    super("intake-clues-reader-unavailable");
  }
}
/**
 * The clue reason of a stored read, including reads saved before `unread`
 * existed: their `clues-unavailable` cannot tell a missing reader from a
 * failed one and counts as `reader-failed`.
 */
export function cluesUnreadReason(
  clues: Pick<FileClues, "status" | "reason"> & {
    readonly unread?: IntakeCluesUnreadReason | null;
  },
): IntakeCluesUnreadReason | null {
  if (clues.status === "read") return null;
  if (clues.unread) return clues.unread;
  if (clues.status === "image-only") return "image-only";
  if (clues.reason === "clues-timeout") return "reader-timeout";
  if (clues.reason === "encrypted-pdf") return "encrypted-pdf";
  if (clues.reason === "pdf-invalid" || clues.reason === "non-pdf-file")
    return "invalid-pdf";
  return "reader-failed";
}
/** Reads one already-scoped input, without catalogue, model or network access. */
export class FileClueReader {
  constructor(
    private readonly runtime: () => Promise<
      MupdfRuntime | undefined
    > = resolveMupdfRuntime,
    private readonly timeoutMs = 10_000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
      throw new Error("Invalid clue deadline");
  }
  async read(
    file: ScopedFileReader,
    fileName: string,
    signal?: AbortSignal,
  ): Promise<FileClues> {
    signal?.throwIfAborted();
    const base: FileClues = {
        file_name: clueText(
          fileName.replace(/\\/gu, "/").split("/").at(-1)!,
        ).replace(/\.[^.]+$/u, ""),
        status: "unavailable",
        reason: null,
        unread: null,
        info: { title: null, subject: null, keywords: null },
        xmp: { title: null, identifier: null, dois: [] },
        pages: [],
        prominent_titles: [],
        identifiers: [],
      },
      deadline = new AbortController(),
      stop = signal
        ? AbortSignal.any([signal, deadline.signal])
        : deadline.signal;
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs);
    const aborted = () => {
      if (signal?.aborted) throw signal.reason;
      return {
        ...base,
        reason: "clues-timeout" as const,
        unread: "reader-timeout" as const,
      };
    };
    let removeAbort = () => {};
    try {
      const operation = (async () => {
        let directory: string | undefined;
        try {
          await acceptPdfFile(file, this.timeoutMs, stop);
          const runtime = await this.runtime();
          stop.throwIfAborted();
          if (!runtime) throw new ClueReaderMissing();
          directory = await mkdtemp(join(tmpdir(), "sciretriever-file-clues-"));
          const script = join(directory, "read.js");
          await writeFile(script, SCRIPT, { mode: 0o600 });
          stop.throwIfAborted();
          return await file.withDescriptor((descriptor) =>
            readTool(runtime, script, descriptor, stop),
          );
        } finally {
          if (directory) await rm(directory, { recursive: true, force: true });
        }
      })();
      const output = await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          const abort = () => reject(stop.reason);
          removeAbort = () => stop.removeEventListener("abort", abort);
          stop.addEventListener("abort", abort, { once: true });
          if (stop.aborted) abort();
        }),
      ]);
      stop.throwIfAborted();
      const pages = output.pages.map((p) => ({
          page_index: p.page_index,
          text: clueText([...p.text].slice(0, 20000).join("")),
        })),
        xmp = xmpFields(Buffer.from(output.xmp, "latin1").toString("utf8")),
        info = {
          title: output.info.title ? clueText(output.info.title) : null,
          subject: output.info.subject ? clueText(output.info.subject) : null,
          keywords: output.info.keywords
            ? clueText(output.info.keywords)
            : null,
        };
      const metadataIds = uniqueIdentifiers(
          [
            ...xmp.dois,
            ...[xmp.identifier, info.title, info.subject, info.keywords].filter(
              (v): v is string => !!v,
            ),
          ].flatMap((v) => [...clueDois(v), ...clueArxiv(v)]),
        ),
        nameIds = uniqueIdentifiers([
          ...clueDois(base.file_name),
          ...clueArxiv(base.file_name),
        ]),
        pageIds = uniqueIdentifiers(
          pages.flatMap((p) => [...clueDois(p.text), ...clueArxiv(p.text)]),
        );
      const read = pages.some((p) => p.text);
      return {
        ...base,
        status: read ? "read" : "image-only",
        unread: read ? null : "image-only",
        info,
        xmp,
        pages,
        prominent_titles: prominentTitles(
          output.first_page_lines,
          output.bounds,
        ),
        identifiers: metadataIds.length
          ? metadataIds
          : nameIds.length
            ? nameIds
            : pageIds.length === 1
              ? pageIds
              : [],
      };
    } catch (error) {
      if (stop.aborted) return aborted();
      if (error instanceof PdfAcceptanceError) {
        const code = (error.cause as { code?: string } | undefined)?.code;
        if (code === "pdf-reader-timeout")
          return { ...base, reason: "clues-timeout", unread: "reader-timeout" };
        if (code && code !== "pdf-reader-cancelled")
          return {
            ...base,
            reason: "clues-unavailable",
            unread:
              code === "pdf-reader-unavailable"
                ? "reader-unavailable"
                : "reader-failed",
          };
        return {
          ...base,
          status: "rejected",
          reason: error.reason,
          unread:
            error.reason === "encrypted-pdf" ? "encrypted-pdf" : "invalid-pdf",
        };
      }
      return {
        ...base,
        reason: "clues-unavailable",
        unread:
          error instanceof ClueReaderMissing
            ? "reader-unavailable"
            : "reader-failed",
      };
    } finally {
      clearTimeout(timer);
      removeAbort();
    }
  }
}
