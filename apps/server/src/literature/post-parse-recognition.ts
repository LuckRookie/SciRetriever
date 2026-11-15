import { createHash } from "node:crypto";
import {
  EMPTY_METADATA,
  parseMetadataObservation,
  parseRawBlocksV1,
  type RawParse,
  type WebPageData,
  type IntakePageCompletion,
} from "@sciretriever/contracts";
import { decodeWebPage } from "./web-page-adapter.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { LiteratureIdentityService } from "./identity.js";
import { LiteratureMetadataService } from "./metadata-service.js";
import { adjudicateMetadataFields } from "./metadata-fields.js";
import type { IntakeRecognitionService } from "./intake-recognition.js";

/** Runs after RawParse commits. Failure must never turn a successful parse into a failed parse. */
export class PostParseRecognitionService {
  constructor(
    private readonly database: SqliteWorker,
    private readonly identity: LiteratureIdentityService,
    private readonly recognition: IntakeRecognitionService,
  ) {}
  async afterParse(
    raw: RawParse,
    markdown: Uint8Array,
    signal?: AbortSignal,
    blocks?: Uint8Array,
  ) {
    const owners = await this.database.run<{ ok: boolean; value: string[] }>({
      kind: "import_read",
      action: {
        op: "items-read",
        query: { kind: "raw-owners", asset_id: raw.source_asset_id },
      },
    });
    if (!owners.ok || !owners.value.length) return;
    const page = blocks
      ? parseRawBlocksV1(
          JSON.parse(new TextDecoder().decode(blocks)),
          raw.resources.map((r) => r.reference),
        ).blocks.filter((b) => b.page === 0 && b.type !== "discarded")
      : [];
    const text = page.length
      ? page
          .map((b) => b.text)
          .join(" ")
          .slice(0, 20000)
      : new TextDecoder().decode(markdown.subarray(0, 80000));
    const title =
      page.find((b) => b.type === "title")?.text.trim() ??
      /^#{1,2}\s+(.+)$/mu.exec(text)?.[1]?.trim() ??
      text
        .split(/\r?\n/u)
        .find((line) => line.trim())
        ?.trim();
    if (!title) return;
    const clues = {
      identifiers: [],
      titles: [title],
      text: text.slice(0, 20000),
      corroboration: text.slice(0, 20000),
      fallback: title,
    };
    const result = await this.recognition.recognize(
      clues,
      signal ?? new AbortController().signal,
      true,
    );
    for (const literatureId of owners.value) {
      signal?.throwIfAborted();
      if (result.observation) {
        const accepted = await this.identity.observe(result.observation, {
          target_literature_id: literatureId,
        });
        if (accepted.disposition !== "accepted") continue;
      }
      const service = new LiteratureMetadataService(this.database),
        current = await service.read(literatureId, signal);
      const digest = createHash("sha256")
        .update(
          JSON.stringify([
            literatureId,
            raw.raw_parse_id,
            result.metadata.title,
            result.metadata.identifiers,
          ]),
        )
        .digest("hex");
      const observation = parseMetadataObservation({
        observation_id: `post-parse-${digest}`,
        metadata: {
          ...EMPTY_METADATA,
          title: result.metadata.title ?? title,
          identifiers: result.metadata.identifiers,
        },
        provenance: {
          provenance_id: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`,
          source_kind: "user",
          source_name: "post-parse-recognition",
          source_record_id: raw.raw_parse_id,
          observed_at:
            (await this.database.getObservation(`post-parse-${digest}`))
              ?.provenance.observed_at ?? new Date().toISOString(),
          input_sha256: raw.result_sha256,
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
      const resolved = adjudicateMetadataFields({
        current: current.literature.metadata,
        states: current.field_states,
        candidates: [
          {
            field: "title",
            value: observation.metadata.title,
            evidence: {
              source: "manual",
              observation_id: observation.observation_id,
              provenance: observation.provenance,
            },
          },
        ],
      });
      await service.publish(current, resolved, observation, signal);
      if (result.recognition.state === "recognized")
        await this.database.run({
          kind: "import_write",
          action: {
            op: "items-write",
            action: {
              kind: "needs",
              literature_id: literatureId,
              needed: false,
              batch_id: null,
              now: new Date().toISOString(),
            },
          },
        });
    }
  }
  async page(
    literatureId: string,
    page: WebPageData,
    signal: AbortSignal,
  ): Promise<IntakePageCompletion> {
    const metadata = decodeWebPage(page).metadata;
    const result = await this.recognition.recognize(
      {
        identifiers: [],
        titles: metadata.title ? [metadata.title] : [],
        text: metadata.title ?? "",
        corroboration: [
          ...metadata.authors.map((a) => a.display_name),
          metadata.publication_year,
        ].join(" "),
        fallback: metadata.title ?? page.title ?? "document",
      },
      signal,
      true,
    );
    if (result.observation) {
      const accepted = await this.identity.observe(result.observation, {
        target_literature_id: literatureId,
      });
      if (accepted.disposition !== "accepted")
        return {
          status: "failed",
          job_id: null,
          code: "intake-identity-conflict",
        };
    }
    await this.database.run({
      kind: "import_write",
      action: {
        op: "items-write",
        action: {
          kind: "needs",
          literature_id: literatureId,
          needed: result.recognition.state !== "recognized",
          batch_id: null,
          now: new Date().toISOString(),
        },
      },
    });
    return {
      status: result.observation ? "completed" : "partial",
      job_id: null,
      code: result.observation ? null : "intake-needs-metadata",
    };
  }
}
