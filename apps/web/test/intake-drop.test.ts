import { expect, it } from "vitest";
import {
  dropProblem,
  fileHeaders,
  hiddenInFolder,
  sortDrop,
} from "../src/app/data/intake-drop.js";
import { initiator } from "../src/app/data/imports.js";
import type { DeviceConnection } from "../src/app/data/devices.js";

const file = (name: string, content: string | Uint8Array<ArrayBuffer>) =>
  new File([content], name);

it("recognizes PDFs by name or content, exports by name or content, and nothing else (page specs “入库 · 文件”)", async () => {
  const sorted = await sortDrop([
    { file: file("paper.PDF", "not really"), path: null },
    { file: file("scan_0041", "%PDF-1.7\n..."), path: null },
    { file: file("library.bib", "@article{a,title={A}}"), path: null },
    { file: file("export.txt", "TY  - JOUR\nTI  - A\nER  - \n"), path: null },
    { file: file("items.json", '{"items": []}'), path: null },
    {
      file: file("csl", '[{"type": "article-journal", "title": "A"}]'),
      path: null,
    },
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
    // An export by its name whose format the content does not tell.
    ["items.json", null],
    ["csl", "csl-json"],
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
