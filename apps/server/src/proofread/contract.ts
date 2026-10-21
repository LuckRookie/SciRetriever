import { createHash } from "node:crypto";
import {
  canonicalJsonBytes,
  sha256,
  type ProofreadBlock,
  type ProofreadEdit,
  type ProofreadEditRecord,
  type ProofreadDisposition,
  type ProofreadSuspect,
  type Sha256,
} from "@sciretriever/contracts";
import type { PdfPageInspection } from "../browser/pdf-region.js";
import type { AgentImagePart } from "../agents/protocol.js";
export type DraftCandidate = Omit<
  ProofreadBlock,
  "block_id" | "basis" | "uncertainty" | "edit_refs"
> & {
  readonly known_defect: boolean;
  readonly page_text: readonly {
    readonly page: number;
    readonly text: string;
  }[];
};
export interface DraftBlock extends DraftCandidate {
  readonly block_id: string;
  readonly draft_sha256: Sha256;
}
export interface RemovedText {
  readonly page: number;
  readonly type: string;
  readonly text: string;
  readonly raw_ref: readonly [number, number];
}
export interface ProofreadCache {
  read(
    key: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; bytes: Uint8Array; media_type: string } | null>;
  save(
    key: string,
    bytes: Uint8Array,
    mediaType: string,
    signal?: AbortSignal,
  ): Promise<string>;
}
export interface PdfPages {
  readonly method: string;
  inspect(
    assetId: string,
    assetHash: string,
    signal?: AbortSignal,
  ): Promise<readonly PdfPageInspection[]>;
  image(
    assetId: string,
    assetHash: string,
    page: number,
    region: ProofreadBlock["region"],
    signal?: AbortSignal,
  ): Promise<AgentImagePart>;
}
export interface CorrectionSubmission {
  readonly edits: readonly ProofreadEdit[];
  readonly dispositions: readonly {
    readonly suspect_id: string;
    readonly disposition: ProofreadDisposition;
  }[];
  readonly no_body_reason: string | null;
}
/** Table content is HTML, including when supplied through a replace edit. */
export function requireTableMarkup(value: string | null): void {
  if (
    value === null ||
    !/^\s*<table\b[^>]*>[\s\S]*<\/table>\s*$/iu.test(value) ||
    !/<tr\b[^>]*>/iu.test(value) ||
    !/<t[dh]\b[^>]*>/iu.test(value)
  )
    throw Object.assign(new Error("proofread-table-format"), {
      code: "proofread-table-format",
    });
}
export interface CorrectionContext {
  readonly locked_block_ids?: readonly string[];
  readonly asset_id: string;
  readonly asset_sha256: string;
  readonly page: PdfPageInspection;
  readonly pages: readonly PdfPageInspection[];
  readonly drafts: readonly DraftBlock[];
  readonly suspects: readonly ProofreadSuspect[];
  readonly resources: readonly string[];
}
export interface CorrectionResult {
  readonly submission: CorrectionSubmission | null;
  readonly reason: string | null;
  readonly calls: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
}
export interface ProofreadCorrector {
  readonly method: string;
  readonly model_config_sha256: Sha256;
  readonly max_calls: number;
  correct(
    input: CorrectionContext,
    remainingCalls: number,
    signal?: AbortSignal,
  ): Promise<CorrectionResult>;
}
export interface ManualProofreadDecision {
  readonly decision_id: string;
  readonly part_asset_id: string;
  readonly block_id: string;
  readonly draft_sha256: Sha256;
  readonly raw_ref: ProofreadBlock["raw_ref"];
  readonly action:
    | "replace"
    | "resolve-suspect"
    | "clear-uncertainty"
    | "no-body";
  readonly text: string | null;
  readonly reason: string;
  readonly page: number;
  readonly suspect_id: string | null;
  readonly disposition: ProofreadDisposition | null;
}
export function proofreadId(value: unknown): string {
  const h = createHash("sha256")
    .update(canonicalJsonBytes(value))
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export async function manualPageIdentity(
  asset: string,
  page: number,
  drafts: readonly DraftBlock[],
  rawResultHash: string,
) {
  return {
    block_id: proofreadId(["manual-page-v2", asset, page]),
    draft_sha256: await sha256(
      canonicalJsonBytes({
        page,
        raw_result_sha256: rawResultHash,
        drafts: drafts
          .filter((d) => d.page === page)
          .map((d) => ({ block_id: d.block_id, draft_sha256: d.draft_sha256 })),
      }),
    ),
  };
}

/** A human lock on inserted content binds to the immutable agent edit history. */
export async function insertedDraft(
  block: ProofreadBlock,
  rawResultHash: string,
  edits: readonly ProofreadEditRecord[],
): Promise<DraftBlock> {
  return {
    ...block,
    known_defect: false,
    page_text: [{ page: block.page, text: block.html ?? block.text }],
    draft_sha256: await sha256(
      canonicalJsonBytes({
        raw_result_sha256: rawResultHash,
        block_id: block.block_id,
        edits: edits.filter((e) => block.edit_refs.includes(e.edit_id)),
      }),
    ),
  };
}
