import { randomUUID } from "node:crypto";
import {
  normalizedTagName,
  type Tag,
  type TagAssignment,
  type VocabularyMutation,
  type VocabularyActor,
  type VocabularyChange,
} from "@sciretriever/contracts";
import type * as Rules from "./rules.js";
const {
  TagError,
  mergeTagItems,
  tagNames,
  validateCompoundName,
  validateTagParent,
}: typeof Rules = await import(
  new URL(
    import.meta.url.endsWith(".ts") ? "./rules.ts" : "./rules.js",
    import.meta.url,
  ).href
);

/** Synchronous transaction port; only the adapter knows SQLite. */
export interface VocabularyStore {
  version(): number;
  tag(id: string): Tag | null;
  children(id: string): readonly Tag[];
  nameOwner(name: string): string | null;
  saveTag(tag: Tag): void;
  clearNames(ids: readonly string[]): void;
  removeTag(id: string): void;
  assignmentUses(id: string): number;
  lockedAssignments(ids: readonly string[]): boolean;
  assignments(id: string): Iterable<TagAssignment>;
  assignment(id: string): TagAssignment | null;
  saveAssignment(
    value: TagAssignment,
    actor: string,
    reason: string,
  ): TagAssignment;
  rememberAssignment(
    version: number,
    before: TagAssignment,
    after: TagAssignment,
  ): void;
  savedAssignments(version: number): Iterable<{
    before: TagAssignment;
    after_sha256: string;
    after_revision: number;
  }>;
  record(change: VocabularyChange, touched: readonly string[]): void;
  change(version: number): VocabularyChange | null;
  laterChanges(version: number): readonly number[];
  markUndone(version: number, by: number): void;
}

function active(store: VocabularyStore, id: string): Tag {
  const tag = store.tag(id);
  if (!tag || tag.status !== "active") throw new TagError("tag-unavailable");
  return tag;
}
function checkNames(
  store: VocabularyStore,
  tag: Tag,
  alsoAllowed: readonly string[] = [],
): void {
  for (const name of tagNames(tag)) {
    const id = store.nameOwner(name);
    if (id !== null && id !== tag.tag_id && !alsoAllowed.includes(id))
      throw new TagError("tag-name-conflict", { tag_id: id });
  }
}
export function changeVocabulary(
  store: VocabularyStore,
  input: {
    mutation: VocabularyMutation;
    expected_version: number;
    actor: VocabularyActor;
    reason: string;
  },
): VocabularyChange {
  if (store.version() !== input.expected_version)
    throw new TagError("tag-vocabulary-stale");
  if (input.mutation.op === "undo")
    return undo(store, input.mutation, input.reason);
  const version = store.version() + 1,
    mutation = input.mutation;
  const before = new Map<string, Tag | null>(),
    updates = new Map<string, Tag>();
  const touched = new Set<string>();
  let affected = 0,
    skipped = false;
  const update = (tag: Tag) => {
    if (!before.has(tag.tag_id)) before.set(tag.tag_id, store.tag(tag.tag_id));
    updates.set(tag.tag_id, tag);
    touched.add(tag.tag_id);
    if (tag.parent_id) touched.add(tag.parent_id);
    const previous = before.get(tag.tag_id);
    if (previous?.parent_id) touched.add(previous.parent_id);
  };
  if (mutation.op === "create") {
    validateCompoundName(mutation.tag);
    const tag: Tag = {
      ...mutation.tag,
      tag_id: randomUUID(),
      status: "active",
      merged_into: null,
      locked: false,
      created_vocab_version: version,
      backfilled_vocab_version: null,
      examples: [],
    };
    checkNames(store, tag);
    validateTagParent(
      tag,
      tag.parent_id ? store.tag(tag.parent_id) : null,
      false,
    );
    update(tag);
  } else {
    const tag = active(store, mutation.tag_id);
    touched.add(tag.tag_id);
    if (
      input.actor !== "manual" &&
      (tag.locked || store.lockedAssignments([tag.tag_id]))
    )
      skipped = true;
    if (mutation.op === "merge") {
      const target = active(store, mutation.into),
        children = store.children(tag.tag_id);
      if (tag.tag_id === target.tag_id || target.parent_id === tag.tag_id)
        throw new TagError("tag-hierarchy-invalid");
      touched.add(target.tag_id);
      if (
        (target.locked && input.actor !== "manual") ||
        children.some((t) => t.locked) ||
        store.lockedAssignments([tag.tag_id, target.tag_id])
      )
        skipped = true;
      if (!skipped) {
        const aliases = [
          ...new Map(
            [...target.aliases, tag.name_zh, tag.name_en, ...tag.aliases]
              .filter(Boolean)
              .map((name) => [normalizedTagName(name), name]),
          ).values(),
        ];
        if (aliases.length > 64) throw new TagError("tag-alias-limit");
        const merged = { ...target, aliases };
        checkNames(store, merged, [tag.tag_id]);
        update({
          ...tag,
          status: "merged",
          merged_into: target.tag_id,
          parent_id: null,
        });
        update(merged);
        for (const child of children) {
          const next = { ...child, parent_id: target.tag_id };
          validateTagParent(
            next,
            target,
            store.children(child.tag_id).length > 0,
          );
          update(next);
        }
        affected = store.assignmentUses(tag.tag_id);
      }
    } else if (!skipped) {
      const next: Tag =
        mutation.op === "rename"
          ? {
              ...tag,
              name_zh: mutation.name_zh,
              name_en: mutation.name_en,
              aliases: mutation.aliases,
            }
          : mutation.op === "set-parent"
            ? { ...tag, parent_id: mutation.parent_id }
            : mutation.op === "set-category"
              ? { ...tag, category: mutation.category }
              : mutation.op === "edit-definition"
                ? {
                    ...tag,
                    definition: mutation.definition,
                    backfilled_vocab_version: null,
                  }
                : { ...tag, locked: mutation.locked };
      validateCompoundName(next);
      checkNames(store, next);
      validateTagParent(
        next,
        next.parent_id ? store.tag(next.parent_id) : null,
        store.children(next.tag_id).length > 0,
      );
      update(next);
      affected = store.assignmentUses(tag.tag_id);
    }
  }
  const change: VocabularyChange = {
    created_at: new Date().toISOString(),
    version,
    op: mutation.op,
    payload: mutation,
    inverse: [...before].map(([tag_id, before]) => ({ tag_id, before })),
    actor: input.actor,
    reason: input.reason,
    affected_literatures: affected,
    outcome: skipped ? "skipped-locked" : "applied",
    undone_by: null,
  };
  store.record(change, [...touched]);
  store.clearNames([...updates.keys()]);
  for (const tag of updates.values()) store.saveTag(tag);
  if (!skipped && mutation.op === "merge") {
    for (const previous of store.assignments(mutation.tag_id)) {
      const result = store.saveAssignment(
        {
          ...previous,
          items: mergeTagItems(previous.items, mutation.tag_id, mutation.into),
          vocab_version: version,
        },
        input.actor,
        input.reason,
      );
      store.rememberAssignment(version, previous, result);
    }
  }
  return change;
}

