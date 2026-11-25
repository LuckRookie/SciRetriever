import {
  parseRawBlocksV1,
  type RawParse,
  type WebPageData,
  type IntakePageCompletion,
} from "@sciretriever/contracts";
import { decodeWebPage } from "./web-page-adapter.js";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { LiteratureIdentityService } from "./identity.js";
import type { IntakeRecognitionService } from "./intake-recognition.js";
import { adoptRecognition } from "./recognition-adoption.js";

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
      await adoptRecognition(
        this.database,
        this.identity,
        literatureId,
        result,
        {
          source_name: "post-parse-recognition",
          observation_prefix: "post-parse",
          source_record_id: raw.raw_parse_id,
          input_sha256: raw.result_sha256,
          title,
        },
        signal,
      );
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
