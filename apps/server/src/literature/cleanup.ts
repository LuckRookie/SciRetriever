import {
  contentCanonicalJsonBytes,
  parseAnalysisInputIdentity,
  parseReferenceDetail,
  type AnalysisInputIdentity,
  type ArtifactRef,
  type ReferenceSupport,
} from "@sciretriever/contracts";
import {
  verifyLiteratureDetailSnapshot,
  type LiteratureArtifactReader,
  type LiteratureDetailSnapshot,
} from "./query.js";
import { ftsIndexText } from "./unicode-casefold.js";
export interface ContentCleanupSnapshot {
  readonly token: string;
  readonly snapshot: LiteratureDetailSnapshot;
  readonly references: readonly unknown[];
  readonly reference_count: number;
  readonly fts: readonly Record<string, unknown>[];
  readonly artifacts: readonly RetiredArtifact[];
}
export interface ContentCleanupCommand {
  readonly input: AnalysisInputIdentity;
  readonly token: string;
  readonly removed_supports: readonly ReferenceSupport[];
  readonly deleted_reference_ids: readonly string[];
  readonly candidate_cleanup?: {
    readonly transfer_ids: readonly string[];
    readonly receipt_ids: readonly string[];
  };
}
export interface RetiredArtifact {
  readonly reference: string;
  readonly artifact: ArtifactRef;
}
export interface ContentCleanupRepository {
  contentCleanupSnapshot(id: string): Promise<ContentCleanupSnapshot | null>;
  cleanupNoUsableContent(
    command: ContentCleanupCommand,
  ): Promise<readonly RetiredArtifact[] | null>;
}
export class ContentCleanupFailure extends Error {
  constructor(
    readonly code:
      | "content-cleanup-input"
      | "content-cleanup-stale"
      | "content-cleanup-integrity"
      | "content-cleanup-cancelled"
      | "content-cleanup-storage",
  ) {
    super("content cleanup failed");
  }
}
const same = (a: unknown, b: unknown) =>
  Buffer.from(contentCanonicalJsonBytes(a)).equals(
    Buffer.from(contentCanonicalJsonBytes(b)),
  );
/** Literature decides the outgoing support changes; Storage compares and atomically commits the offered closure. */
export class LiteratureCleanupService {
  constructor(
    private readonly repository: ContentCleanupRepository,
    private readonly files: LiteratureArtifactReader,
  ) {}
  async cleanup(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<{
    readonly outcome: "catalog_cleaned";
    readonly input: AnalysisInputIdentity;
    readonly retired_artifacts: readonly RetiredArtifact[];
  }> {
    const command = await this.prepare(value, signal);
    const input = command.input;
    if (signal?.aborted)
      throw new ContentCleanupFailure("content-cleanup-cancelled");
    let retired: readonly RetiredArtifact[] | null;
    try {
      retired = await this.repository.cleanupNoUsableContent(command);
    } catch {
      throw new ContentCleanupFailure("content-cleanup-storage");
    }
    if (retired === null)
      throw new ContentCleanupFailure("content-cleanup-stale");
    return { outcome: "catalog_cleaned", input, retired_artifacts: retired };
  }
  async prepare(
    value: unknown,
    signal?: AbortSignal,
  ): Promise<ContentCleanupCommand> {
    const check = () => {
      if (signal?.aborted)
        throw new ContentCleanupFailure("content-cleanup-cancelled");
    };
    check();
    let input: AnalysisInputIdentity;
    try {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join() !== "input,outcome" ||
        !("outcome" in value) ||
        value.outcome !== "no_usable_content" ||
        !("input" in value)
      )
        throw new Error("invalid decision");
      input = parseAnalysisInputIdentity(value.input);
    } catch {
      throw new ContentCleanupFailure("content-cleanup-input");
    }
    const captured = await this.repository.contentCleanupSnapshot(
      input.literature_id,
    );
    if (!captured) throw new ContentCleanupFailure("content-cleanup-stale");
    let command: ContentCleanupCommand;
    try {
      if (!/^[0-9a-f]{64}$/.test(captured.token))
        throw new Error("invalid token");
      const detail = await verifyLiteratureDetailSnapshot(
        input.literature_id,
        captured.snapshot,
        this.files,
      );
      const primary = detail.primary_pdf,
        parser = detail.parser_result;
      if (
        !primary ||
        !parser ||
        !same(input, {
          literature_id: detail.literature.literature_id,
          primary_asset_id: primary.asset.asset_id,
          primary_pdf_sha256: primary.asset.sha256,
          parser_result_sha256: parser.result_sha256,
          input_metadata_revision: detail.metadata_revision,
          input_metadata_sha256: detail.metadata_sha256,
        })
      )
        throw new ContentCleanupFailure("content-cleanup-stale");
      const refs = captured.references.map(parseReferenceDetail);
      if (
        refs.length !== captured.reference_count ||
        refs.length !== detail.reference_count ||
        refs.some(
          (r) => r.reference.source_literature_id !== input.literature_id,
        )
      )
        throw new Error("invalid reference closure");
      const m = detail.literature.metadata,
        index = (v: string | null) => ftsIndexText(v ?? "");
      const body =
        detail.content?.sections
          .flatMap((s) => [
            s.title ?? "",
            s.markdown,
            ...s.subsections.flatMap((sub) => [sub.title, sub.markdown]),
          ])
          .map(ftsIndexText)
          .filter(Boolean)
          .join("\n") ?? "";
      if (
        !same(captured.fts, [
          {
            literature_id: input.literature_id,
            title: index(m.title),
            abstract: index(m.abstract),
            authors: index(
              m.authors
                .flatMap((a) => [
                  a.display_name,
                  a.given_name,
                  a.family_name,
                  a.orcid,
                ])
                .filter(Boolean)
                .join(" "),
            ),
            affiliations: index(
              m.authors
                .flatMap((a) => a.affiliations.flatMap((f) => [f.name, f.ror]))
                .filter(Boolean)
                .join(" "),
            ),
            identifiers: index(
              m.identifiers.flatMap((i) => [i.namespace, i.value]).join(" "),
            ),
            keywords: index(m.keywords.join(" ")),
            venue: index(m.venue),
            publisher: index(m.publisher),
            volume: index(m.volume),
            issue: index(m.issue),
            pages: index(m.pages),
            content_body: body,
          },
        ])
      )
        throw new Error("invalid FTS closure");
      const old = detail.content?.literature_content_sha256;
      const removed = refs.flatMap((r) =>
        r.supports.filter(
          (s) =>
            s.source.kind === "content_reference_text" &&
            s.source.literature_content_sha256 === old,
        ),
      );
      const deleted = refs
        .filter(
          (r) =>
            r.supports.length > 0 &&
            r.supports.every((s) => removed.includes(s)),
        )
        .map((r) => r.reference.reference_id)
        .sort();
      command = {
        input,
        token: captured.token,
        removed_supports: removed,
        deleted_reference_ids: deleted,
      };
    } catch (error) {
      if (error instanceof ContentCleanupFailure) throw error;
      throw new ContentCleanupFailure("content-cleanup-integrity");
    }

    check();
    return command;
  }
}
