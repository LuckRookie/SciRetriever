import {
  ContractValidationError,
  parseLiteratureId,
  parseUtcTimestamp,
} from "./index.js";
import { tagRecord, tagInteger } from "./tags.js";

export const INTAKE_WITHDRAWAL_REASONS = [
  "pre-existing",
  "hit-by-later-batch",
  "folder-changed",
  "annotated",
  "opened",
  "processed",
  "metadata-edited",
  "identity-merged",
] as const;
export type IntakeWithdrawalReason = (typeof INTAKE_WITHDRAWAL_REASONS)[number];
export interface IntakeWithdrawalCounts {
  readonly literatures: number;
  readonly file_relations: number;
  readonly folders: number;
  readonly folder_members: number;
  readonly marks: number;
}
export interface IntakeWithdrawalPreview {
  readonly remove: IntakeWithdrawalCounts;
  readonly keep: {
    readonly literatures: number;
    readonly by_reason: Readonly<
      Partial<Record<IntakeWithdrawalReason, number>>
    >;
  };
  readonly kept_items: readonly {
    readonly literature_id: string;
    readonly title: string | null;
    readonly reasons: readonly IntakeWithdrawalReason[];
  }[];
  readonly registered: boolean;
}
export interface IntakeRestorePreview {
  readonly restore: IntakeWithdrawalCounts;
  readonly already_restored: { readonly literatures: number };
}
export type IntakeWithdrawalReport = Omit<IntakeWithdrawalPreview, "remove"> & {
  readonly at: string;
  readonly by: "web";
} & (
    | { readonly remove: IntakeWithdrawalCounts }
    | { readonly restore: IntakeWithdrawalCounts }
  );
function fail(): never {
  throw new ContractValidationError();
}
function counts(value: unknown): IntakeWithdrawalCounts {
  const r = tagRecord(value, [
    "literatures",
    "file_relations",
    "folders",
    "folder_members",
    "marks",
  ]);
  return {
    literatures: tagInteger(r.literatures),
    file_relations: tagInteger(r.file_relations),
    folders: tagInteger(r.folders),
    folder_members: tagInteger(r.folder_members),
    marks: tagInteger(r.marks),
  };
}
function common(
  r: Record<string, unknown>,
): Omit<IntakeWithdrawalPreview, "remove"> {
  if (
    typeof r.registered !== "boolean" ||
    !Array.isArray(r.kept_items) ||
    r.kept_items.length > 200
  )
    fail();
  const keep = tagRecord(r.keep, ["literatures", "by_reason"]);
  if (
    !keep.by_reason ||
    typeof keep.by_reason !== "object" ||
    Array.isArray(keep.by_reason)
  )
    fail();
  const by_reason: Partial<Record<IntakeWithdrawalReason, number>> = {};
  for (const [key, value] of Object.entries(keep.by_reason)) {
    if (!(INTAKE_WITHDRAWAL_REASONS as readonly string[]).includes(key)) fail();
    by_reason[key as IntakeWithdrawalReason] = tagInteger(value);
  }
  const kept_items = r.kept_items.map((value) => {
    const item = tagRecord(value, ["literature_id", "title", "reasons"]);
    if (
      (item.title !== null && typeof item.title !== "string") ||
      !Array.isArray(item.reasons) ||
      !item.reasons.length ||
      new Set(item.reasons).size !== item.reasons.length ||
      item.reasons.some(
        (reason) =>
          !(INTAKE_WITHDRAWAL_REASONS as readonly unknown[]).includes(reason),
      )
    )
      fail();
    return {
      literature_id: parseLiteratureId(item.literature_id),
      title: item.title as string | null,
      reasons: item.reasons as IntakeWithdrawalReason[],
    };
  });
  if (
    kept_items.some(
      (item, i) =>
        i > 0 && item.literature_id <= kept_items[i - 1]!.literature_id,
    )
  )
    fail();
  const literatures = tagInteger(keep.literatures);
  if (
    kept_items.length > literatures ||
    Object.values(by_reason).some((n) => n > literatures)
  )
    fail();
  return {
    registered: r.registered,
    keep: { literatures, by_reason },
    kept_items,
  };
}
export function parseIntakeWithdrawalPreview(
  value: unknown,
): IntakeWithdrawalPreview {
  const r = tagRecord(value, ["remove", "keep", "kept_items", "registered"]);
  return { remove: counts(r.remove), ...common(r) };
}
export function parseIntakeRestorePreview(
  value: unknown,
): IntakeRestorePreview {
  const r = tagRecord(value, ["restore", "already_restored"]);
  const already = tagRecord(r.already_restored, ["literatures"]);
  return {
    restore: counts(r.restore),
    already_restored: { literatures: tagInteger(already.literatures) },
  };
}
export function parseIntakeWithdrawalReport(
  value: unknown,
): IntakeWithdrawalReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const key = Object.hasOwn(value, "restore") ? "restore" : "remove";
  const r = tagRecord(value, [
    key,
    "keep",
    "kept_items",
    "registered",
    "at",
    "by",
  ]);
  if (r.by !== "web") fail();
  const base = {
    ...common(r),
    at: parseUtcTimestamp(r.at),
    by: "web" as const,
  };
  return key === "restore"
    ? { ...base, restore: counts(r.restore) }
    : { ...base, remove: counts(r.remove) };
}
