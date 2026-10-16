import { createHash } from "node:crypto";
import {
  AttachmentId,
  type ImageAttachmentRef,
} from "@deepseek-ai/dsh-attachment";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import {
  AgentFailure,
  type AgentImagePart,
  type AgentPart,
} from "../protocol.js";

/** Consumers supply encoded rasters; this store owns immutable per-call/session copies. */
export class SessionAttachments {
  private readonly images = new Map<
    string,
    { ref: ImageAttachmentRef; image: AgentImagePart; hash: string }
  >();
  private closed = false;

  constructor(private readonly owner: string) {}

  store(parts: readonly AgentPart[]): ContentBlock[] {
    this.assertOpen();
    return parts.map((part): ContentBlock => {
      if ("text" in part) return { type: "text", text: part.text };
      if (
        !part.data.byteLength ||
        !Number.isSafeInteger(part.width) ||
        !Number.isSafeInteger(part.height) ||
        part.width < 1 ||
        part.height < 1
      )
        throw new AgentFailure("agent-image-input");
      const hash = createHash("sha256").update(part.data).digest("hex");
      const key = createHash("sha256")
        .update(this.owner)
        .update(hash)
        .update(part.media_type)
        .update(`${part.width}:${part.height}`)
        .digest("hex");
      const ref: ImageAttachmentRef = {
        attachmentId: AttachmentId(key),
        mediaType: part.media_type,
        bytes: part.data.byteLength,
        width: part.width,
        height: part.height,
      };
      this.images.set(key, {
        ref,
        image: { ...part, data: Uint8Array.from(part.data) },
        hash,
      });
      return { type: "image", attachment: { ...ref } };
    });
  }

  read(ref: ImageAttachmentRef): AgentImagePart {
    this.assertOpen();
    const entry = this.images.get(ref.attachmentId);
    if (
      !entry ||
      entry.ref.mediaType !== ref.mediaType ||
      entry.ref.width !== ref.width ||
      entry.ref.height !== ref.height ||
      entry.ref.bytes !== ref.bytes
    )
      throw new AgentFailure("agent-image-reference");
    if (
      createHash("sha256").update(entry.image.data).digest("hex") !== entry.hash
    )
      throw new AgentFailure("agent-image-integrity");
    return { ...entry.image, data: Uint8Array.from(entry.image.data) };
  }

  /** Validate the framework's JSON snapshot before projecting a tool result. */
  content(value: unknown): ContentBlock[] {
    if (!Array.isArray(value)) throw new AgentFailure("agent-tool-output");
    return value.map((item: unknown): ContentBlock => {
      if (!item || typeof item !== "object")
        throw new AgentFailure("agent-tool-output");
      if (
        "type" in item &&
        item.type === "text" &&
        "text" in item &&
        typeof item.text === "string"
      )
        return { type: "text", text: item.text };
      if (!("type" in item) || item.type !== "image" || !("attachment" in item))
        throw new AgentFailure("agent-tool-output");
      const ref = item.attachment;
      if (
        !ref ||
        typeof ref !== "object" ||
        !("attachmentId" in ref) ||
        typeof ref.attachmentId !== "string"
      )
        throw new AgentFailure("agent-image-reference");
      const stored = this.images.get(ref.attachmentId);
      if (!stored || JSON.stringify(stored.ref) !== JSON.stringify(ref))
        throw new AgentFailure("agent-image-reference");
      this.read(stored.ref);
      return { type: "image", attachment: { ...stored.ref } };
    });
  }

  close(): void {
    this.closed = true;
    this.images.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new AgentFailure("agent-session-closed");
  }
}
