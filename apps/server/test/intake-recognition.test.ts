import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  EMPTY_METADATA,
  parseMetadataObservation,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import {
  IntakeRecognitionService,
  recognitionSimilarity,
} from "../src/literature/intake-recognition.js";
import { recognitionPdf } from "./intake-recognition-fixture.js";
import { runCli } from "../src/cli/main.js";

function observation(
  source = "crossref",
  title = "Synthetic identity article",
  doi = "10.5555/recognition",
) {
  return parseMetadataObservation({
    observation_id: crypto.randomUUID(),
    metadata: {
      ...EMPTY_METADATA,
      title,
      publication_year: 2026,
      identifiers: [{ namespace: "doi", value: doi }],
    },
    provenance: {
      provenance_id: crypto.randomUUID(),
      source_kind: "metadata-provider",
      source_name: source,
      source_record_id: doi,
      observed_at: "2026-11-15T00:00:00Z",
      input_sha256: "a".repeat(64),
      parameters_sha256: null,
    },
    source_type: null,
    source_type_mapping_version: null,
    version_role: null,
    version_links: [],
    declared_keywords: [],
    reference_texts: [],
    reference_count: null,
    cited_by_count: null,
    asset_hints: [],
  });
}
it("recognizes a checked identifier, rejects a cited title and falls back to exact title with year evidence", async () => {
  const search = vi.fn(async () => [observation()]);
  const service = new IntakeRecognitionService({
    lookup: async () => [observation()],
    search,
  });
  const clues = {
    identifiers: [{ namespace: "doi", value: "10.5555/recognition" }],
    titles: ["Synthetic identity article"],
    text: "Synthetic identity article by Tester in 2026",
    corroboration: "Tester 2026",
    fallback: "Unknown",
  };
  expect(
    (await service.recognize(clues, new AbortController().signal)).recognition,
  ).toMatchObject({ state: "recognized", step: 2 });
  expect(search).not.toHaveBeenCalled();
  const mismatch = new IntakeRecognitionService({
    lookup: async () => [observation("crossref", "An unrelated cited work")],
    search,
  });
  expect(
    (await mismatch.recognize(clues, new AbortController().signal)).recognition,
  ).toMatchObject({ state: "recognized", step: 3 });
  expect(search).toHaveBeenCalledOnce();
  expect(recognitionSimilarity("Ａ: Test!", "a test")).toBe(1);
  expect(recognitionSimilarity("", "")).toBe(0);
});
it("says no-metadata-source when nothing could be asked, and only then", async () => {
  const lookup = vi.fn(async () => []),
    search = vi.fn(async () => []);
  const clues = {
    identifiers: [{ namespace: "doi", value: "10.5555/recognition" }],
    titles: ["Synthetic identity article"],
    text: "",
    corroboration: "",
    fallback: "Synthetic identity article",
  } as const;
  const none = new IntakeRecognitionService({
    lookup,
    search,
    configured: () => ({ lookup: false, search: false }),
  });
  const unasked = await none.recognize(clues, new AbortController().signal);
  expect(unasked.recognition).toEqual({
    state: "unrecognized",
    step: 4,
    literature_id: null,
    candidates: [],
    reason: "no-metadata-source",
  });
  expect(
    (
      await none.recognizeNamed(
        { title: "Synthetic identity article" },
        EMPTY_METADATA,
        new AbortController().signal,
      )
    ).recognition.reason,
  ).toBe("no-metadata-source");
  expect(lookup).not.toHaveBeenCalled();
  expect(search).not.toHaveBeenCalled();
  // A configured source that found nothing is an ordinary unrecognized.
  const some = new IntakeRecognitionService({
    lookup,
    search,
    configured: () => ({ lookup: true, search: false }),
  });
  expect(
    (await some.recognize(clues, new AbortController().signal)).recognition,
  ).not.toHaveProperty("reason");
  expect(lookup).toHaveBeenCalled();
});
it("lists conflicting or merely similar candidates without adopting either source automatically", async () => {
  const service = new IntakeRecognitionService({
    lookup: async () => [],
    search: async () => [
      observation(),
      observation("openalex", "Synthetic identity article", "10.5555/other"),
    ],
  });
  const result = await service.recognize(
    {
      identifiers: [],
      titles: ["Synthetic identity article"],
      text: "",
      corroboration: "2026",
      fallback: "Fallback",
    },
    new AbortController().signal,
  );
  expect(result.recognition.state).toBe("candidates");
  expect(result.metadata.title).toBe("Fallback");
  expect(result.candidates).toHaveLength(2);
  expect(result.recognition.candidates[0]!.source_name).toBe("crossref");
});
it.each(["source-failed", "source-rate-limited"])(
  "continues from %s to title lookup and keeps a fallback when no source succeeds",
  async (code) => {
    const search = vi.fn(async () => []);
    const service = new IntakeRecognitionService({
      lookup: async () => {
        throw Object.assign(new Error("Synthetic source failure"), { code });
      },
      search,
    });
    const result = await service.recognize(
      {
        identifiers: [{ namespace: "doi", value: "10.5555/failure" }],
        titles: ["Fallback title"],
        text: "",
        corroboration: "2026",
        fallback: "Fallback title",
      },
      new AbortController().signal,
    );
    expect(search).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      metadata: { title: "Fallback title", identifiers: [] },
      recognition: { state: "unrecognized", step: 4 },
    });
  },
);
async function* bytes(value: Uint8Array) {
  yield value;
}
it("does not merge different file hashes just because their temporary titles are identical", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-file-identity-"));
  const app = await createApplication(root, {
    indexRefreshIntervalMs: null,
    metadata: { lookup_ports: [], topic_search_ports: [] },
  });
  try {
    for (const text of ["First distinct body", "Second distinct body"]) {
      const batch = await app.importSessions.create(
        { format: "file", source: null, scope: "Synthetic" },
        { kind: "local", origin: "cli" },
      );
      const item = await app.importSessions.receiveFileItem(
        batch.batch_id,
        "same.pdf",
        null,
        bytes(
          recognitionPdf({
            info: { title: "Same incomplete title" },
            pages: [[{ text }]],
          }),
        ),
      );
      await vi.waitFor(
        async () =>
          expect(
            (await app.importSessions.preview(batch.batch_id)).recognition
              .state,
          ).toBe("done"),
        { timeout: 20000, interval: 30 },
      );
      await app.importSessions.confirm(batch.batch_id);
      if (text === "Second distinct body") {
        // The identical incomplete title now requires an explicit duplicate
        // choice. It must still be possible to keep two different PDFs apart.
        expect(
          (await app.importSessions.report(batch.batch_id)).summary.records
            .pending_decision,
        ).toBe(1);
        await app.importSessions.decide(
          batch.batch_id,
          item.item_id,
          { kind: "new" },
          { kind: "local", origin: "cli" },
        );
      }
    }
    expect((await app.library.search({ query: {} })).total_count).toBe(2);
    expect(
      (await app.library.search({ query: { needs_metadata: true } }))
        .total_count,
    ).toBe(2);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 40000);
it("stages one synthetic PDF, keeps preview read-only, admits it and deduplicates identical bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-intake-file-"));
  const app = await createApplication(root, {
    indexRefreshIntervalMs: null,
    metadata: { lookup_ports: [], topic_search_ports: [] },
  });
  try {
    const pdf = recognitionPdf({ info: { title: "Synthetic file identity" } });
    for (let index = 0; index < 2; index++) {
      const batch = await app.importSessions.create(
        { format: "file", source: null, scope: "Synthetic" },
        { kind: "local", origin: "cli" },
      );
      const item = await app.importSessions.receiveFileItem(
        batch.batch_id,
        "Synthetic.pdf",
        null,
        bytes(pdf),
      );
      expect(item.origin).toBe("file");
      if (!index)
        expect((await app.library.search({ query: {} })).total_count).toBe(0);
      await vi.waitFor(
        async () =>
          expect(
            (await app.importSessions.preview(batch.batch_id)).recognition
              .state,
          ).toBe("done"),
        { timeout: 20000, interval: 30 },
      );
      if (!index) {
        expect((await app.library.search({ query: {} })).total_count).toBe(0);
        // No bibliographic source is configured: said, not left blank.
        expect(
          (await app.importSessions.preview(batch.batch_id)).recognition,
        ).toMatchObject({ state: "done", reason: "no-metadata-source" });
        const [listed] = (await app.importSessions.items(batch.batch_id)).items;
        expect(listed!.recognition).toMatchObject({
          state: "unrecognized",
          step: 4,
          reason: "no-metadata-source",
        });
      }
      const done = await app.importSessions.confirm(batch.batch_id);
      expect(done).toMatchObject({ state: "finished", result: "completed" });
      expect(
        (await app.importSessions.report(batch.batch_id)).summary.records[
          index ? "matched" : "created"
        ],
      ).toBe(1);
    }
    const found = await app.library.search({ query: { needs_metadata: true } });
    expect(found.total_count).toBe(1);
    expect(found.items[0]!.needs_metadata).toBe(true);
    expect(
      (await app.library.detail(found.items[0]!.literature.literature_id))
        .primary_pdf,
    ).not.toBeNull();
    const printed: string[] = [];
    const queried = await runCli(
      ["literature", "search", "--needs-metadata", "--json"],
      { home: root, stdout: (value) => printed.push(value), stderr: () => {} },
    );
    expect(queried.code).toBe(0);
    expect(JSON.parse(printed.join("")).items).toHaveLength(1);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}, 40000);
