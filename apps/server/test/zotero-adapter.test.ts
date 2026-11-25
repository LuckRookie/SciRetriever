import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parseFolderNode } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { zoteroAdapter } from "../src/literature/zotero-adapter.js";
import { recognitionPdf } from "./intake-recognition-fixture.js";
import {
  A,
  COLLECTIONS,
  GROUP,
  GROUP_COLLECTIONS,
  GROUP_ITEM,
  PDF_A,
  PDF_A2,
  STANDALONE,
  USER,
  USER_ITEMS,
} from "./zotero-fixture.js";

const decode = (data: unknown) => zoteroAdapter.decode(data, 0);
const record = (result: ReturnType<typeof decode>, key: string) =>
  result.items.find((i) => i.external_id === key)!;

it("maps Zotero items, collections, tags, identifiers and the preferred PDF", () => {
  const result = decode({ items: USER_ITEMS, collections: COLLECTIONS });
  expect(result.groups).toEqual([
    {
      external_id: "COLL0001",
      parent_external_id: null,
      name: "Energetic materials",
    },
    {
      external_id: "COLL0002",
      parent_external_id: "COLL0001",
      name: "Tetrazoles",
    },
    { external_id: "COLL0003", parent_external_id: null, name: "Reviews" },
  ]);
  const a = record(result, "AAAA0001").record!;
  expect(a.metadata).toMatchObject({
    title: "Synthetic tetrazole salt A",
    publication_year: 2024,
    publication_date: "2024-03",
    venue: "Synthetic Journal of Energetic Materials",
    identifiers: [{ namespace: "doi", value: "10.5555/synth.0001" }],
    keywords: ["Crystal structure"],
  });
  expect(a.metadata.authors.map((x) => x.family_name)).toEqual([
    "Lin",
    "Okafor",
  ]);
  // Several collections, and the manual tag as a user tag.
  expect(a.groups).toEqual(["COLL0002", "COLL0003"]);
  expect(a.user_tags).toEqual(["tetrazole"]);
  expect(a.files).toEqual([
    {
      external_id: "PDFA0001",
      file_name: "Lin 2024 synthetic.pdf",
      media_type: "application/pdf",
      preferred: true,
      size_bytes: 482113,
      sha256: null,
      md5: "0f343b0931126a20f133d67c2b018a3b",
    },
  ]);
  // CSL refused (string year): Zotero fields, and the arXiv ID from Extra.
  const preprint = record(result, "BBBB0002").record!;
  expect(preprint.metadata).toMatchObject({
    title: "Synthetic furazan preprint B",
    publication_year: 2025,
    publisher: "arXiv",
    identifiers: [{ namespace: "arxiv", value: "2501.01234" }],
  });
  expect(preprint.files).toEqual([]);
  const book = record(result, "CCCC0003").record!;
  expect(book.metadata.identifiers).toEqual([
    { namespace: "doi", value: "10.5555/synth.book.0003" },
    { namespace: "pmid", value: "31234567" },
  ]);
  expect(book.metadata.keywords).toEqual(["handbook"]);
  expect(book.user_tags).toEqual([]);
  // No DOI at all: still an item with its title.
  const report = record(result, "EEEE0005").record!;
  expect(report.metadata).toMatchObject({
    title: "Synthetic report without identifiers E",
    identifiers: [],
  });
  expect(report.groups).toEqual(["COLL0001"]);
  // A standalone PDF is only its file.
  expect(record(result, "SOLO0001").record).toMatchObject({
    file_only: true,
    metadata: { title: null, identifiers: [] },
    files: [{ external_id: "SOLO0001", file_name: "untitled scan.pdf" }],
  });
  expect(result.items.map((i) => i.external_id).sort()).toEqual(
    ["AAAA0001", "BBBB0002", "CCCC0003", "EEEE0005", "SOLO0001"].sort(),
  );
  expect(
    Object.fromEntries(result.excluded.map((e) => [e.kind, e.count])),
  ).toEqual({
    "additional-file": 1,
    note: 1,
    "linked-file": 1,
    "linked-url": 1,
    "non-pdf-file": 1,
    "trashed-item": 2,
    annotation: 5,
  });
});

