import type { ModelInput } from "./core-processing-fixture.js";
import { topicDraft } from "./tag-fixture.js";

/**
 * The synthetic archive model. It imports no test runner, so tools that load
 * fixtures outside Vitest (the design sample library) can use it.
 */
export function archiveModel(input: ModelInput) {
  if (input.method === "archive-metadata-dsh-v2") {
    const fragments = input.fragments as { fragment_id: string }[];
    return {
      proposals: [
        {
          field: "authors",
          value: [
            {
              kind: "person",
              display_name: "Fixture Author",
              given_name: "Fixture",
              family_name: "Author",
              orcid: null,
              affiliations: [],
            },
          ],
          fragment_ids: [fragments[0]!.fragment_id],
        },
        {
          field: "article_kind",
          value: "research-article",
          fragment_ids: [fragments[0]!.fragment_id],
        },
        {
          field: "publication_form",
          value: "journal-article",
          fragment_ids: [fragments[0]!.fragment_id],
        },
      ],
    };
  }
  const payload = input.input as {
    fragments?: { segment_id: string }[];
    topics?: { candidates: { tag_id: string }[] }[];
  };
  if (input.task === "topics")
    return {
      topics: [
        {
          name: "Spectroscopy",
          reason: "Main theme",
          segment_ids: [payload.fragments![0]!.segment_id],
        },
      ],
    };
  if (input.task === "select") {
    const tag = payload.topics![0]!.candidates[0];
    return {
      choices: [
        {
          topic_index: 0,
          tag_id: tag?.tag_id ?? null,
          create: tag ? null : topicDraft("Spectroscopy"),
          rejected_candidates: [],
        },
      ],
    };
  }
  if (input.task === "consolidate") return { operations: [] };
  throw new Error("Unexpected model call");
}
