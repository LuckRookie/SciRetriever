import {
  EMPTY_METADATA,
  type IntakeBatchItem,
  type LiteratureId,
  type LiteratureMetadata,
  type MetadataObservation,
} from "@sciretriever/contracts";
import type { LiteratureIdentityService } from "./identity.js";
import { fallbackIdentityKey } from "./identity-rules.js";
import { recognitionSimilarity } from "./intake-recognition.js";

/** A read-only bibliography projection; no document, observation or asset bytes. */
export interface PossibleDuplicatePaper {
  readonly literature_id: LiteratureId;
  readonly title: LiteratureMetadata["title"];
  readonly authors: LiteratureMetadata["authors"];
  readonly publication_year: LiteratureMetadata["publication_year"];
  readonly publication_form: LiteratureMetadata["publication_form"];
}
export type PossibleDuplicate = IntakeBatchItem["possible_duplicates"][number];

function firstFamily(metadata: Pick<LiteratureMetadata, "authors">) {
  const author = metadata.authors[0];
  if (!author) return null;
  const name =
    author.family_name ??
    (author.kind === "organization"
      ? author.display_name
      : author.display_name.includes(",")
        ? author.display_name.split(",")[0]!
        : author.display_name.trim().split(/\s+/u).at(-1)!);
  return name.normalize("NFKC").toLowerCase().trim();
}

/** Fuzzy candidates never make an identity decision or publish a fact. */
export function findPossibleDuplicates(
  metadata: LiteratureMetadata,
  papers: readonly PossibleDuplicatePaper[],
): readonly PossibleDuplicate[] {
  if (metadata.identifiers.length || !metadata.title) return [];
  const strict = fallbackIdentityKey(metadata);
  if (
    strict &&
    papers.some((paper) => {
      const key = fallbackIdentityKey({
        ...EMPTY_METADATA,
        title: paper.title,
        authors: paper.authors,
        publication_year: paper.publication_year,
        publication_form: paper.publication_form,
      });
      return key && JSON.stringify(key) === JSON.stringify(strict);
    })
  )
    return [];
  const family = firstFamily(metadata);
  return papers
    .flatMap((paper): PossibleDuplicate[] => {
      if (!paper.title) return [];
      const otherFamily = firstFamily(paper);
      if (family && otherFamily && family !== otherFamily) return [];
      if (
        metadata.publication_year !== null &&
        paper.publication_year !== null &&
        Math.abs(metadata.publication_year - paper.publication_year) > 1
      )
        return [];
      const similarity = recognitionSimilarity(metadata.title!, paper.title);
      return similarity < 0.9
        ? []
        : [
            {
              literature_id: paper.literature_id,
              title: paper.title,
              first_author: paper.authors[0]?.display_name ?? null,
              publication_year: paper.publication_year,
              similarity,
            },
          ];
    })
    .sort(
      (a, b) =>
        b.similarity - a.similarity ||
        (a.literature_id < b.literature_id
          ? -1
          : a.literature_id > b.literature_id
            ? 1
            : 0),
    )
    .slice(0, 3);
}

type IdentityPreview = Awaited<
  ReturnType<LiteratureIdentityService["preview"]>
>;
export class PossibleDuplicateService {
  constructor(
    private readonly read: () => Promise<readonly PossibleDuplicatePaper[]>,
    private readonly identity: Pick<LiteratureIdentityService, "preview">,
  ) {}
  async find(
    observation: MetadataObservation,
    hasSourceLibrary: boolean,
    options: {
      readonly snapshot?: readonly PossibleDuplicatePaper[];
      readonly assessment?: Pick<IdentityPreview, "disposition">;
    } = {},
  ): Promise<readonly PossibleDuplicate[]> {
    if (hasSourceLibrary || observation.metadata.identifiers.length) return [];
    const assessment =
      options.assessment ?? (await this.identity.preview(observation));
    if (assessment.disposition !== "created") return [];
    return findPossibleDuplicates(
      observation.metadata,
      options.snapshot ?? (await this.read()),
    );
  }
}