it("prefers links.attachment, else the earliest stored PDF, and reads a group library alike", () => {
  const second = {
    ...A,
    links: {
      ...A.links,
      attachment: {
        href: `https://api.zotero.org/users/${USER}/items/PDFA0002`,
        type: "application/json",
        attachmentType: "application/pdf",
      },
    },
  };
  expect(
    record(decode({ items: [second, PDF_A, PDF_A2] }), "AAAA0001").record!
      .files[0],
  ).toMatchObject({
    external_id: "PDFA0002",
    file_name: "si.pdf",
    size_bytes: null,
  });
  const { links, ...bare } = A;
  void links;
  const later = {
    ...PDF_A,
    data: { ...PDF_A.data, dateAdded: "2026-03-01T00:00:00Z" },
  };
  expect(
    record(decode({ items: [bare, later, PDF_A2] }), "AAAA0001").record!
      .files[0]!.external_id,
  ).toBe("PDFA0002");
  const group = decode({ items: [GROUP_ITEM], collections: GROUP_COLLECTIONS });
  expect(group.groups).toEqual([
    {
      external_id: "GCOL0001",
      parent_external_id: null,
      name: "Shared reading",
    },
  ]);
  expect(record(group, "GGGG0001").record).toMatchObject({
    metadata: {
      identifiers: [{ namespace: "doi", value: "10.5555/synth.group.0001" }],
    },
    groups: ["GCOL0001"],
    user_tags: ["shared"],
  });
  expect(GROUP_ITEM.library).toMatchObject({ type: "group", id: GROUP });
  // A child sent without its parent is counted, not guessed.
  expect(decode({ items: [PDF_A] }).excluded).toEqual([
    { kind: "child-without-parent", count: 1 },
  ]);
  expect(() => decode({ items: [], extra: [] })).toThrow();
  expect(() => decode("not data")).toThrow();
});

it("imports a Zotero library through the intake batch: folders, tags, files and a standalone PDF", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-zotero-"));
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    metadata: { lookup_ports: [], topic_search_ports: [] },
  });
  // No source port exists: recognition of the standalone PDF stays offline.
  expect(app.metadata.lookup_selection).toEqual([]);
  expect(app.metadata.topic_selection).toEqual([]);
  const actor = { kind: "local" as const, origin: "web" as const };
  const source = {
    system: "zotero",
    library_id: `users/${USER}`,
    identity: "global" as const,
    name: "synthetic-user",
  };
  try {
    await expect(
      app.importSessions.create(
        { format: "zotero-api", source: null, scope: "Zotero" },
        actor,
      ),
    ).rejects.toMatchObject({ code: "intake-input-invalid" });
    const batch = await app.importSessions.create(
      { format: "zotero-api", source, scope: "Synthetic Zotero library" },
      actor,
    );
    const id = batch.batch_id;
    await app.importSessions.putData(id, 0, { collections: COLLECTIONS });
    await app.importSessions.putData(id, 1, { items: USER_ITEMS });
    async function* bytes(value: Uint8Array) {
      yield value;
    }
    await app.importSessions.receiveFileItem(
      id,
      "untitled scan.pdf",
      null,
      bytes(recognitionPdf({ info: { title: "Synthetic standalone scan" } })),
    );
    await vi.waitFor(
      async () =>
        expect((await app.importSessions.preview(id)).recognition.state).toBe(
          "done",
        ),
      { timeout: 20000, interval: 30 },
    );
    const preview = await app.importSessions.preview(id);
    expect(preview.summary.records).toMatchObject({ created: 5, rejected: 0 });
    expect(preview.summary.files.unpaired).toBe(0);
    await app.importSessions.confirm(id);
    const report = await app.importSessions.report(id, null, 200);
    expect(report.summary.records).toMatchObject({ created: 5, rejected: 0 });
    expect(report.summary.excluded).toEqual(
      expect.arrayContaining([
        { kind: "additional-file", count: 1 },
        { kind: "note", count: 1 },
        { kind: "linked-file", count: 1 },
        { kind: "linked-url", count: 1 },
        { kind: "non-pdf-file", count: 1 },
        { kind: "trashed-item", count: 2 },
        { kind: "annotation", count: 5 },
      ]),
    );
    const files = (await app.importSessions.missingFiles(id)).items;
    expect(
      files.map((f) => [f.external_id, f.file_name, f.size_bytes]),
    ).toEqual([["PDFA0001", "Lin 2024 synthetic.pdf", 482113]]);
    const folders = (
      (await app.folders.query({ operation: "list", request: {} })) as {
        items: unknown[];
      }
    ).items.map(parseFolderNode);
    const name = (id: string | null) =>
      folders.find((f) => f.folder_id === id)?.name ?? null;
    expect(
      folders.map((f) => `${name(f.parent_id) ?? "-"}/${f.name}`).sort(),
    ).toEqual(
      [
        "-/synthetic-user",
        "synthetic-user/Energetic materials",
        "Energetic materials/Tetrazoles",
        "synthetic-user/Reviews",
        "synthetic-user/标签",
        "标签/tetrazole",
      ].sort(),
    );
    const found = (await app.library.search({ query: {} })).items;
    expect(found).toHaveLength(5);
    expect(found.every((i) => i.collected)).toBe(true);
    const scan = found.find((i) => i.needs_metadata);
    expect(scan).toBeDefined();

    // Without its bytes a standalone PDF is reported, never guessed.
    await app.importSessions.finish(id);
    const second = await app.importSessions.create(
      {
        format: "zotero-api",
        source: {
          ...source,
          library_id: `groups/${GROUP}`,
          name: "synthetic-group",
        },
        scope: "Synthetic group",
      },
      actor,
    );
    await app.importSessions.putData(second.batch_id, 0, {
      items: [STANDALONE],
    });
    await app.importSessions.confirm(second.batch_id);
    expect(
      (await app.importSessions.report(second.batch_id, null, 200)).items,
    ).toMatchObject([
      {
        external_id: "SOLO0001",
        disposition: "excluded",
        reason: "standalone-file-missing",
      },
    ]);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 60000);

