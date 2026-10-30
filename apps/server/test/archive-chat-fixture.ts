import { randomUUID } from "node:crypto";
import type { ArchiveSectionRole } from "@sciretriever/contracts";

/** Fake decisions over the real DSH tool/validation path; no business service is mocked. */
export function archiveChatReply(wire: {
  messages: readonly { role: string; content: unknown }[];
  tools?: readonly { function: { name: string } }[];
}) {
  const first = wire.messages.find((m) => m.role === "user")!,
    content =
      typeof first.content === "string"
        ? first.content
        : (first.content as { text?: string }[])
            .map((p) => p.text ?? "")
            .join(""),
    initial = JSON.parse(content) as Record<string, unknown>;
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
  // ADR 0047: one proofreading request per page; this fixture finds nothing to change.
  if (wire.tools?.some((t) => t.function.name === "submit_corrections"))
    return invoke("submit_corrections", { corrections: [], uncertain: [] });
  // ADR 0048: arrangement is one submit_arrangement request and one submit_breaks request.
  if (wire.tools?.some((t) => t.function.name === "submit_breaks")) {
    const { candidates = [] } = initial as {
      candidates?: { candidate: string }[];
    };
    return invoke("submit_breaks", {
      decisions: candidates.map((c) => ({
        candidate: c.candidate,
        decision: "keep",
        reason: "synthetic",
      })),
    });
  }
  const { blocks = [] } = initial as {
    blocks?: { id: string; type: string; text: string }[];
  };
  let role: ArchiveSectionRole = "additional";
  const sections: {
      first: string;
      last: string;
      role: ArchiveSectionRole;
      heading: null;
    }[] = [],
    headings: { block: string; kind: "section-heading"; level: null }[] = [],
    drops: { block: string; reason: string }[] = [];
  blocks.forEach((b, i) => {
    const text = b.text;
    if (/abstract/iu.test(text) && /^\s*#|^abstract/iu.test(text))
      role = "abstract";
    else if (/introduction/iu.test(text) && /^\s*#|^introduction/iu.test(text))
      role = "introduction";
    else if (/conclusion/iu.test(text) && /^\s*#|^conclusion/iu.test(text))
      role = "conclusion";
    else if (/references/iu.test(text) && /^\s*#|^references/iu.test(text))
      role = "references";
    else if (b.type === "title" && i === 0) role = "title";
    else if (role === "title") role = "additional";
    if (/^(?:DROP_HEADER|BIBLIOGRAPHY)/u.test(text))
      drops.push({
        block: b.id,
        reason: text.startsWith("BIBLIOGRAPHY") ? "bibliography" : "header",
      });
    else if (b.type === "title")
      headings.push({ block: b.id, kind: "section-heading", level: null });
    const block = b.id.split("#")[0]!,
      last = sections.at(-1);
    if (last?.last === block) return;
    if (last?.role === role) last.last = block;
    else sections.push({ first: block, last: block, role, heading: null });
  });
  return invoke("submit_arrangement", {
    sections,
    headings,
    drops,
    captions: [],
    splits: [],
  });
}
