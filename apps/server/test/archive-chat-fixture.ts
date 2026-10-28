import { randomUUID } from "node:crypto";
import type { ArchiveSectionRole } from "@sciretriever/contracts";

/** Fake decisions over the real DSH tool/validation path; no business service is mocked. */
export function archiveChatReply(wire: {
  messages: readonly {
    role: string;
    content: unknown;
    tool_call_id?: string;
    tool_calls?: readonly {
      id: string;
      function: { name: string; arguments: string };
    }[];
  }[];
  tools?: readonly { function: { name: string } }[];
}) {
  const calls = wire.messages.flatMap((m) => m.tool_calls ?? []),
    names = new Map(calls.map((c) => [c.id, c.function.name]));
  const messages = wire.messages
    .filter((m) => m.role === "tool")
    .map((m) => {
      const e = JSON.parse(String(m.content)) as {
        content?: string[];
        status?: string;
      };
      let value: Record<string, unknown> = {};
      if (e.content?.[0]) {
        try {
          value = JSON.parse(e.content.join("")) as Record<string, unknown>;
        } catch {
          /* An image reply has no JSON evidence. */
        }
      }
      return { name: names.get(m.tool_call_id!), value };
    });
  const first = wire.messages.find((m) => m.role === "user")!,
    content =
      typeof first.content === "string"
        ? first.content
        : (first.content as { text?: string }[])
            .map((p) => p.text ?? "")
            .join(""),
    initial = JSON.parse(content) as {
      page_index?: number;
      block_count?: number;
    };
  const invoke = (name: string, args: unknown) => ({
    model: "model",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: randomUUID(),
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  });
  const history = (name: string) => messages.filter((m) => m.name === name),
    last = (name: string) => history(name).at(-1)?.value;
  const page = initial.page_index;
  const reads = history("read_blocks"),
    next = reads.length ? last("read_blocks")?.next : { index: 0, offset: 0 };
  if (next)
    return invoke("read_blocks", {
      ...(page === undefined ? {} : { page_index: page }),
      ...(next as object),
      limit: 20,
    });
  if (page !== undefined) {
    if (!history("view_page").length)
      return invoke("view_page", { page_index: page, region: null });
    const reference = last("read_reference");
    if (!reference)
      return invoke("read_reference", {
        page_index: page,
        text_offset: 0,
        suspect_offset: 0,
      });
    const suspects = history("read_reference").flatMap(
      (m) => (m.value.suspects ?? []) as { suspect_id: string }[],
    );
    const nextSuspect = reference.next_suspect_offset;
    if (typeof nextSuspect === "number")
      return invoke("read_reference", {
        page_index: page,
        text_offset: 0,
        suspect_offset: nextSuspect,
      });
    const disposed = new Set(
      calls
        .filter((c) => c.function.name === "put_dispositions")
        .flatMap((c) =>
          (
            JSON.parse(c.function.arguments) as {
              dispositions: { suspect_id: string }[];
            }
          ).dispositions.map((d) => d.suspect_id),
        ),
    );
    const pending = suspects.filter((s) => !disposed.has(s.suspect_id));
    if (pending.length)
      return invoke("put_dispositions", {
        dispositions: pending.slice(0, 20).map((s) => ({
          suspect_id: s.suspect_id,
          status: "draft-correct",
          reason: "image",
        })),
      });
    return invoke("submit_page", { no_change: true });
  }
  const rows = new Map<string, string>();
  const infos = new Map<
    string,
    {
      type: string;
      leaves: Map<string, { leaf_id: string; start: number; end: number }>;
    }
  >();
  for (const m of reads)
    for (const item of (m.value.items ?? []) as {
      id: string;
      text: string;
      type: string;
      leaves: { leaf_id: string; start: number; end: number }[];
    }[]) {
      rows.set(item.id, (rows.get(item.id) ?? "") + item.text);
      const info = infos.get(item.id) ?? { type: item.type, leaves: new Map() };
      for (const leaf of item.leaves) info.leaves.set(leaf.leaf_id, leaf);
      infos.set(item.id, info);
    }
  const assigned = new Set(
    calls
      .filter((c) => c.function.name === "put_operations")
      .flatMap((c) =>
        (
          JSON.parse(c.function.arguments) as {
            operations: { leaf_id: string }[];
          }
        ).operations.map((o) => o.leaf_id),
      ),
  );
  let role: ArchiveSectionRole = "additional";
  const operations = [];
  for (const [root, text] of rows) {
    const info = infos.get(root)!;
    if (/abstract/iu.test(text) && /^\s*#|^abstract/iu.test(text))
      role = "abstract";
    else if (/introduction/iu.test(text) && /^\s*#|^introduction/iu.test(text))
      role = "introduction";
    else if (/conclusion/iu.test(text) && /^\s*#|^conclusion/iu.test(text))
      role = "conclusion";
    else if (/references/iu.test(text) && /^\s*#|^references/iu.test(text))
      role = "references";
    else if (info.type === "title" && root === rows.keys().next().value)
      role = "title";
    else if (role === "title") role = "additional";
    for (const leaf of info.leaves.values()) {
      const id = leaf.leaf_id,
        leafText = [...text].slice(leaf.start, leaf.end).join("");
      if (assigned.has(id)) continue;
      if (/^(?:DROP_HEADER|BIBLIOGRAPHY)/u.test(leafText)) {
        operations.push({
          kind: "drop",
          leaf_id: id,
          reason: leafText.startsWith("BIBLIOGRAPHY")
            ? "bibliography"
            : "header",
        });
        continue;
      }
      operations.push({
        kind: "assign",
        leaf_id: id,
        target:
          role === "additional"
            ? { role, original_heading_leaf_id: null }
            : { role },
        presentation: {
          kind: info.type === "title" ? "section-heading" : "content",
        },
      });
    }
  }
  if (operations.length)
    return invoke("put_operations", { operations: operations.slice(0, 20) });
  const review = last("review_breaks");
  if (!review) return invoke("review_breaks", { offset: 0, limit: 20 });
  if (typeof review.next_offset === "number")
    return invoke("review_breaks", { offset: review.next_offset, limit: 20 });
  const candidates = history("review_breaks").flatMap(
      (m) => (m.value.candidates ?? []) as { candidate_id: string }[],
    ),
    decided = new Set(
      calls
        .filter((c) => c.function.name === "decide_breaks")
        .flatMap((c) =>
          (
            JSON.parse(c.function.arguments) as {
              decisions: { candidate_id: string }[];
            }
          ).decisions.map((d) => d.candidate_id),
        ),
    ),
    undecided = candidates.filter((c) => !decided.has(c.candidate_id));
  if (undecided.length)
    return invoke("decide_breaks", {
      reviewed_candidates_sha256: review.reviewed_candidates_sha256,
      decisions: undecided.slice(0, 20).map((c) => ({
        candidate_id: c.candidate_id,
        decision: "keep",
        reason: "synthetic",
      })),
    });
  return invoke("submit_operations", {
    reviewed_candidates_sha256: review.reviewed_candidates_sha256,
  });
}
