import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  parseLiterature,
  parseMetadataObservation,
  parseLibraryCounts,
  parseLibraryExactCount,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";
import { startQueryOnlyHttp } from "../src/workbench/http.js";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/cli/main.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
it(
  "uses earliest observed intake, stable null/tie cursors and identical filtered counts across transports",
  { timeout: 0 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-library-counts-"));
    const app = await createApplication(home);
    const mcp = createMcpServer({ home });
    const client = new Client({ name: "counts-test", version: "1" });
    let web: Awaited<ReturnType<typeof startQueryOnlyHttp>> | undefined;
    let q: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      for (let n = 1; n <= 4; n++)
        await app.database.putLiterature(
          parseLiterature({
            ...FIXTURE_LITERATURE,
            literature_id: id(n),
            meta_literature_id: id(n + 100),
            metadata: {
              ...FIXTURE_LITERATURE.metadata,
              title: n < 4 ? "Selected paper" : "Other paper",
              identifiers: [],
              publication_year: 2020 + n,
            },
          }),
        );
      for (const [n, stamp, serial] of [
        [1, "2026-10-20T00:00:00Z", 1],
        [2, "2026-10-21T00:00:00Z", 2],
        [3, "2026-10-21T00:00:00Z", 3],
        [1, "2026-10-22T00:00:00Z", 4],
      ] as const) {
        await app.observations.publish({
          ...parseMetadataObservation({
            observation_id: id(200 + serial),
            provenance: {
              provenance_id: id(300 + serial),
              source_kind: "metadata-provider",
              source_name: "synthetic",
              source_record_id: `record-${serial}`,
              observed_at: stamp,
              input_sha256: "a".repeat(64),
              parameters_sha256: null,
            },
            metadata: FIXTURE_LITERATURE.metadata,
            source_type: null,
            source_type_mapping_version: null,
            version_role: "published",
            version_links: [],
            asset_hints: [],
            reference_count: null,
            cited_by_count: null,
            declared_keywords: [],
            reference_texts: [],
          }),
          literature_id: id(n),
        });
      }
      await app.database.setAutomaticPdfExhaustion(id(1));
      let cursor: string | null = null;
      const ordered: string[] = [];
      do {
        const page = await app.library.search({ query: {}, limit: 1, cursor });
        ordered.push(...page.items.map((i) => i.literature.literature_id));
        cursor = page.next_cursor;
      } while (cursor);
      expect(ordered).toEqual([id(2), id(3), id(1), id(4)]);
      expect((await app.library.detail(id(1))).intake_at).toBe(
        "2026-10-20T00:00:00.000Z",
      );
      expect((await app.library.detail(id(4))).intake_at).toBeNull();
      const request = {
        query: {
          title: "Selected",
          statuses: ["READY"],
          needs_manual_pdf: true,
        },
      };
      const expected = await app.library.counts(request.query);
      expect(parseLibraryCounts(expected)).toEqual({
        total: 3,
        recently_opened: 0,
        unavailable_pdf: 1,
        with_primary_pdf: 0,
        full_text: { total: 3, obtained: 0, missing: 3, exhausted: 1 },
        statuses: {
          UNREVIEWED: 3,
          ASSET_READY: 0,
          ARCHIVING: 0,
          ARCHIVE_FAILED: 0,
          READY: 0,
          EXCLUDED: 0,
        },
      });
      expect(
        (await app.library.search({ query: request.query })).total_count,
      ).toBe(0);
      expect((await app.library.counts({ text: "Other" })).total).toBe(1);
      expect((await app.library.counts({ text: "---" })).total).toBe(0);
      q = await createQueryApplication(home);
      web = await startQueryOnlyHttp({ application: q });
      const response = await fetch(
        web.origin + "/api/v1/query/library-counts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ protocol_version: 1, request }),
        },
      );
      expect(response.status).toBe(200);
      expect(((await response.json()) as { result: unknown }).result).toEqual(
        expected,
      );
      const errors: string[] = [];
      const cli = await runCli(
        ["literature", "counts", "--request", "-", "--json"],
        {
          home,
          stdin: (async function* () {
            yield Buffer.from(JSON.stringify(request));
          })(),
          stdout: () => {},
          stderr: (s) => errors.push(s),
        },
      );
      expect(cli.code, errors.join("\n")).toBe(0);
      expect((cli.value as { result: unknown }).result).toEqual(expected);
      const [a, b] = InMemoryTransport.createLinkedPair();
      await mcp.connect(a);
      await client.connect(b);
      const result = await client.callTool({
        name: "library_counts",
        arguments: request,
      });
      expect(result.isError).not.toBe(true);
      expect((result.structuredContent as { result: unknown }).result).toEqual(
        expected,
      );
      const exact = { kind: "counts", ...request };
      const http = await fetch(
        web.origin + "/api/v1/query/library-exact-count",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ protocol_version: 1, request: exact }),
        },
      );
      expect(http.status).toBe(200);
      const explicit = await runCli(
        ["literature", "exact-count", "--request", "-", "--json"],
        {
          home,
          stdin: (async function* () {
            yield Buffer.from(JSON.stringify(exact));
          })(),
          stdout: () => {},
          stderr: (s) => errors.push(s),
        },
      );
      expect(explicit.code, errors.join("\n")).toBe(0);
      const resultExact = await client.callTool({
        name: "library_exact_count",
        arguments: exact,
      });
      expect(resultExact.isError).not.toBe(true);
      for (const transport of [
        await http.json(),
        explicit.value,
        resultExact.structuredContent,
      ]) {
        expect(
          parseLibraryExactCount((transport as { result: unknown }).result),
        ).toMatchObject({
          kind: "counts",
          snapshot_at: expect.any(String),
          counts: expected,
        });
      }
    } finally {
      await client.close();
      await mcp.close();
      await web?.close();
      await q?.close();
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
