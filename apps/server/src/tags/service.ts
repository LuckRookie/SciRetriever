import {
  parseAssetId,
  parseLiteratureId,
  parseTagAssignmentItem,
  parseTagDraft,
  parseVocabularyMutation,
  tagInteger,
  tagRecord,
  tagText,
  type Tag,
  type TagListItem,
  type TagAssignment,
  type TagAssignmentItem,
  type VocabularyActor,
  type VocabularyChange,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { SqliteDocumentStorage } from "../document/storage.js";
import type { SqliteAnnotationStorage } from "../storage/structure-annotations.js";
import type { LiteratureMetadataService } from "../literature/metadata-service.js";
import { TagError, tagNames, validateCompoundName } from "./rules.js";
import { selectTagInput } from "./input.js";
export interface TagConfiguration {
  readonly max_per_literature: number;
  readonly candidate_k: number;
  readonly backfill_batch: number;
}
export interface TagModel {
  readonly identity: string;
  run(
    task: "topics" | "select" | "consolidate" | "backfill",
    input: unknown,
    signal?: AbortSignal,
  ): Promise<{
    value: unknown;
    usage: { calls: number; input_tokens: number; output_tokens: number };
  }>;
}
export interface TagPage {
  readonly items: readonly TagListItem[];
  readonly total: number;
  readonly next_offset: number | null;
}
function vocabularyTag({ uses, ...tag }: TagListItem): Tag {
  void uses;
  return tag;
}
export class TagService {
  constructor(
    private readonly database: SqliteWorker,
    private readonly documents: SqliteDocumentStorage,
    private readonly annotations: SqliteAnnotationStorage,
    private readonly metadata: LiteratureMetadataService,
    private readonly model: TagModel | null,
    readonly configuration: TagConfiguration = {
      max_per_literature: 6,
      candidate_k: 8,
      backfill_batch: 8,
    },
  ) {}
  state(signal?: AbortSignal) {
    return this.database.tags<{
      version: number;
      consolidated_version: number;
    }>("state", {}, signal);
  }
  list(value: Record<string, unknown> = {}, signal?: AbortSignal) {
    return this.database.tags<TagPage>("list", value, signal);
  }
  get(id: string, signal?: AbortSignal) {
    return this.database.tags<{
      tag: Tag;
      uses: number;
      uncovered_literatures: number;
    } | null>("get", { tag_id: parseAssetId(id) }, signal);
  }
  resolve(values: readonly string[], children = false, signal?: AbortSignal) {
    return this.database.tags<string[]>(
      "resolve",
      { values, children },
      signal,
    );
  }
  undoPreview(version: number, signal?: AbortSignal) {
    return this.database.tags(
      "undo-preview",
      { change_version: tagInteger(version, 1) },
      signal,
    );
  }
  changes(since = 0, limit = 100, signal?: AbortSignal) {
    return this.database.tags<VocabularyChange[]>(
      "changes",
      { since, limit },
      signal,
    );
  }
  assignment(id: string, signal?: AbortSignal) {
    return this.database.tags<TagAssignment | null>(
      "assignment",
      { literature_id: parseLiteratureId(id) },
      signal,
    );
  }
  change(
    value: unknown,
    actor: VocabularyActor = "manual",
    signal?: AbortSignal,
  ) {
    const r = tagRecord(value, ["mutation", "expected_version", "reason"]);
    return this.database.tags<VocabularyChange>(
      "change",
      {
        mutation: parseVocabularyMutation(r.mutation),
        expected_version: tagInteger(r.expected_version),
        reason: tagText(r.reason),
        actor,
      },
      signal,
    );
  }
  async assign(
    value: unknown,
    actor: "manual" | "auto" | "backfill" = "manual",
    signal?: AbortSignal,
    source?: {
      metadata_revision: number;
      document_version_id?: string;
      annotation_id?: string;
      default_revision?: number;
    },
  ) {
    const r = tagRecord(value, [
        "literature_id",
        "items",
        "expected_revision",
        "expected_version",
        "reason",
        "model",
      ]),
      id = parseLiteratureId(r.literature_id);
    if (!Array.isArray(r.items)) throw new TagError("tags-invalid");
    const items = r.items.map(parseTagAssignmentItem),
      evidence = new Map<string, Set<string>>();
    for (const item of items)
      for (const e of item.evidence) {
        const ids = evidence.get(e.document_version_id) ?? new Set<string>();
        for (const s of e.segment_ids) ids.add(s);
        evidence.set(e.document_version_id, ids);
      }
    for (const [document, ids] of evidence)
      await this.documents.withVerifiedDocument(
        document,
        async (version, _text, structure) => {
          if (
            version.schema_version !== 2 ||
            structure.schema_version !== 2 ||
            version.source_material_ref.literature_id !== id
          )
            throw new TagError("tag-evidence-invalid");
          const segments = new Set(structure.segments.map((s) => s.segment_id));
          if ([...ids].some((s) => !segments.has(s)))
            throw new TagError("tag-evidence-invalid");
        },
        signal,
      );
    return this.database.tags<TagAssignment>(
      "assign",
      {
        ...r,
        literature_id: id,
        items,
        actor,
        max: this.configuration.max_per_literature,
        ...(source ? { source } : {}),
      },
      signal,
    );
  }
  private requireModel() {
    if (!this.model) throw new TagError("tag-model-unavailable");
    return this.model;
  }
  async build(value: unknown, signal?: AbortSignal) {
    const r = tagRecord(value, [
        "literature_id",
        "document_version_id",
        "annotation_id",
      ]),
      id = parseLiteratureId(r.literature_id),
      document = parseAssetId(r.document_version_id),
      annotation = await this.annotations.byId(
        tagText(r.annotation_id),
        signal,
      );
    const metadata = await this.metadata.read(id, signal),
      before = await this.assignment(id, signal);
    if (
      !annotation ||
      annotation.document_version_id !== document ||
      annotation.part !== "main"
    )
      throw new TagError("tag-annotation-invalid");
    const version = await this.database.documentVersion(document);
    if (
      !version?.is_default ||
      version.version.schema_version !== 2 ||
      version.version.source_material_ref.literature_id !== id
    )
      throw new TagError("tag-evidence-stale");
    const primary = (await this.database.currentFacts(id))?.primary_asset;
    if (
      primary?.asset_id !== version.version.source_material_ref.asset_id ||
      primary.sha256 !== version.version.source_material_ref.asset_sha256
    )
      throw new TagError("tag-evidence-stale");
    const selectedInput = await this.documents.withVerifiedDocument(
      document,
      async (v, markdown, structure) => {
        if (v.schema_version !== 2 || structure.schema_version !== 2)
          throw new TagError("tag-proofread-required");
        const roles = new Map(
          annotation.segment_roles.map((s) => [s.segment_id, s.role]),
        );
        return selectTagInput(markdown, structure.segments, roles);
      },
      signal,
    );
    const { fragments, coverage } = selectedInput;
    if (!fragments.length) throw new TagError("tag-input-empty");
    const model = this.requireModel(),
      usage = { calls: 0, input_tokens: 0, output_tokens: 0 };
    const call = async (
      task: Parameters<TagModel["run"]>[0],
      input: unknown,
    ) => {
      const out = await model.run(task, input, signal);
      for (const key of ["calls", "input_tokens", "output_tokens"] as const)
        usage[key] += out.usage[key];
      return out.value;
    };
    const first = tagRecord(
      await call("topics", {
        title: metadata.literature.metadata.title,
        abstract: metadata.literature.metadata.abstract,
        keywords: metadata.literature.metadata.keywords,
        fragments,
        coverage,
        max: this.configuration.max_per_literature,
      }),
      ["topics"],
    );
    if (
      !Array.isArray(first.topics) ||
      !first.topics.length ||
      first.topics.length > this.configuration.max_per_literature
    )
      throw new TagError("tags-empty");
    const validSegments = new Set(fragments.map((s) => s.segment_id));
    const topics = first.topics.map((v) => {
      const t = tagRecord(v, ["name", "reason", "segment_ids"]);
      if (
        !Array.isArray(t.segment_ids) ||
        !t.segment_ids.length ||
        t.segment_ids.length > 64 ||
        t.segment_ids.some(
          (s) => typeof s !== "string" || !validSegments.has(s),
        )
      )
        throw new TagError("tag-evidence-invalid");
      return {
        name: tagText(t.name),
        reason: tagText(t.reason),
        segment_ids: t.segment_ids as string[],
      };
    });
    const candidates = await Promise.all(
      topics.map((t) =>
        this.list(
          { query: t.name, limit: this.configuration.candidate_k },
          signal,
        ),
      ),
    );
    const second = tagRecord(
      await call("select", {
        topics: topics.map((t, i) => ({
          ...t,
          topic_index: i,
          candidates: candidates[i]!.items.map(vocabularyTag),
        })),
        current: before?.items ?? [],
      }),
      ["choices"],
    );
    if (
      !Array.isArray(second.choices) ||
      second.choices.length !== topics.length
    )
      throw new TagError("tags-invalid");
    const seen = new Set<number>(),
      items: TagAssignmentItem[] = [];
    let created = 0;
    for (const choice of second.choices) {
      const c = tagRecord(choice, [
          "topic_index",
          "tag_id",
          "create",
          "rejected_candidates",
        ]),
        n = tagInteger(c.topic_index);
      if (n >= topics.length || seen.has(n)) throw new TagError("tags-invalid");
      seen.add(n);
      const topic = topics[n]!,
        offered = candidates[n]!.items;
      let tag: Tag;
      if (c.tag_id !== null) {
        if (
          c.create !== null ||
          typeof c.tag_id !== "string" ||
          !offered.some((t) => t.tag_id === c.tag_id)
        )
          throw new TagError("tags-invalid");
        tag = (await this.get(
          (await this.resolve([c.tag_id], false, signal))[0]!,
          signal,
        ))!.tag;
      } else {
        const draft = parseTagDraft(c.create);
        if (!Array.isArray(c.rejected_candidates))
          throw new TagError("tag-create-unjustified");
        const rejections = c.rejected_candidates.map((v) => {
          const x = tagRecord(v, ["tag_id", "reason"]);
          return { tag_id: tagText(x.tag_id), reason: tagText(x.reason) };
        });
        if (
          rejections.length !== offered.length ||
          new Set(rejections.map((x) => x.tag_id)).size !== offered.length ||
          offered.some((t) => !rejections.some((x) => x.tag_id === t.tag_id)) ||
          (draft.parent_id !== null &&
            !offered.some((t) => t.tag_id === draft.parent_id))
        )
          throw new TagError("tag-create-unjustified");
        validateCompoundName(
          draft,
          [
            metadata.literature.metadata.title,
            metadata.literature.metadata.abstract,
          ]
            .filter(Boolean)
            .join(" "),
        );
        let selected: Tag | undefined;
        for (let retry = 0; retry < 8 && !selected; retry++) {
          const existing = new Set<string>();
          for (const name of tagNames(draft)) {
            try {
              for (const found of await this.resolve([name], false, signal))
                existing.add(found);
            } catch (e) {
              if (!(e instanceof TagError) || e.code !== "tag-unavailable")
                throw e;
            }
          }
          if (existing.size > 1) throw new TagError("tag-name-conflict");
          if (existing.size === 1) {
            selected = (await this.get([...existing][0]!, signal))!.tag;
            break;
          }
          const state = await this.state(signal);
          try {
            const change = await this.change(
              {
                mutation: { op: "create", tag: draft },
                expected_version: state.version,
                reason: topic.reason,
              },
              "tagging",
              signal,
            );
            selected = (await this.get(change.inverse[0]!.tag_id, signal))!.tag;
            created++;
          } catch (e) {
            if (
              !(e instanceof TagError) ||
              !["tag-vocabulary-stale", "tag-name-conflict"].includes(e.code)
            )
              throw e;
          }
        }
        if (!selected) throw new TagError("tag-vocabulary-busy");
        tag = selected;
      }
      validateCompoundName(
        tag,
        [
          metadata.literature.metadata.title,
          metadata.literature.metadata.abstract,
        ]
          .filter(Boolean)
          .join(" "),
      );
      const previous = items.find((i) => i.tag_id === tag.tag_id);
      if (!previous)
        items.push({
          tag_id: tag.tag_id,
          rank: items.length + 1,
          reason: topic.reason,
          evidence: [
            { document_version_id: document, segment_ids: topic.segment_ids },
          ],
          origin: "auto",
          locked: false,
        });
    }
    let assignment: TagAssignment | undefined;
    for (let retry = 0; retry < 8 && !assignment; retry++) {
      const state = await this.state(signal);
      try {
        assignment = await this.assign(
          {
            literature_id: id,
            items,
            expected_revision: before?.revision ?? 0,
            expected_version: state.version,
            reason: "archive-tagging",
            model: model.identity,
          },
          "auto",
          signal,
          {
            metadata_revision: metadata.metadata_revision,
            document_version_id: document,
            annotation_id: annotation.annotation_id,
            default_revision: version.default_revision!,
          },
        );
      } catch (e) {
        if (!(e instanceof TagError) || e.code !== "tag-assignment-stale")
          throw e;
        if (
          (await this.assignment(id, signal))?.revision !==
          (before?.revision ?? undefined)
        )
          throw e;
      }
    }
    if (!assignment) throw new TagError("tag-vocabulary-busy");
    return {
      assignment,
      created_tags: created,
      usage,
      input_coverage: {
        document_version_id: document,
        annotation_id: annotation.annotation_id,
        ...coverage,
      },
    };
  }
  async consolidate(signal?: AbortSignal) {
    const through = (await this.state(signal)).version;
    const changes: VocabularyChange[] = [];
    const usage = { calls: 0, input_tokens: 0, output_tokens: 0 };
    let changedCount = 0;
    while ((await this.state(signal)).consolidated_version < through) {
      if (signal?.aborted) throw new TagError("tag-cancelled");
      const page = await this.consolidatePage(through, signal);
      changedCount += page.changes.length;
      changes.push(...page.changes.slice(0, Math.max(0, 50 - changes.length)));
      for (const key of ["calls", "input_tokens", "output_tokens"] as const)
        usage[key] += page.usage[key];
    }
    return {
      changes,
      changed_count: changedCount,
      changes_truncated: changedCount > changes.length,
      through_version: through,
      usage,
    };
  }
  private async consolidatePage(through: number, signal?: AbortSignal) {
    const state = await this.state(signal),
      changes = (
        await this.changes(state.consolidated_version, 200, signal)
      ).filter((c) => c.version <= through);
    if (!changes.length)
      return {
        changes: [],
        usage: { calls: 0, input_tokens: 0, output_tokens: 0 },
      };
    const model = this.requireModel();
    const ids = [
        ...new Set(changes.flatMap((c) => c.inverse.map((i) => i.tag_id))),
      ],
      tags: Tag[] = [];
    for (const id of ids) {
      const found = await this.get(id, signal);
      if (found?.tag.status === "active") {
        tags.push(found.tag);
        tags.push(
          ...(
            await this.list(
              {
                query: [found.tag.name_zh, found.tag.name_en].join(" "),
                limit: this.configuration.candidate_k,
              },
              signal,
            )
          ).items.map(vocabularyTag),
        );
      }
    }
    const unique = [...new Map(tags.map((t) => [t.tag_id, t])).values()],
      reply = unique.length
        ? await model.run("consolidate", { tags: unique }, signal)
        : {
            value: { operations: [] },
            usage: { calls: 0, input_tokens: 0, output_tokens: 0 },
          },
      value = tagRecord(reply.value, ["operations"]);
    if (!Array.isArray(value.operations) || value.operations.length > 200)
      throw new TagError("tag-output-limit");
    const results: VocabularyChange[] = [];
    for (const candidate of value.operations) {
      const item = tagRecord(candidate, ["mutation", "reason"]),
        mutation = parseVocabularyMutation(item.mutation);
      if (
        !["merge", "set-parent", "set-category", "edit-definition"].includes(
          mutation.op,
        ) ||
        !("tag_id" in mutation) ||
        !unique.some((t) => t.tag_id === mutation.tag_id)
      )
        throw new TagError("tags-invalid");
      const current = await this.state(signal);
      results.push(
        await this.change(
          {
            mutation,
            reason: tagText(item.reason),
            expected_version: current.version,
          },
          "consolidation",
          signal,
        ),
      );
    }
    for (const change of results)
      if (
        change.op === "edit-definition" &&
        change.outcome === "applied" &&
        "tag_id" in change.payload
      ) {
        const checked = await this.backfill(
          [change.payload.tag_id],
          false,
          signal,
          true,
        );
        if ("usage" in checked)
          for (const key of ["calls", "input_tokens", "output_tokens"] as const)
            reply.usage[key] += checked.usage[key];
      }
    await this.database.tags(
      "consolidated",
      { version: changes.at(-1)!.version },
      signal,
    );
    return { changes: results, usage: reply.usage };
  }
  private async backfillEvidence(id: string, signal?: AbortSignal) {
    const current = await this.metadata.read(id, signal),
      primary = (await this.database.currentFacts(id))?.primary_asset;
    if (!primary) throw new TagError("tag-evidence-invalid");
    const fixed = await this.database.documentDefault(
      id,
      primary.asset_id,
      primary.sha256,
    );
    if (!fixed) throw new TagError("tag-evidence-invalid");
    const normalize = (s: string) =>
      s.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
    const claims = [
      current.literature.metadata.title,
      current.literature.metadata.abstract,
      ...current.literature.metadata.keywords,
    ]
      .filter((s): s is string => !!s)
      .map(normalize);
    const segments = await this.documents.withVerifiedDocument(
      fixed.document_version_id,
      async (v, text, structure) => {
        if (v.schema_version !== 2 || structure.schema_version !== 2)
          throw new TagError("tag-evidence-invalid");
        return structure.segments
          .filter((s) => {
            const fragment = normalize(
              new TextDecoder("utf8", { fatal: true }).decode(
                text.subarray(s.start_utf8, s.end_utf8),
              ),
            );
            return (
              fragment.length >= 8 &&
              claims.some(
                (c) =>
                  c.length >= 8 &&
                  (fragment.includes(c) || c.includes(fragment)),
              )
            );
          })
          .slice(0, 64)
          .map((s) => s.segment_id);
      },
      signal,
    );
    if (!segments.length) throw new TagError("tag-evidence-missing");
    return [
      { document_version_id: fixed.document_version_id, segment_ids: segments },
    ];
  }
  async backfill(
    tagIds: readonly string[],
    dryRun = true,
    signal?: AbortSignal,
    recheckAssigned = false,
  ) {
    const ids = await this.resolve(tagIds, false, signal),
      state = await this.state(signal),
      batch = this.configuration.backfill_batch;
    const candidate = (after: string | null) =>
      this.database.tags<{
        total: number;
        literature_ids: string[];
        next: string | null;
      }>(
        "backfill-candidates",
        {
          tag_ids: ids,
          after,
          limit: batch,
          recheck_assigned: recheckAssigned,
        },
        signal,
      );
    let page = await candidate(null);
    if (dryRun)
      return {
        candidate_count: page.total,
        estimated_calls: Math.ceil(page.total / batch),
        batch_size: batch,
      };
    const model = this.requireModel(),
      tags = await Promise.all(
        ids.map(async (id) => (await this.get(id, signal))!.tag),
      );
    let examined = 0,
      updated = 0;
    const usage = { calls: 0, input_tokens: 0, output_tokens: 0 };
    for (;;) {
      if (signal?.aborted) throw new TagError("tag-cancelled");
      if (!page.literature_ids.length) break;
      const materials = await Promise.all(
        page.literature_ids.map(async (id) => {
          const m = await this.metadata.read(id, signal);
          return {
            literature_id: id,
            metadata_revision: m.metadata_revision,
            title: m.literature.metadata.title,
            abstract: m.literature.metadata.abstract,
            keywords: m.literature.metadata.keywords,
            assignment: await this.assignment(id, signal),
          };
        }),
      );
      const out = await model.run(
        "backfill",
        {
          tags,
          materials: materials.map(({ metadata_revision, ...material }) => {
            void metadata_revision;
            return material;
          }),
          max: this.configuration.max_per_literature,
        },
        signal,
      );
      for (const key of ["calls", "input_tokens", "output_tokens"] as const)
        usage[key] += out.usage[key];
      const body = tagRecord(out.value, ["decisions"]);
      if (
        !Array.isArray(body.decisions) ||
        body.decisions.length !== materials.length
      )
        throw new TagError("tags-invalid");
      const seen = new Set<string>();
      for (const raw of body.decisions) {
        const d = tagRecord(raw, ["literature_id", "tag_ids", "reason"]),
          id = parseLiteratureId(d.literature_id),
          m = materials.find((x) => x.literature_id === id);
        if (!m || seen.has(id) || !Array.isArray(d.tag_ids))
          throw new TagError("tags-invalid");
        seen.add(id);
        const previous = m.assignment!;
        const choices = d.tag_ids.map((x) => tagText(x));
        if (
          new Set(choices).size !== choices.length ||
          choices.some(
            (t) =>
              !ids.includes(t) && !previous.items.some((i) => i.tag_id === t),
          )
        )
          throw new TagError("tags-invalid");
        const pinned = previous.items.filter((i) => i.locked);
        const ordered = choices.slice(0, this.configuration.max_per_literature);
        if (pinned.some((i) => ordered.indexOf(i.tag_id) !== i.rank - 1))
          throw new TagError("tag-assignment-locked");
        if (recheckAssigned && !ordered.length)
          throw new TagError("tags-empty");
        if (
          ordered.length &&
          (ordered.length !== previous.items.length ||
            !ordered.every((t, n) => previous.items[n]?.tag_id === t))
        ) {
          const evidence = await this.backfillEvidence(id, signal);
          const items = ordered.map((t, n) => {
            const old = previous.items.find((i) => i.tag_id === t),
              tag = tags.find((x) => x.tag_id === t);
            if (tag)
              validateCompoundName(
                tag,
                [m.title, m.abstract].filter(Boolean).join(" "),
              );
            return old
              ? { ...old, rank: n + 1 }
              : {
                  tag_id: t,
                  rank: n + 1,
                  reason: tagText(d.reason),
                  evidence,
                  origin: "backfill" as const,
                  locked: false,
                };
          });
          const current = await this.state(signal);
          await this.assign(
            {
              literature_id: id,
              items,
              expected_revision: previous.revision,
              expected_version: current.version,
              reason: tagText(d.reason),
              model: model.identity,
            },
            "backfill",
            signal,
            { metadata_revision: m.metadata_revision },
          );
          updated++;
        }
      }
      examined += materials.length;
      await this.database.tags(
        "cover",
        {
          tag_ids: ids,
          literature_ids: page.literature_ids,
          version: state.version,
          complete: false,
        },
        signal,
      );
      if (!page.next) break;
      page = await candidate(page.next);
    }
    await this.database.tags(
      "cover",
      {
        tag_ids: ids,
        literature_ids: [],
        version: state.version,
        complete: true,
      },
      signal,
    );
    return { examined, updated, usage };
  }
}
