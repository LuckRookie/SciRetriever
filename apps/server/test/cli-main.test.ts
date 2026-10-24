import { initializeCatalogSchema } from "../src/storage/sqlite/catalog-schema.js";
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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

const digest = async (path: string) => sha256(await readFile(path));

async function* input(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

describe("TypeScript CLI", () => {
  // Reached 2.6 s under Full (36/12) load, too close to the 5 s default.
  it("keeps backup create-if-absent and refuses unsafe target paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-cli-backup-"));
    const catalog = join(home, "catalog.sqlite");
    const backup = join(home, "catalog-copy.sqlite");
    const absent = join(home, "absent.sqlite");
    try {
      const app = await createApplication(home);
      await app.close();
      const catalogDigest = await digest(catalog);

      const relative = await runCli(
        ["storage", "backup", "--path", "catalog-copy.sqlite"],
        { home },
      );
      expect(relative.code).toBe(2);

      const selfCopy = await runCli(["storage", "backup", "--path", catalog], {
        home,
      });
      expect(selfCopy.code).not.toBe(0);
      expect(await digest(catalog)).toBe(catalogDigest);

      await writeFile(backup, "existing-backup-bytes");
      const existing = await runCli(["storage", "backup", "--path", backup], {
        home,
      });
      expect(existing.code).not.toBe(0);
      expect(await readFile(backup, "utf8")).toBe("existing-backup-bytes");
      await rm(backup, { force: true });

      const backed = await runCli(["storage", "backup", "--path", backup], {
        home,
      });
      expect(backed.code).toBe(0);
      expect(await digest(catalog)).toBe(catalogDigest);
      const backupDigest = await digest(backup);

      const missing = await runCli(
        ["storage", "restore-check", "--path", absent],
        { home },
      );
      expect(missing.code).not.toBe(0);
      expect(existsSync(absent)).toBe(false);
      expect(
        (
          await runCli(["storage", "restore-check", "--path", "missing"], {
            home,
          })
        ).code,
      ).toBe(2);
      const selfCheck = await runCli(
        ["storage", "restore-check", "--path", catalog],
        { home },
      );
      expect(selfCheck.code).not.toBe(0);
      const checked = await runCli(
        ["storage", "restore-check", "--path", backup],
        { home },
      );
      expect(checked.code).toBe(0);
      expect(await digest(backup)).toBe(backupDigest);
      expect(await digest(catalog)).toBe(catalogDigest);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("runs a persisted job through the TypeScript task service", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-cli-jobs-"));
    try {
      await initializeCatalogSchema(join(home, "catalog.sqlite"));
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

  // Reached 2.2 s under Full (36/12) load, too close to the 5 s default.
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
  }, 30_000);

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
        source_type: null,
        source_type_mapping_version: null,
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

  // Reached 2.1 s under Full (36/12) load, too close to the 5 s default.
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
  }, 30_000);

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

  it("dispatches configuration test through the read-only probe without Storage effects", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-cli-config-test-"));
    try {
      const parse = await runCli(["config", "test", "parse", "--json"], {
        home,
      });
      expect(parse.code).toBe(3);
      expect(parse.value).toMatchObject({
        owner: "parse",
        outcome: "blocked",
        reason: "parser-configuration-incomplete",
        network_performed: false,
        browser_launched: false,
        article_entitlement: "not-proven",
        persisted: false,
      });
      const browser = await runCli(
        ["config", "test", "browser", "model", "--json"],
        { home },
      );
      expect(browser.code).toBe(3);
      expect(browser.value).toMatchObject({
        owner: "browser-model",
        outcome: "skipped",
        reason: "browser-disabled",
      });
      // A probe never constructs the durable runtime or creates a catalog.
      expect(existsSync(join(home, "catalog.sqlite"))).toBe(false);
      expect(existsSync(join(home, "artifacts"))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

const reportId = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

async function seedReportHome(
  titles: readonly string[],
): Promise<{ readonly home: string; readonly literatures: readonly string[] }> {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-cli-report-"));
  const app = await createApplication(home);
  const literatures: string[] = [];
  try {
    for (const [index, title] of titles.entries()) {
      const literatureId = reportId(1_000 + index);
      literatures.push(literatureId);
      await app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: literatureId,
          meta_literature_id: reportId(2_000 + index),
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title,
            // No identifier and no asset hint: every public route is empty, so
            // the completion run stays fully offline and can only exhaust.
            identifiers: [],
          },
        }),
      );
    }
  } finally {
    await app.close();
  }
  return { home, literatures };
}

