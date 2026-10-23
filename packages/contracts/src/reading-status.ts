import {
  parseAssetId,
  parseUtcTimestamp,
  ContractValidationError,
} from "./index.js";
import { tagRecord, tagInteger } from "./tags.js";
import { parseActorPresentation, type ActorPresentation } from "./actor.js";
export interface ReadingStatus {
  readonly asset_id: string;
  readonly proofread_id: string;
  readonly blocks: {
    readonly parser: number;
    readonly agent: number;
    readonly manual: number;
  };
  readonly text_layer_pages: number;
  readonly total_pages: number;
  readonly last_manual_edit:
    | (ActorPresentation & { readonly at: string })
    | null;
}
export function parseReadingStatus(value: unknown): ReadingStatus {
  const r = tagRecord(value, [
      "asset_id",
      "proofread_id",
      "blocks",
      "text_layer_pages",
      "total_pages",
      "last_manual_edit",
    ]),
    b = tagRecord(r.blocks, ["parser", "agent", "manual"]);
  const total = tagInteger(r.total_pages, 1),
    text = tagInteger(r.text_layer_pages);
  if (text > total) throw new ContractValidationError();
  const edit =
    r.last_manual_edit === null
      ? null
      : tagRecord(r.last_manual_edit, ["actor", "actor_label", "at"]);
  return {
    asset_id: parseAssetId(r.asset_id),
    proofread_id: parseAssetId(r.proofread_id),
    blocks: {
      parser: tagInteger(b.parser),
      agent: tagInteger(b.agent),
      manual: tagInteger(b.manual),
    },
    text_layer_pages: text,
    total_pages: total,
    last_manual_edit: edit
      ? { ...parseActorPresentation(edit), at: parseUtcTimestamp(edit.at) }
      : null,
  };
}
