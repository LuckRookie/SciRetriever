import { expect, it } from "vitest";
import {
  ArxivRestAdapter,
  MetadataService,
  topicSearchQuery,
} from "../src/index.js";

const xmlPage = (id: string, title: string, includeSecond = false) =>
  `<?xml version="1.0"?><feed xmlns:arxiv="http://arxiv.org/schemas/atom"><entry><id>http://arxiv.org/abs/${id}v2</id><title>${title}</title><summary>Summary &amp; details</summary><published>2026-09-11T00:00:00Z</published><author><name>Ada Lovelace</name></author><arxiv:doi>10.1000/${id}</arxiv:doi><arxiv:journal_ref>Fixture Journal</arxiv:journal_ref><link title="pdf" href="https://arxiv.org/pdf/${id}v2.pdf" /></entry>${includeSecond ? `<entry><id>http://arxiv.org/abs/2401.12346</id><title>Second</title><published>2026-01-01T00:00:00Z</published></entry>` : ""}</feed>`;

it("maps arXiv Atom entries and bounded start pagination", async () => {
  const calls: string[] = [];
  const adapter = new ArxivRestAdapter({
    origin: "https://export.arxiv.test/api/query",
    pageSize: 1,
    observationId: (() => {
      let i = 0;
      return () => `00000000-0000-4000-8b00-${String(++i).padStart(12, "0")}`;
    })(),
    provenanceId: (() => {
      let i = 0;
      return () => `00000000-0000-4000-8c00-${String(++i).padStart(12, "0")}`;
    })(),
    clock: () => "2026-09-11T00:00:00Z",
    transport: {
      async request(url) {
        calls.push(url);
        return calls.length === 1
          ? xmlPage("2401.12345", "First")
          : calls.length === 2
            ? xmlPage("2401.12346", "Second")
            : "<feed></feed>";
      },
    },
  });
  const result = await new MetadataService({
    topic_search_ports: [adapter],
  }).searchTopicProvider("arxiv", topicSearchQuery("quantum"), 10);
  expect(result.outcome).toBe("EXHAUSTED");
  expect(result.observations.map((item) => item.metadata.title)).toEqual([
    "First",
    "Second",
  ]);
  expect(result.observations[0]?.version_role).toBe("preprint");
  expect(result.observations[0]?.metadata.identifiers).toContainEqual({
    namespace: "arxiv",
    value: "2401.12345",
  });
  expect(result.observations[0]?.asset_hints[0]?.url).toBe(
    "https://arxiv.org/pdf/2401.12345v2.pdf",
  );
  expect(new URL(calls[1]!).searchParams.get("start")).toBe("1");
});