describe("TypeScript CLI database completion report", () => {
  // Reached 2.4 s under Full (36/12) load, too close to the 5 s default.
  it("reports the five mutually exclusive partitions instead of an ad-hoc item list", async () => {
    const { home, literatures } = await seedReportHome(["Report paper"]);
    const literatureId = literatures[0]!;
    try {
      const skipped = await runCli(
        ["complete", "pdf", "--literature-id", literatureId],
        { home },
      );
      expect(skipped.code).toBe(0);
      expect(skipped.value).toMatchObject({
        kind: "database-completion",
        end: { kind: "finished" },
        goal: "ASSET_READY",
        completed: [],
        failed: [],
        skipped: [
          {
            target: { kind: "literature", literature_id: literatureId },
            reason: "manual-pdf-required",
            literature_ids: [literatureId],
          },
        ],
        notStarted: [],
        interrupted: [],
      });
      expect(skipped.value).not.toHaveProperty("items");
      expect(skipped.value).not.toHaveProperty("outcome");
      const app = await createApplication(home, {});
      try {
        // Only a normally ended automatic route commits the durable fact.
        expect(await app.database.hasAutomaticPdfExhaustion(literatureId)).toBe(
          true,
        );
      } finally {
        await app.close();
      }

      // The all-pending scope keeps excluding the marked Literature: no stale
      // ASSET_READY target silently re-enters the automatic scope.
      const allPending = await runCli(["complete", "pdf", "--all-pending"], {
        home,
      });
      expect(allPending.code).toBe(0);
      expect(allPending.value).toMatchObject({
        completed: [],
        failed: [],
        skipped: [],
        notStarted: [],
        interrupted: [],
      });

      const empty = await runCli(
        ["complete", "pdf", "--query", "no-such-report-paper"],
        { home },
      );
      expect(empty.code).toBe(0);
      expect(empty.value).toMatchObject({
        kind: "database-completion",
        end: { kind: "finished" },
        completed: [],
        failed: [],
        skipped: [],
        notStarted: [],
        interrupted: [],
      });

      const parsing = await runCli(
        ["complete", "parser", "--literature-id", literatureId],
        { home },
      );
      expect(parsing.code).toBe(0);
      expect(parsing.value).toMatchObject({
        kind: "database-completion",
        end: { kind: "finished" },
        skipped: [
          {
            target: { kind: "literature", literature_id: literatureId },
            reason: "manual-pdf-required",
            literature_ids: [literatureId],
          },
        ],
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("stops launching chunks on cancellation and distinguishes active targets from notStarted", async () => {
    const { home, literatures } = await seedReportHome(
      Array.from({ length: 6 }, (_, n) => `Cancel paper ${n + 1}`),
    );
    try {
      const controller = new AbortController();
      let started = 0;
      const result = await runCli(
        ["complete", "pdf", "--query", "Cancel paper"],
        {
          home,
          signal: controller.signal,
          stderr: (text) => {
            const line = JSON.parse(text) as {
              readonly progress?: string;
              readonly state?: string;
            };
            if (
              line.progress === "database-completion" &&
              line.state === "started"
            )
              started++;
            if (
              line.progress === "database-completion" &&
              line.state === "skipped"
            )
              controller.abort();
          },
        },
      );
      expect(result.code).toBe(130);
      const report = result.value as {
        readonly completed: readonly unknown[];
        readonly skipped: readonly unknown[];
        readonly notStarted: readonly unknown[];
        readonly interrupted: readonly unknown[];
      };
      expect(report).toMatchObject({
        kind: "database-completion",
        end: { kind: "interrupted" },
      });
      expect(report.skipped).toHaveLength(2);
      expect(started).toBe(4);
      expect(report.notStarted).toHaveLength(2);
      expect(report.interrupted).toHaveLength(2);
      expect(report.completed).toHaveLength(0);
      const app = await createApplication(home, {});
      try {
        // Only the two normally exhausted active targets may commit the durable
        // fact; interrupted workers and unstarted chunks must not invent it.
        const exhausted = new Set(
          report.skipped.flatMap(
            (item) =>
              (
                item as {
                  readonly literature_ids?: readonly string[];
                }
              ).literature_ids ?? [],
          ),
        );
        for (const literatureId of literatures)
          expect(
            await app.database.hasAutomaticPdfExhaustion(literatureId),
          ).toBe(exhausted.has(literatureId));
      } finally {
        await app.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