function undo(
  store: VocabularyStore,
  mutation: Extract<VocabularyMutation, { op: "undo" }>,
  reason: string,
): VocabularyChange {
  const original = store.change(mutation.change_version);
  if (!original || original.undone_by !== null || original.op === "undo")
    throw new TagError("tag-change-unavailable");
  const dependencies = vocabularyUndoDependencies(store, original.version);
  if (dependencies.length && !mutation.cascade)
    throw new TagError("tag-undo-dependencies", { versions: dependencies });
  const restoredRevisions = new Map<string, number>();
  let result: VocabularyChange | undefined;
  for (const target of [original.version, ...dependencies].sort(
    (a, b) => b - a,
  )) {
    const previous = store.change(target)!;
    const version = store.version() + 1;
    const changes = () => store.savedAssignments(target);
    for (const item of changes()) {
      const current = store.assignment(item.before.literature_id);
      // A later manual assignment must never be overwritten by vocabulary undo.
      if (
        !current ||
        current.assignment_sha256 !== item.after_sha256 ||
        (current.revision !== item.after_revision &&
          restoredRevisions.get(item.before.literature_id) !==
            item.after_revision)
      )
        throw new TagError("tag-undo-assignment-conflict", {
          literature_id: item.before.literature_id,
        });
    }
    for (const item of previous.inverse)
      if (item.before === null && store.assignmentUses(item.tag_id) > 0)
        throw new TagError("tag-undo-assignment-conflict", {
          tag_id: item.tag_id,
        });
    result = {
      created_at: new Date().toISOString(),
      version,
      op: "undo",
      payload: { op: "undo", change_version: target, cascade: false },
      inverse: previous.inverse.map((item) => ({
        tag_id: item.tag_id,
        before: store.tag(item.tag_id),
      })),
      actor: "manual",
      reason,
      affected_literatures: previous.affected_literatures,
      outcome: "applied",
      undone_by: null,
    };
    store.record(
      result,
      previous.inverse.map((i) => i.tag_id),
    );
    // Restore aliases only after clearing the merge target's aliases.
    store.clearNames(previous.inverse.map((item) => item.tag_id));
    for (const item of previous.inverse) {
      if (item.before) store.saveTag(item.before);
      else store.removeTag(item.tag_id);
    }
    for (const item of changes()) {
      store.saveAssignment(
        { ...item.before, vocab_version: version },
        "manual",
        reason,
      );
      restoredRevisions.set(item.before.literature_id, item.before.revision);
    }
    store.markUndone(target, version);
  }
  return result!;
}

export function vocabularyUndoDependencies(
  store: VocabularyStore,
  version: number,
): number[] {
  const original = store.change(version);
  if (!original || original.undone_by !== null || original.op === "undo")
    throw new TagError("tag-change-unavailable");
  const visited = new Set<number>();
  const pending = [original.version];
  while (pending.length) {
    const version = pending.pop()!;
    if (visited.has(version)) continue;
    visited.add(version);
    pending.push(...store.laterChanges(version));
  }
  const dependencies = [...visited]
    .filter((v) => v !== original.version)
    .sort((a, b) => a - b);
  return dependencies;
}
