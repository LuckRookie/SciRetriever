import {
  parseIdentifier,
  parseArticleIdentityAssessment,
  type ArticleIdentityAssessment,
  type ArticleIdentityEvidence,
  type LiteratureMetadata,
  type LiteratureDetail,
} from "@sciretriever/contracts";

export class ArticleIdentityAcceptanceError extends Error {
  constructor(
    readonly code: "article-identity-stale" | "article-identity-cancelled",
  ) {
    super("article identity acceptance refused");
  }
}
/** Literature is the sole business writer of an article/material association assessment. */
export class LiteratureArticleIdentityService {
  constructor(
    private readonly library: { detail(id: string): Promise<LiteratureDetail> },
    private readonly repository: {
      publishArticleIdentity(
        value: ArticleIdentityAssessment,
      ): Promise<boolean>;
    },
  ) {}
  async accept(
    proposal: Omit<ArticleIdentityAssessment, "status" | "reason">,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted)
      throw new ArticleIdentityAcceptanceError("article-identity-cancelled");
    const current = await this.library.detail(proposal.literature_id);
    if (
      current.metadata_revision !== proposal.metadata_revision ||
      current.metadata_sha256 !== proposal.metadata_sha256 ||
      ![
        ...(current.primary_pdf ? [current.primary_pdf] : []),
        ...current.additional_assets,
      ].some(
        (a) =>
          a.asset.asset_id === proposal.asset_id &&
          a.asset.sha256 === proposal.asset_sha256,
      )
    )
      throw new ArticleIdentityAcceptanceError("article-identity-stale");
    const assessment = parseArticleIdentityAssessment({
      ...proposal,
      ...compareArticleIdentity(current.literature.metadata, proposal.evidence),
    });
    if (signal?.aborted)
      throw new ArticleIdentityAcceptanceError("article-identity-cancelled");
    return {
      assessment,
      published: await this.repository.publishArticleIdentity(assessment),
    };
  }
}

/** Comparison only: extraction and its evidence belong to Parsing. No identity merge or asset mutation. */
export function compareArticleIdentity(
  metadata: LiteratureMetadata,
  evidence: readonly ArticleIdentityEvidence[],
): Pick<ArticleIdentityAssessment, "status" | "reason"> {
  let match = false;
  let conflict = false;
  for (const namespace of ["doi", "arxiv", "pmid", "pmcid"] as const) {
    const expected = metadata.identifiers.filter(
      (i) => i.namespace === namespace,
    );
    const observed = evidence
      .filter((i) => i.field === namespace)
      .map((i) => {
        try {
          return parseIdentifier({ namespace, value: i.value }).value;
        } catch {
          return null;
        }
      })
      .filter((v): v is string => v !== null);
    if (!expected.length || !observed.length) continue;
    // Several different claimed article IDs in one namespace are ambiguous.
    if (new Set(observed).size !== 1)
      return {
        status: "insufficient-evidence",
        reason: "insufficient-evidence",
      };
    if (expected.some((e) => observed.includes(e.value))) match = true;
    else conflict = true;
  }
  if (conflict) return { status: "conflict", reason: "identifier-conflict" };
  if (match) return { status: "match-supported", reason: "identifier-match" };
  const key = (v: string) =>
    v
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\p{P}\p{Z}\s]/gu, "");
  const title =
    metadata.title &&
    evidence.some(
      (e) => e.field === "title" && key(e.value) === key(metadata.title!),
    );
  const author = metadata.authors.some((a) =>
    evidence.some(
      (e) => e.field === "author" && key(e.value) === key(a.display_name),
    ),
  );
  if (title && author)
    return { status: "match-supported", reason: "title-and-author-match" };
  return { status: "insufficient-evidence", reason: "insufficient-evidence" };
}
