import { expect, it } from "vitest";
import { parseConfiguration } from "../src/configuration/index.js";
import { renderConfigurationText } from "../src/configuration/owner.js";
import { validateCompoundName, orderedTagItems } from "../src/tags/rules.js";
import { topicDraft } from "./tag-fixture.js";
import type { Tag, TagAssignmentItem } from "@sciretriever/contracts";
const tag = (id: string, parent_id: string | null = null): Tag => ({
  ...topicDraft(id, parent_id),
  tag_id: id,
  status: "active",
  merged_into: null,
  locked: false,
  created_vocab_version: 1,
  backfilled_vocab_version: null,
  examples: [],
});
const item = (id: string, rank: number, locked = false): TagAssignmentItem => ({
  tag_id: id,
  rank,
  locked,
  reason: "Synthetic",
  origin: "auto",
  evidence: [],
});
it("rejects numbered compounds and code-only names and requires title/abstract support", () => {
  for (const name of ["compound 3a", "化合物 2", "ABC-123"])
    expect(() =>
      validateCompoundName({ ...topicDraft(name), kind: "compound" }),
    ).toThrow();
  expect(() =>
    validateCompoundName(
      { ...topicDraft("Zinc oxide"), kind: "compound" },
      "Nickel catalysis",
    ),
  ).toThrow();
  expect(() =>
    validateCompoundName(
      { ...topicDraft("Zinc oxide"), aliases: ["ZnO"], kind: "compound" },
      "ZnO photocatalysts",
    ),
  ).not.toThrow();
});
it("drops redundant ancestors, enforces contiguous order and prevents implicit movement of a locked tag", () => {
  const tags = new Map([
    ["parent", tag("parent")],
    ["child", tag("child", "parent")],
    ["other", tag("other")],
  ]);
  expect(
    orderedTagItems(
      [item("parent", 1), item("child", 2)],
      [],
      tags,
      6,
      "auto",
    ).map((i) => [i.tag_id, i.rank]),
  ).toEqual([["child", 1]]);
  expect(() =>
    orderedTagItems(
      [item("parent", 1), item("child", 2), item("other", 3)],
      [item("other", 3, true)],
      tags,
      6,
      "auto",
    ),
  ).toThrow();
});
it("roundtrips independent tag task bindings and bounded controls without changing the shared runtime backend", () => {
  const text =
    '[providers.fixture]\napi="openai-chat-completions"\nbase_url="http://127.0.0.1:1/v1"\n[models."fixture/tagger"]\n[models."fixture/curator"]\n[tags]\nmodel="fixture/tagger"\nconsolidation_model="fixture/curator"\nbackfill_model="fixture/tagger"\nmax_per_literature=4\ncandidate_k=12\nbackfill_batch=3\n';
  const config = parseConfiguration(text);
  expect(config.tags).toEqual({
    model: "fixture/tagger",
    consolidation_model: "fixture/curator",
    backfill_model: "fixture/tagger",
    max_per_literature: 4,
    candidate_k: 12,
    backfill_batch: 3,
  });
  expect(parseConfiguration(renderConfigurationText(config)).tags).toEqual(
    config.tags,
  );
  expect(() => parseConfiguration("[tags]\nmax_per_literature=0")).toThrow();
  expect(() => parseConfiguration('[tags]\nmodel="missing/model"')).toThrow();
});
