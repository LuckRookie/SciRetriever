import { randomUUID } from "node:crypto";
import {
  canonicalJsonBytes,
  parseAssetId,
  parsePageRegion,
  parseProofreadBlocksV1,
  parseProofreadDisposition,
} from "@sciretriever/contracts";
import type { SqliteRawParseStorage } from "../storage/raw-parsing.js";
import type { SqliteProofreadStorage } from "../storage/proofread.js";
import { VerifiedReaderError } from "../storage/files/reader.js";
import { buildProofreadVersion, proofreadCorrectionMethod } from "./engine.js";
import {
  manualPageIdentity,
  insertedDraft,
  type PdfPages,
  type ProofreadCorrector,
  type ManualProofreadDecision,
} from "./contract.js";
import { CLEAN_RULES_VERSION } from "./clean.js";
import { SUSPECTS_VERSION } from "./suspects.js";
import { PROOFREAD_RENDER_VERSION } from "./render.js";
export class ProofreadError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super("proofreading failed", options);
  }
}
function record(
  v: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    required.some((k) => !Object.hasOwn(v, k)) ||
    Object.keys(v).some((k) => !required.includes(k) && !optional.includes(k))
  )
    throw new ProofreadError("proofread-invalid");
  return v as Record<string, unknown>;
}
function count(v: unknown, max: number) {
  if (!Number.isSafeInteger(v) || Number(v) < 0 || Number(v) > max)
    throw new ProofreadError("proofread-invalid");
  return Number(v);
}
function reason(v: unknown, max = 65536) {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new ProofreadError("proofread-invalid");
  return v;
}
export class ProofreadService {
  private readonly stop = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  constructor(
    private readonly raw: SqliteRawParseStorage,
    private readonly storage: SqliteProofreadStorage,
    private readonly pages: PdfPages | null = null,
    private readonly corrector: ProofreadCorrector | null = null,
    private readonly profile: "pipeline" | "vlm-engine" = "vlm-engine",
  ) {}
  close(): Promise<void> {
    if (!this.closing) {
      this.stop.abort();
      this.closing = Promise.allSettled([...this.active]).then(() => undefined);
    }
    return this.closing;
  }
  private async run<T>(
    signal: AbortSignal | undefined,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const stop = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    if (stop.aborted) throw new ProofreadError("proofread-cancelled");
    const work = fn(stop);
    this.active.add(work);
    try {
      return await work;
    } catch (error) {
      if (error instanceof ProofreadError) throw error;
      if (stop.aborted)
        throw new ProofreadError("proofread-cancelled", { cause: error });
      if (error instanceof VerifiedReaderError)
        throw new ProofreadError("proofread-integrity", { cause: error });
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : error instanceof Error
            ? error.message
            : null;
      if (typeof code === "string" && /^proofread-[a-z-]{1,64}$/u.test(code))
        throw new ProofreadError(code, { cause: error });
      throw error;
    } finally {
      this.active.delete(work);
    }
  }
  status(value: unknown, signal?: AbortSignal) {
    const r = record(value, ["asset_id"]),
      asset = parseAssetId(r.asset_id);
    return this.run(signal, async (stop) => {
      const c = await this.storage.current(asset, stop);
      return {
        asset_id: asset,
        current: c
          ? {
              proofread_id: String(c.proofread_id),
              content_sha256: String(c.content_sha256),
              status: String(c.status),
              revision: Number(c.revision),
            }
          : null,
      };
    });
  }
  build(value: unknown, signal?: AbortSignal) {
    const r = record(value, ["asset_id"], ["mode"]),
      asset = parseAssetId(r.asset_id);
    if (
      r.mode !== undefined &&
      !["full", "legacy-vlm-markdown"].includes(String(r.mode))
    )
      throw new ProofreadError("proofread-invalid");
    return this.run(signal, async (stop) => {
      if (!this.pages)
        throw new ProofreadError("proofread-page-tools-unavailable");
      const statuses = await this.raw.current(asset, stop);
      const selected =
        r.mode === "legacy-vlm-markdown"
          ? statuses.find((s) => s.profile === "vlm-engine-markdown-only")
              ?.result
          : (statuses.find((s) => s.profile === this.profile)?.result ??
            statuses.find((s) => s.profile === "vlm-engine-markdown-only")
              ?.result);
      if (!selected) throw new ProofreadError("proofread-input-missing");
      const state = await this.storage.state(asset, stop),
        source = await this.raw.loadSource(selected.raw_parse_id, stop);
      const method = {
        clean: CLEAN_RULES_VERSION,
        page_classify: this.pages.method,
        suspects: SUSPECTS_VERSION,
        correction: proofreadCorrectionMethod(this.corrector),
        render: PROOFREAD_RENDER_VERSION,
        model_config_sha256: this.corrector?.model_config_sha256 ?? null,
      };
      if (state.current) {
        const old = await this.storage.byId(
          String(state.current.proofread_id),
          stop,
        );
        if (
          old?.status === "complete" &&
          old.draft_input.raw_parse_id === selected.raw_parse_id &&
          JSON.stringify(old.method) === JSON.stringify(method) &&
          JSON.stringify([...old.manual_decision_ids].sort()) ===
            JSON.stringify(state.decisions.map((d) => d.decision_id).sort())
        ) {
          await this.storage.load(old.proofread_id, stop);
          return {
            version: old,
            published: false,
            revision: Number(state.current.revision),
            usage: { calls: 0, input_tokens: 0, output_tokens: 0 },
          };
        }
      }
      const pages = await this.pages.inspect(
        asset,
        selected.source_sha256,
        stop,
      );
      const output = await buildProofreadVersion({
        raw: selected,
        reader: {
          readArtifact: async (id, kind, ref) => {
            if (id !== selected.raw_parse_id)
              throw new ProofreadError("proofread-input-mismatch");
            if (kind === "blocks") {
              if (!source.blocks)
                throw new ProofreadError("proofread-input-missing");
              return source.blocks.bytes;
            }
            if (kind === "markdown") return source.markdown.bytes;
            const image = source.resources.find((r) => r.reference === ref);
            if (!image) throw new ProofreadError("proofread-resource-missing");
            return image.content.bytes;
          },
        },
        pages,
        page_method: this.pages.method,
        corrector: this.corrector,
        decisions: state.decisions,
        signal: stop,
      });
      return {
        ...(await this.storage.publish(output, state.manual_revision, stop)),
        usage: output.usage,
      };
    });
  }
  inspect(value: unknown, signal?: AbortSignal) {
    const r = record(
        value,
        ["asset_id"],
        [
          "offset",
          "limit",
          "unresolved_only",
          "block_id",
          "page_offset",
          "page_limit",
        ],
      ),
      asset = parseAssetId(r.asset_id),
      offset = count(r.offset ?? 0, 100000),
      limit = count(r.limit ?? 50, 100),
      pageOffset = count(r.page_offset ?? 0, 10000),
      pageLimit = count(r.page_limit ?? 20, 100);
    if (
      !limit ||
      !pageLimit ||
      (r.unresolved_only !== undefined &&
        typeof r.unresolved_only !== "boolean")
    )
      throw new ProofreadError("proofread-invalid");
    return this.run(signal, async (stop) => {
      const state = await this.storage.state(asset, stop);
      if (!state.current)
        return {
          asset_id: asset,
          current: null,
          manual_revision: state.manual_revision,
          total_count: 0,
          items: [],
          next_offset: null,
        };
      const output = await this.storage.load(
          String(state.current.proofread_id),
          stop,
        ),
        v = output.version;
      const blocks = parseProofreadBlocksV1(
        JSON.parse(new TextDecoder().decode(output.blocks.bytes)),
        v.resources.map((r) => r.reference),
      ).blocks;
      const auditDrafts = [
        ...output.drafts,
        ...(await Promise.all(
          blocks
            .filter(
              (b) => !output.drafts.some((d) => d.block_id === b.block_id),
            )
            .map((b) => insertedDraft(b, v.draft_input.result_sha256, v.edits)),
        )),
      ];
      const all = auditDrafts.filter(
        (d) =>
          (r.block_id === undefined ||
            d.block_id === parseAssetId(r.block_id)) &&
          (!r.unresolved_only ||
            v.suspects.some(
              (s) =>
                s.block_ids.includes(d.block_id) &&
                (!s.disposition || s.disposition.status === "uncertain"),
            ) ||
            !v.pages[d.page]!.checked),
      );
      const available = all.slice(offset, offset + limit).map((d) => ({
        block_id: d.block_id,
        draft_sha256: d.draft_sha256,
        draft: d,
        block: blocks.find((b) => b.block_id === d.block_id) ?? null,
        suspects: v.suspects.filter((s) => s.block_ids.includes(d.block_id)),
        edits: v.edits.filter((e) =>
          e.edit.kind === "insert_after"
            ? e.edit.after_block_id === d.block_id
            : e.edit.block_id === d.block_id,
        ),
        decisions: state.decisions.filter((x) => x.block_id === d.block_id),
      }));
      const items: typeof available = [];
      const pageItems = [];
      let pageBytes = 4096;
      for (const p of v.pages.slice(pageOffset, pageOffset + pageLimit)) {
        const identity = await manualPageIdentity(
          asset,
          p.page,
          output.drafts,
          v.draft_input.result_sha256,
        );
        const item = {
          ...p,
          ...identity,
          suspects: v.suspects.filter(
            (s) => s.page === p.page && !s.block_ids.length,
          ),
          decisions: state.decisions.filter(
            (d) => d.block_id === identity.block_id,
          ),
        };
        const n = canonicalJsonBytes(item).length;
        if (pageBytes + n > 1024 * 1024) {
          if (!pageItems.length)
            throw new ProofreadError("proofread-response-budget");
          break;
        }
        pageBytes += n;
        pageItems.push(item);
      }
      let bytes = pageBytes;
      for (const item of available) {
        const n = canonicalJsonBytes(item).length;
        if (bytes + n > 2 * 1024 * 1024) {
          if (!items.length)
            throw new ProofreadError("proofread-response-budget");
          break;
        }
        bytes += n;
        items.push(item);
      }
      return {
        asset_id: asset,
        current: {
          proofread_id: v.proofread_id,
          content_sha256: v.content_sha256,
          status: v.status,
          stats: v.stats,
          revision: state.current.revision,
        },
        pages: pageItems,
        page_count: v.pages.length,
        next_page_offset:
          pageOffset + pageItems.length < v.pages.length
            ? pageOffset + pageItems.length
            : null,
        manual_revision: state.manual_revision,
        total_count: all.length,
        items,
        next_offset:
          offset + items.length < all.length ? offset + items.length : null,
      };
    });
  }
  decide(value: unknown, signal?: AbortSignal) {
    const r = record(
        value,
        [
          "asset_id",
          "proofread_id",
          "block_id",
          "draft_sha256",
          "expected_manual_revision",
          "action",
          "text",
          "reason",
          "actor",
        ],
        ["suspect_id", "disposition", "page"],
      ),
      asset = parseAssetId(r.asset_id),
      id = parseAssetId(r.proofread_id),
      blockId = parseAssetId(r.block_id),
      revision = count(r.expected_manual_revision, Number.MAX_SAFE_INTEGER),
      actor = reason(r.actor, 128),
      why = reason(r.reason);
    if (
      !["replace", "resolve-suspect", "clear-uncertainty", "no-body"].includes(
        String(r.action),
      ) ||
      (r.action === "replace"
        ? typeof r.text !== "string" || r.text.length > 4 * 1024 * 1024
        : r.text !== null)
    )
      throw new ProofreadError("proofread-invalid");
    return this.run(signal, async (stop) => {
      const output = await this.storage.load(id, stop);
      if (output.version.part_asset_id !== asset)
        throw new ProofreadError("proofread-manual-stale");
      const storedBlock = parseProofreadBlocksV1(
        JSON.parse(new TextDecoder().decode(output.blocks.bytes)),
        output.resources.map((r) => r.reference),
      ).blocks.find((b) => b.block_id === blockId);
      const d =
        output.drafts.find((d) => d.block_id === blockId) ??
        (storedBlock
          ? await insertedDraft(
              storedBlock,
              output.version.draft_input.result_sha256,
              output.version.edits,
            )
          : undefined);
      const page =
        r.action === "no-body" || (r.action === "resolve-suspect" && !d)
          ? count(r.page, output.version.pages.length - 1)
          : d?.page;
      const target =
        r.action === "no-body" || (r.action === "resolve-suspect" && !d)
          ? {
              ...(await manualPageIdentity(
                asset,
                page!,
                output.drafts,
                output.version.draft_input.result_sha256,
              )),
              page: page!,
              raw_ref: [],
            }
          : d;
      if (
        !target ||
        target.block_id !== blockId ||
        target.draft_sha256 !== r.draft_sha256
      )
        throw new ProofreadError("proofread-manual-stale");
      const suspect =
          r.suspect_id === undefined || r.suspect_id === null
            ? null
            : parseAssetId(r.suspect_id),
        disposition =
          r.disposition === undefined || r.disposition === null
            ? null
            : parseProofreadDisposition(r.disposition);
      if (
        r.action === "resolve-suspect" &&
        (!suspect ||
          !disposition ||
          !output.version.suspects.some(
            (s) =>
              s.suspect_id === suspect &&
              s.page === target.page &&
              (s.block_ids.includes(blockId) || (!s.block_ids.length && !d)),
          ))
      )
        throw new ProofreadError("proofread-invalid");
      return this.storage.decide(
        {
          decision_id: randomUUID(),
          part_asset_id: asset,
          block_id: blockId,
          draft_sha256: target.draft_sha256,
          raw_ref: target.raw_ref,
          action: r.action as ManualProofreadDecision["action"],
          text: r.text as string | null,
          reason: why,
          page: target.page,
          suspect_id: suspect,
          disposition,
        },
        { proofread_id: id, expected_manual_revision: revision, actor },
        stop,
      );
    });
  }
  page(value: unknown, signal?: AbortSignal) {
    const r = record(value, ["asset_id", "page"], ["region"]),
      id = parseAssetId(r.asset_id),
      page = count(r.page, 9999);
    return this.run(signal, async (stop) => {
      if (!this.pages)
        throw new ProofreadError("proofread-page-tools-unavailable");
      const current = await this.storage.current(id, stop);
      if (!current) throw new ProofreadError("proofread-missing");
      const v = await this.storage.byId(String(current.proofread_id), stop);
      if (!v || page >= v.pages.length)
        throw new ProofreadError("proofread-invalid");
      const image = await this.pages.image(
        id,
        v.part_sha256,
        page,
        r.region === undefined || r.region === null
          ? null
          : parsePageRegion(r.region),
        stop,
      );
      if (image.data.byteLength > 2 * 1024 * 1024)
        throw new ProofreadError("proofread-response-budget");
      return {
        asset_id: id,
        asset_sha256: v.part_sha256,
        page,
        media_type: image.media_type,
        width: image.width,
        height: image.height,
        image_base64: Buffer.from(image.data).toString("base64"),
      };
    });
  }
  revoke(value: unknown, signal?: AbortSignal) {
    const r = record(value, [
      "asset_id",
      "decision_id",
      "expected_manual_revision",
      "actor",
    ]);
    return this.run(signal, (stop) =>
      this.storage.revoke(
        {
          part_asset_id: parseAssetId(r.asset_id),
          decision_id: parseAssetId(r.decision_id),
          expected_manual_revision: count(
            r.expected_manual_revision,
            Number.MAX_SAFE_INTEGER,
          ),
          actor: reason(r.actor, 128),
        },
        stop,
      ),
    );
  }
}
