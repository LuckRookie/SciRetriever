import { expect, it } from "vitest";
import {
  dropProblem,
  encodingProblem,
  fileHeaders,
  hiddenInFolder,
  sortDrop,
} from "../src/app/data/intake-drop.js";
import { initiator, readSummary } from "../src/app/data/imports.js";
import type { DeviceConnection } from "../src/app/data/devices.js";

const file = (name: string, content: string | Uint8Array<ArrayBuffer>) =>
  new File([content], name);

it("recognizes PDFs by name or content, exports by the contract's rules, and nothing else (page specs “入库 · 文件”)", async () => {
  const sorted = await sortDrop([
    { file: file("paper.PDF", "not really"), path: null },
    { file: file("scan_0041", "%PDF-1.7\n..."), path: null },
    { file: file("library.bib", "@article{a,title={A}}"), path: null },
    { file: file("export.txt", "TY  - JOUR\nTI  - A\nER  - \n"), path: null },
    // An export by its name: the contract reads `.json` as CSL JSON.
    { file: file("items.json", '{"items": []}'), path: null },
    // No extension: the opening tells the format.
    { file: file("cnki", "\n%0 Journal Article\n%T A\n"), path: null },
    { file: file("notes.txt", "salt, flour"), path: null },
    {
      file: file("figure.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
      path: null,
    },
  ]);
  expect(sorted.pdfs.map((d) => d.file.name)).toEqual([
    "paper.PDF",
    "scan_0041",
  ]);
  expect(sorted.exports.map((d) => [d.file.name, d.format])).toEqual([
    ["library.bib", "bibtex"],
    ["export.txt", "ris"],
    ["items.json", "csl-json"],
    ["cnki", "endnote-tagged"],
  ]);
  expect(sorted.unknown.map((d) => d.file.name)).toEqual([
    "notes.txt",
    "figure.png",
  ]);
  expect(dropProblem(sorted)).toBe("一次只接受一个导出文件，这次放进了 4 个。");
  expect(
    dropProblem({ pdfs: [], unknown: [], exports: sorted.exports.slice(0, 1) }),
  ).toBeNull();
});

// “中文” in GB18030, inside an otherwise ASCII NoteExpress record.
const gb18030 = (before: string, after: string) =>
  new Uint8Array([
    ...new TextEncoder().encode(before),
    0xd6,
    0xd0,
    0xce,
    0xc4,
    ...new TextEncoder().encode(after),
  ]);

it("reads EndNote and NoteExpress exports from the file to the format the batch is made with (literature materials 6.4.14)", async () => {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<xml><records><record><titles><title>A</title></titles></record></records></xml>';
  const sorted = await sortDrop([
    { file: file("library.enw", "%0 Journal Article\n%T A\n"), path: null },
    { file: file("library.xml", xml), path: null },
    {
      file: file(
        "CNKI-NoteExpress.txt",
        gb18030("{Reference Type}: Journal Article\r\n{Title}: ", "\r\n"),
      ),
      path: null,
    },
    // An `.net` is NoteExpress by its name alone.
    { file: file("library.net", "{Title}: B\n"), path: null },
  ]);
  expect(
    sorted.exports.map((d) => [d.file.name, d.format, d.encoding]),
  ).toEqual([
    ["library.enw", "endnote-tagged", "utf-8"],
    ["library.xml", "endnote-xml", "utf-8"],
    ["CNKI-NoteExpress.txt", "noteexpress", "gb18030"],
    ["library.net", "noteexpress", "utf-8"],
  ]);
  // The batch's data is the decoded text, not the bytes read as UTF-8.
  expect(sorted.exports[2]!.text).toBe(
    "{Reference Type}: Journal Article\r\n{Title}: 中文\r\n",
  );
  for (const exported of sorted.exports)
    expect(encodingProblem(exported, exported.format!)).toBeNull();
});

it("leaves a loose XML it cannot read to a format chosen by hand, and says why a chosen format refuses the encoding", async () => {
  const other = '<?xml version="1.0"?>\n<catalog><book/></catalog>';
  const loose = await sortDrop([
    { file: file("catalog.xml", other), path: null },
  ]);
  expect(loose.exports.map((d) => [d.file.name, d.format])).toEqual([
    ["catalog.xml", null],
  ]);
  // Inside a folder it is only a file not recognized.
  const inFolder = await sortDrop([
    { file: file("catalog.xml", other), path: "Library/catalog.xml" },
  ]);
  expect(inFolder.exports).toEqual([]);
  expect(inFolder.unknown.map((d) => d.file.name)).toEqual(["catalog.xml"]);
  // GB18030 is read for the text formats; CSL JSON takes UTF-8 only.
  const [json] = (
    await sortDrop([
      {
        file: file("items.json", gb18030('[{"type":"book","title":"', '"}]')),
        path: null,
      },
    ])
  ).exports;
  expect([json!.format, json!.encoding]).toEqual(["csl-json", "gb18030"]);
  expect(encodingProblem(json!, "csl-json")).toBe(
    "这个文件不是 UTF-8 编码，CSL JSON 只接受 UTF-8；请另存为 UTF-8 后再放入，或选择别的格式。",
  );
  expect(encodingProblem(json!, "ris")).toBeNull();
});

it("reads a batch's annotations as they stand only where the batch has them (literature materials 6.4.13)", () => {
  const base = {
    records: {},
    files: {},
    excluded: [{ kind: "annotation-standalone-file", count: 2 }],
  };
  const reasons = {
    "unsupported-kind": 1,
    "annotation-other-file": 0,
    "pdf-differs": 3,
    "file-missing": 0,
    "position-invalid": 0,
    "comment-too-long": 0,
    "quote-invalid": 0,
    "already-imported": 4,
  };
  // Not a Zotero batch: the four counts only, no detail.
  expect(
    readSummary({
      ...base,
      annotations: { supported: 0, unsupported: 0, imported: 0, deferred: 0 },
    }).annotations.detail,
  ).toBeNull();
  // A Zotero batch without annotations has nothing to show either.
  expect(
    readSummary({
      ...base,
      annotations: {
        supported: 0,
        unsupported: 0,
        imported: 0,
        deferred: 0,
        importable: 0,
        by_reason: Object.fromEntries(
          Object.keys(reasons).map((reason) => [reason, 0]),
        ),
      },
    }).annotations.detail,
  ).toBeNull();
  expect(
    readSummary({
      ...base,
      annotations: {
        supported: 9,
        unsupported: 1,
        imported: 5,
        deferred: 2,
        importable: 7,
        by_reason: reasons,
      },
    }).annotations.detail,
  ).toEqual({
    importable: 7,
    imported: 5,
    // In the contract's order, those that occurred.
    reasons: [
      ["unsupported-kind", 1],
      ["pdf-differs", 3],
      ["already-imported", 4],
    ],
  });
});

it("names each file and gives its folder path only in the form the service takes", () => {
  const pdf = file("paired one.pdf", "%PDF-");
  expect(fileHeaders({ file: pdf, path: null })).toEqual({
    "X-Sciretriever-File-Name": "paired%20one.pdf",
  });
  expect(
    fileHeaders({ file: pdf, path: "My Library/files/7/paired one.pdf" }),
  ).toEqual({
    "X-Sciretriever-File-Name": "paired%20one.pdf",
    "X-Sciretriever-Relative-Path":
      "My%20Library%2Ffiles%2F7%2Fpaired%20one.pdf",
  });
  for (const path of [
    "a/../paired one.pdf",
    "a//paired one.pdf",
    "a/other.pdf",
  ])
    expect(fileHeaders({ file: pdf, path })).not.toHaveProperty(
      "X-Sciretriever-Relative-Path",
    );
  // A folder's system files are left out; a loose file of that name is not.
  expect(
    hiddenInFolder({ file: file(".DS_Store", ""), path: "a/.DS_Store" }),
  ).toBe(true);
  expect(hiddenInFolder({ file: file(".DS_Store", ""), path: null })).toBe(
    false,
  );
});

it("names a device that started a batch by its kind: extension, Agent, or a device from before kinds", () => {
  const device = (
    connection_id: string,
    name: string,
    kind: DeviceConnection["kind"],
  ): DeviceConnection => ({
    connection_id,
    name,
    kind,
    purposes: ["intake"],
    created_at: "2026-11-17T00:00:00.000Z",
    paired_at: "2026-11-17T00:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
  });
  const devices = [
    device("00000000-0000-4000-8000-0000000000e1", "Chrome", "extension"),
    device("00000000-0000-4000-8000-0000000000e2", "笔记本", "agent"),
    device("00000000-0000-4000-8000-0000000000e3", "旧电脑", null),
  ];
  const by = (initiated_by: string) =>
    initiator({ initiated_by } as Parameters<typeof initiator>[0], devices);
  expect(by("device:00000000-0000-4000-8000-0000000000e1")).toBe(
    "扩展 · Chrome",
  );
  expect(by("device:00000000-0000-4000-8000-0000000000e2")).toBe(
    "Agent · 笔记本",
  );
  expect(by("device:00000000-0000-4000-8000-0000000000e3")).toBe(
    "设备 · 旧电脑",
  );
  expect(by("local:cli")).toBe("CLI");
});