it("pairs two standalone PDFs of the same file name by their attachment IDs", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-zotero-pair-"));
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    metadata: { lookup_ports: [], topic_search_ports: [] },
  });
  expect(app.metadata.lookup_selection).toEqual([]);
  expect(app.metadata.topic_selection).toEqual([]);
  const actor = { kind: "local" as const, origin: "web" as const };
  const twin = {
    ...STANDALONE,
    key: "SOLO0002",
    data: { ...STANDALONE.data, key: "SOLO0002" },
  };
  async function* bytes(value: Uint8Array) {
    yield value;
  }
  try {
    const batch = await app.importSessions.create(
      {
        format: "zotero-api",
        source: {
          system: "zotero",
          library_id: `users/${USER}`,
          identity: "global",
          name: "synthetic-user",
        },
        scope: "Two scans",
      },
      actor,
    );
    const id = batch.batch_id;
    await app.importSessions.putData(id, 0, { items: [STANDALONE, twin] });
    for (const [key, title] of [
      ["SOLO0002", "Second synthetic scan about salts"],
      ["SOLO0001", "First synthetic scan about furazans"],
    ] as const)
      await app.importSessions.receiveFileItem(
        id,
        "untitled scan.pdf",
        `storage/${key}/untitled scan.pdf`,
        bytes(recognitionPdf({ info: { title } })),
      );
    await vi.waitFor(
      async () =>
        expect((await app.importSessions.preview(id)).recognition.state).toBe(
          "done",
        ),
      { timeout: 20000, interval: 30 },
    );
    const preview = await app.importSessions.preview(id);
    expect(preview.summary.files.unpaired).toBe(0);
    expect(preview.summary.records.created).toBe(2);
    const items = (await app.importSessions.items(id)).items;
    expect(
      items.filter((i) => i.origin === "file" && !i.unpaired),
    ).toHaveLength(2);
    expect(
      items.some((i) => i.external_id === "SOLO0001" && i.origin === "data"),
    ).toBe(false);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 60000);

it("leaves out a membership in a collection the batch never received", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-zotero-scope-"));
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    metadata: { lookup_ports: [], topic_search_ports: [] },
  });
  expect(app.metadata.lookup_selection).toEqual([]);
  expect(app.metadata.topic_selection).toEqual([]);
  const actor = { kind: "local" as const, origin: "web" as const };
  try {
    const { links, ...bare } = A;
    void links;
    const batch = await app.importSessions.create(
      {
        format: "zotero-api",
        source: {
          system: "zotero",
          library_id: `users/${USER}`,
          identity: "global",
          name: "synthetic-user",
        },
        scope: "One collection",
      },
      actor,
    );
    // A is in COLL0002 (sent, with its parent) and COLL0003 (not sent).
    await app.importSessions.putData(batch.batch_id, 0, {
      collections: COLLECTIONS.filter((c) => c.key !== "COLL0003"),
      items: [bare],
    });
    await app.importSessions.confirm(batch.batch_id);
    const report = await app.importSessions.report(batch.batch_id, null, 200);
    expect(report.batch.state).toBe("finished");
    expect(report.items).toMatchObject([
      { external_id: "AAAA0001", disposition: "created" },
    ]);
    const folders = (
      (await app.folders.query({ operation: "list", request: {} })) as {
        items: unknown[];
      }
    ).items.map(parseFolderNode);
    expect(folders.map((f) => f.name).sort()).toEqual(
      [
        "Energetic materials",
        "Tetrazoles",
        "synthetic-user",
        "标签",
        "tetrazole",
      ].sort(),
    );
    expect(folders.find((f) => f.name === "Tetrazoles")!.own_count).toBe(1);
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 60000);
