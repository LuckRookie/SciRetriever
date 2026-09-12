import { expect, it } from "vitest";
import {
  DataCiteRestAdapter,
  MetadataService,
  topicSearchQuery,
} from "../src/index.js";

const data = (id: string, title: string) => ({
  id,
  type: "dois",
  attributes: {
    doi: id,
    titles: [{ title }],
    creators: [
      {
        givenName: "Ada",
        familyName: "Lovelace",
        name: "Lovelace, Ada",
        nameType: "Personal",
      },
    ],
    publisher: "DataCite Publisher",
    publicationYear: 2026,
    created: "2026-09-11T00:00:00Z",
    container: {
      title: "DataCite Journal",
      volume: "1",
      issue: "2",
      firstPage: "1",
      lastPage: "9",
    },
    descriptions: [
      { description: "Abstract text", descriptionType: "Abstract" },
    ],
    subjects: [{ subject: "quantum" }],
    types: { resourceTypeGeneral: "Text" },
    url: `https://doi.org/${id}`,
  },
});

it("maps DataCite JSON:API pages and DOI lookup", async () => {
  const calls: string[] = [];
  const adapter = new DataCiteRestAdapter({
    origin: "https://api.datacite.test",
    pageSize: 1,
    observationId: (() => {
      let i = 0;
      return () => `00000000-0000-4000-8500-${String(++i).padStart(12, "0")}`;
    })(),
    provenanceId: (() => {
      let i = 0;
      return () => `00000000-0000-4000-8600-${String(++i).padStart(12, "0")}`;
    })(),
    clock: () => "2026-09-11T00:00:00Z",
    transport: {
      async request(url) {
        calls.push(url);
        if (
          new URL(url).pathname.startsWith("/dois/") ||
          new URL(url).searchParams.get("query")?.startsWith("10.")
        )
          return { data: data("10.1000/lookup", "Lookup"), links: {} };
        return calls.length === 1
          ? {
              data: [data("10.1000/one", "First")],
              links: {
                next: "https://api.datacite.test/dois?page%5Bnumber%5D=2",
              },
            }
          : { data: [data("10.1000/two", "Second")], links: {} };
      },
    },
  });
  const search = await new MetadataService({
    topic_search_ports: [adapter],
  }).searchTopicProvider("datacite", topicSearchQuery("quantum"), 10);
  expect(search.outcome).toBe("EXHAUSTED");
  expect(search.observations.map((item) => item.metadata.title)).toEqual([
    "First",
    "Second",
  ]);
  expect(search.observations[0]?.metadata.abstract).toBe("Abstract text");
  expect(search.observations[0]?.metadata.pages).toBe("1-9");
  const lookup = await new MetadataService({ lookup_ports: [adapter] }).lookup({
    provider_name: "datacite",
    key: { record_id: "10.1000/lookup", identifiers: [] },
    scan_limit: 1,
  });
  expect(lookup.observations[0]?.metadata.title).toBe("Lookup");
});
