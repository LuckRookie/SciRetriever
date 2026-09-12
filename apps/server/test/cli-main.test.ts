import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseAsset,
  parseLiterature,
  parseReference,
  sha256,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { runCli } from "../src/cli/main.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

async function* input(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

describe("TypeScript CLI", () => {
  it("migrates and inspects the durable runtime without a Python process", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-cli-"));
    const output: string[] = [];
    try {
      const migrated = await runCli(["storage", "migrate"], {
        home,
        stdout: (text) => output.push(text),
      });
      expect(migrated.code).toBe(0);
      expect(migrated.value).toMatchObject({
        action: "migrated",
        migrated: true,
      });
      const inspected = await runCli(["storage", "inspect"], { home });
      expect(inspected.code).toBe(0);
      expect(inspected.value).toMatchObject({ migrated: true });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("runs a persisted job through the TypeScript task service", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-cli-jobs-"));
    try {
      expect((await runCli(["storage", "migrate"], { home })).code).toBe(0);
      const created = await runCli(
        ["jobs", "create", "--idempotency", "cli-job-1"],
        { home },
      );
      expect(created.code).toBe(0);
      const jobId = (created.value as { job_id: string }).job_id;
      const result = await runCli(["jobs", "run", jobId], { home });
      expect(result.code).toBe(0);
      expect(result.value).toMatchObject({ job_id: jobId, results: [] });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("imports bibliographic metadata and exposes the same query through CLI", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-cli-import-"));
    const source = join(home, "records.bib");
    try {
      await writeFile(
        source,
        "@article{one, title={CLI paper}, author={Lovelace, Ada}, year={2026}, doi={10.1234/cli}}",
      );
      const beforeBytes = await readFile(source);
      const before = await stat(source);
      const imported = await runCli(
        ["import", "metadata", source, "--format", "bibtex"],
        {
          home,
        },
      );
      expect(imported.code).toBe(0);
      expect(imported.value).toMatchObject({
        items: [{ disposition: "created" }],
      });
      expect(await readFile(source)).toEqual(beforeBytes);
      const after = await stat(source);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      const searched = await runCli(
        ["literature", "search", "--text", "CLI paper"],
        {
          home,
        },
      );
      expect(searched.code).toBe(0);
      expect(searched.value).toMatchObject({
        items: [{ literature: { metadata: { title: "CLI paper" } } }],
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("imports metadata from stdin and writes a raw bibliography to stdout", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-cli-pipes-"));
    const source = Buffer.from(
      "@article{pipe, title={Piped paper}, year={2026}, doi={10.1234/pipe}}",
    );
    try {
      const imported = await runCli(
        ["import", "metadata", "bibtex", "-", "--json"],
        { home, stdin: input(source) },
      );
      expect(imported.code).toBe(0);
      const raw: Buffer[] = [];
      const text: string[] = [];
      const exported = await runCli(
        ["export", "metadata", "csl-json", "-", "--query", "Piped"],
        {
          home,
          stdout: (value) => text.push(value),
          stdoutBytes: (value) => raw.push(Buffer.from(value)),
        },
      );
      expect(exported.code).toBe(0);
      expect(text).toEqual([]);
      expect(JSON.parse(Buffer.concat(raw).toString())).toMatchObject([
        { title: "Piped paper", DOI: "10.1234/pipe" },
      ]);
      await expect(
        runCli(
          ["export", "metadata", "csl-json", "-", "--query", "Piped", "--json"],
          { home },
        ),
      ).resolves.toMatchObject({ code: 2 });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("streams raw artifacts to stdout and rejects raw output with JSON mode", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-cli-artifact-"));
    const bytes = Buffer.from("%PDF-1.4\nsynthetic-cli-export\n%%EOF\n");
    const app = await createApplication(home);
    try {
      await app.database.putLiterature(FIXTURE_LITERATURE);
      const stage = await app.files.stage({ maxBytes: bytes.length });
      await stage.write(bytes);
      await app.files.publish(stage, "objects/cli.pdf");
      const asset = parseAsset({
        asset_id: id(700),
        sha256: await sha256(bytes),
        size_bytes: bytes.length,
        media_type: "application/pdf",
        path: "objects/cli.pdf",
      });
      await app.database.putLiteratureAsset({
        literature_asset_id: id(701),
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset,
        role: "primary-pdf",
        source_url: null,
        provenance: {
          provenance_id: id(702),
          source_kind: "user",
          source_name: "cli-fixture",
          source_record_id: null,
          observed_at: "2026-09-11T00:00:00Z",
          input_sha256: asset.sha256,
          parameters_sha256: null,
        },
      });
    } finally {
      await app.close();
    }
    try {
      const raw: Buffer[] = [];
      const exported = await runCli(
        ["export", "pdf", FIXTURE_LITERATURE.literature_id, "-"],
        { home, stdoutBytes: (value) => raw.push(Buffer.from(value)) },
      );
      expect(exported.code).toBe(0);
      expect(Buffer.concat(raw)).toEqual(bytes);
      await expect(
        runCli(
          ["export", "pdf", FIXTURE_LITERATURE.literature_id, "-", "--json"],
          { home },
        ),
      ).resolves.toMatchObject({ code: 2 });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("passes an opaque literature cursor through the CLI query boundary", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-cli-cursor-"));
    const newer = join(home, "newer.bib");
    const older = join(home, "older.bib");
    try {
      await writeFile(
        newer,
        "@article{one, title={Newer paper}, year={2026}, doi={10.1234/cursor.one}}",
      );
      await writeFile(
        older,
        "@article{two, title={Older paper}, year={2025}, doi={10.1234/cursor.two}}",
      );
      for (const source of [newer, older])
        expect(
          (
            await runCli(["import", "metadata", source, "--format", "bibtex"], {
              home,
            })
          ).code,
        ).toBe(0);
      const first = await runCli(["literature", "search", "--limit", "1"], {
        home,
      });
      const firstPage = first.value as {
        items: readonly { literature: { literature_id: string } }[];
        next_cursor: string;
      };
      const second = await runCli(
        [
          "literature",
          "search",
          "--limit",
          "1",
          "--cursor",
          firstPage.next_cursor,
        ],
        { home },
      );
      const secondPage = second.value as {
        items: readonly { literature: { literature_id: string } }[];
      };
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(firstPage.items).toHaveLength(1);
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.items[0]!.literature.literature_id).not.toBe(
        firstPage.items[0]!.literature.literature_id,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("opens a reference detail by reference id", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-cli-reference-"));
    const app = await createApplication(home);
    try {
      await app.database.putLiterature(FIXTURE_LITERATURE);
      await app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: id(2),
          meta_literature_id: id(102),
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: "Referenced paper",
            identifiers: [{ namespace: "doi", value: "10.1234/reference" }],
          },
        }),
      );
      await app.observations.publish({
        observation_id: id(200),
        literature_id: FIXTURE_LITERATURE.literature_id,
        provenance: {
          provenance_id: id(201),
          source_kind: "metadata-provider",
          source_name: "fixture",
          source_record_id: null,
          observed_at: "2026-09-11T00:00:00Z",
          input_sha256: null,
          parameters_sha256: null,
        },
        version_role: "published",
        reference_count: 1,
        cited_by_count: 0,
        metadata: FIXTURE_LITERATURE.metadata,
        declared_keywords: [],
        reference_texts: ["Referenced paper"],
      });
      await app.references.publish(
        parseReference({
          reference_id: id(300),
          source_literature_id: FIXTURE_LITERATURE.literature_id,
          target_literature_id: id(2),
        }),
      );
      await app.references.supportWithMetadataReferenceText(
        id(300),
        id(200),
        0,
      );
    } finally {
      await app.close();
    }
    try {
      const result = await runCli(
        ["literature", "references", "--reference-id", id(300)],
        { home },
      );
      expect(result.code).toBe(0);
      expect(result.value).toMatchObject({
        reference: { reference_id: id(300) },
        target: { literature: { metadata: { title: "Referenced paper" } } },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("exports metadata selected by meta literature and discovery run", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-cli-export-"));
    const source = join(home, "record.bib");
    const byMeta = join(home, "by-meta.bib");
    const byRun = join(home, "by-run.json");
    await writeFile(
      source,
      "@article{one, title={Selected paper}, year={2026}, doi={10.1234/selected}}",
    );
    try {
      const imported = await runCli(
        ["import", "metadata", source, "--format", "bibtex"],
        { home },
      );
      const literatureId = (
        imported.value as { items: readonly { literature_id: string }[] }
      ).items[0]!.literature_id;
      const app = await createApplication(home);
      let metaId: string;
      try {
        const detail = await app.library.detail(literatureId);
        metaId = detail.literature.meta_literature_id;
        await app.database.putDiscovery({
          run: {
            discovery_run_id: id(400),
            kind: "topic",
            status: "COMPLETED",
            started_at: "2026-09-11T00:00:00Z",
            query: "selected",
            year_from: null,
            year_to: null,
          },
          providers: [],
          source_results: [],
          results: [{ meta_literature_id: metaId }],
          topic_causes: [
            {
              meta_literature_id: metaId,
              metadata_observation_id:
                detail.metadata_observations[0]!.observation_id,
              actual_literature_id: literatureId,
            },
          ],
          citation_causes: [],
        });
      } finally {
        await app.close();
      }
      const metaResult = await runCli(
        [
          "export",
          "metadata",
          "bibtex",
          byMeta,
          "--meta-literature-id",
          metaId!,
        ],
        { home },
      );
      const runResult = await runCli(
        [
          "export",
          "metadata",
          "csl-json",
          byRun,
          "--discovery-run-id",
          id(400),
        ],
        { home },
      );
      expect(metaResult.value).toMatchObject({ exported: 1, path: byMeta });
      expect(runResult.value).toMatchObject({ exported: 1, path: byRun });
      expect(await readFile(byMeta, "utf8")).toContain("Selected paper");
      expect(JSON.parse(await readFile(byRun, "utf8"))).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("requires exactly one of the six completion selectors", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-cli-selector-"));
    const alternatives = [
      ["--discovery-run-id", id(1)],
      ["--import-meta-literature-id", id(2)],
      ["--query", "paper"],
      ["--meta-literature-id", id(3)],
      ["--literature-id", id(4)],
    ] as const;
    try {
      const missing = await runCli(["complete", "pdf"], { home });
      expect(missing.code).toBe(2);
      for (const alternative of alternatives) {
        const result = await runCli(
          ["complete", "pdf", "--all-pending", ...alternative],
          { home },
        );
        expect(result.code).toBe(2);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("runs configuration test selectors through the TypeScript owner without network effects", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-cli-config-test-"));
    try {
      const status = await runCli(["config", "test", "parse"], { home });
      expect(status.code).toBe(0);
      expect(status.value).toMatchObject({
        owner: "parse",
        network_performed: false,
        browser_launched: false,
      });
      const browser = await runCli(["config", "test", "browser", "model"], {
        home,
      });
      expect(browser.code).toBe(0);
      expect(browser.value).toMatchObject({ owner: "browser-model" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
