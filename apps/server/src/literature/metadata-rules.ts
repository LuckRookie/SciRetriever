import {
  canonicalJsonBytes,
  parseLiterature,
  parseLiteratureMetadata,
  parseMetadataObservation,
  sha256,
  type Affiliation,
  type Author,
  type Literature,
  type LiteratureMetadata,
  type MetadataObservation,
} from "@sciretriever/contracts";
import {
  normalizeIdentityText,
  resolveLiteratureIdentity,
  STABLE_IDENTIFIER_NAMESPACES,
  type LiteratureIdentityResolution,
} from "./identity-rules.js";

const USER_OBSERVATION_HASH_TAG = "sciretriever-user-observation-semantic-v1";

export type MetadataProjectionDecision =
  | {
      readonly outcome: "projected" | "unchanged" | "preserved";
      readonly metadata: LiteratureMetadata;
      readonly metadata_revision: number;
      readonly changed: boolean;
      readonly projection_preserved: boolean;
      readonly observations_projection_changed: boolean;
      readonly reason: string | null;
    }
  | {
      readonly outcome: "rejected";
      readonly metadata: null;
      readonly metadata_revision: number;
      readonly changed: false;
      readonly projection_preserved: false;
      readonly observations_projection_changed: false;
      readonly reason: string;
    };

export type MetadataObservationAcceptanceDecision =
  | {
      readonly outcome: "created" | "matched";
      readonly observation: MetadataObservation;
      readonly literature: Literature | null;
      readonly observations: readonly MetadataObservation[];
      readonly identity: LiteratureIdentityResolution;
      readonly projection: Exclude<
        MetadataProjectionDecision,
        { readonly outcome: "rejected" }
      >;
      readonly reason: string | null;
      readonly deduplicated: boolean;
    }
  | {
      readonly outcome: "rejected";
      readonly observation: null;
      readonly literature: null;
      readonly observations: readonly [];
      readonly identity: LiteratureIdentityResolution | null;
      readonly projection: null;
      readonly reason: string;
      readonly deduplicated: false;
    };

function rejectedProjection(
  metadataRevision: number,
  reason: string,
): MetadataProjectionDecision {
  return {
    outcome: "rejected",
    metadata: null,
    metadata_revision: metadataRevision,
    changed: false,
    projection_preserved: false,
    observations_projection_changed: false,
    reason,
  };
}

function rejectedAcceptance(
  reason: string,
  identity: LiteratureIdentityResolution | null = null,
): MetadataObservationAcceptanceDecision {
  return {
    outcome: "rejected",
    observation: null,
    literature: null,
    observations: [],
    identity,
    projection: null,
    reason,
    deduplicated: false,
  };
}

function equal(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalJsonBytes(left)).equals(
    Buffer.from(canonicalJsonBytes(right)),
  );
}

function orderedObservations(
  observations: readonly MetadataObservation[],
  precedence: readonly string[],
): readonly MetadataObservation[] {
  if (
    !Array.isArray(precedence) ||
    precedence.some((name) => typeof name !== "string" || !name.trim()) ||
    new Set(precedence).size !== precedence.length
  )
    throw new TypeError("provider precedence is invalid");
  const users = observations.filter(
    (item) => item.provenance.source_kind === "user",
  );
  const providers = observations.filter(
    (item) => item.provenance.source_kind === "metadata-provider",
  );
  const listed = new Set(precedence);
  return Object.freeze([
    ...users,
    ...precedence.flatMap((name) =>
      providers.filter((item) => item.provenance.source_name === name),
    ),
    ...providers.filter((item) => !listed.has(item.provenance.source_name)),
  ]);
}

function sameAffiliation(left: Affiliation, right: Affiliation): boolean {
  return (
    (left.ror !== null && right.ror !== null && left.ror === right.ror) ||
    normalizeIdentityText(left.name) === normalizeIdentityText(right.name)
  );
}

function supplementAuthor(base: Author, source: Author): Author {
  const affiliations = [...base.affiliations];
  for (const candidate of source.affiliations)
    if (!affiliations.some((current) => sameAffiliation(current, candidate)))
      affiliations.push(candidate);
  return Object.freeze({
    kind: base.kind,
    display_name: base.display_name,
    given_name: base.given_name ?? source.given_name,
    family_name: base.family_name ?? source.family_name,
    orcid: base.orcid ?? source.orcid,
    affiliations: Object.freeze(affiliations),
  });
}

function authorListsAlign(
  base: readonly Author[],
  source: readonly Author[],
): boolean {
  if (
    base.length === 1 &&
    source.length === 1 &&
    base[0]!.orcid !== null &&
    base[0]!.orcid === source[0]!.orcid
  )
    return true;
  return (
    base.length === source.length &&
    base.every(
      (author, index) =>
        author.kind === source[index]!.kind &&
        normalizeIdentityText(author.display_name) ===
          normalizeIdentityText(source[index]!.display_name),
    )
  );
}

function buildProjection(observations: readonly MetadataObservation[]): {
  readonly metadata: LiteratureMetadata | null;
  readonly failure: string | null;
} {
  const scalarFields = [
    "title",
    "abstract",
    "publication_date",
    "publication_year",
    "document_type",
    "language",
    "venue",
    "publisher",
    "volume",
    "issue",
    "pages",
  ] as const;
  const values: Record<string, unknown> = {};
  for (const field of scalarFields) {
    const source = observations.find(
      (observation) => observation.metadata[field] !== null,
    );
    values[field] = source?.metadata[field] ?? null;
  }
  const identifiers: { readonly namespace: string; readonly value: string }[] =
    [];
  const seen = new Set<string>();
  const stable = new Map<string, Set<string>>();
  for (const observation of observations)
    for (const identifier of observation.metadata.identifiers) {
      const key = `${identifier.namespace}\u0000${identifier.value}`;
      if (STABLE_IDENTIFIER_NAMESPACES.has(identifier.namespace)) {
        const values = stable.get(identifier.namespace) ?? new Set<string>();
        values.add(identifier.value);
        if (values.size > 1)
          return { metadata: null, failure: "stable-identifier-conflict" };
        stable.set(identifier.namespace, values);
      }
      if (!seen.has(key)) {
        seen.add(key);
        identifiers.push(identifier);
      }
    }
  let authors: readonly Author[] = [];
  for (const observation of observations) {
    const source = observation.metadata.authors;
    if (!source.length) continue;
    if (!authors.length) authors = source;
    else if (authorListsAlign(authors, source))
      authors = authors.map((author, index) =>
        supplementAuthor(author, source[index]!),
      );
  }
  const keywords =
    observations.find(
      (observation) =>
        observation.provenance.source_kind === "user" &&
        observation.metadata.keywords.length > 0,
    )?.metadata.keywords ?? [];
  return {
    metadata: parseLiteratureMetadata({
      ...values,
      authors,
      identifiers,
      keywords,
    }),
    failure: null,
  };
}

function stableValues(
  metadata: LiteratureMetadata,
): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, Set<string>>();
  for (const identifier of metadata.identifiers) {
    if (!STABLE_IDENTIFIER_NAMESPACES.has(identifier.namespace)) continue;
    const values = result.get(identifier.namespace) ?? new Set<string>();
    values.add(identifier.value);
    result.set(identifier.namespace, values);
  }
  return result;
}

function pairConflict(
  current: LiteratureMetadata,
  candidate: LiteratureMetadata,
): boolean {
  const left = stableValues(current);
  const right = stableValues(candidate);
  for (const namespace of STABLE_IDENTIFIER_NAMESPACES) {
    const a = left.get(namespace);
    const b = right.get(namespace);
    if (
      a?.size &&
      b?.size &&
      (a.size !== b.size || [...a].some((value) => !b.has(value)))
    )
      return true;
  }
  return false;
}

export function projectMetadata(
  values: readonly MetadataObservation[],
  options: {
    readonly provider_precedence?: readonly string[];
    readonly current_metadata?: LiteratureMetadata | null;
    readonly metadata_revision?: number;
    readonly expected_metadata_revision?: number | null;
    readonly content_ready?: boolean;
  } = {},
): MetadataProjectionDecision {
  if (!Array.isArray(values))
    throw new TypeError("observations must be an array");
  const observations = values.map(parseMetadataObservation);
  const metadataRevision = options.metadata_revision ?? 1;
  if (!Number.isSafeInteger(metadataRevision) || metadataRevision < 1)
    throw new TypeError("metadata revision is invalid");
  const expected = options.expected_metadata_revision ?? null;
  if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1))
    throw new TypeError("expected metadata revision is invalid");
  if (expected !== null && expected !== metadataRevision)
    return rejectedProjection(metadataRevision, "metadata-revision-stale");
  const current =
    options.current_metadata === undefined || options.current_metadata === null
      ? null
      : parseLiteratureMetadata(options.current_metadata);
  const contentReady = options.content_ready ?? false;
  if (typeof contentReady !== "boolean" || (contentReady && !current))
    throw new TypeError("content-ready projection input is invalid");
  const ordered = orderedObservations(
    observations,
    options.provider_precedence ?? [],
  );
  const built = buildProjection(ordered);
  if (!built.metadata)
    return rejectedProjection(metadataRevision, built.failure!);
  if (current && pairConflict(current, built.metadata))
    return rejectedProjection(metadataRevision, "stable-identifier-conflict");
  if (!current)
    return {
      outcome: "projected",
      metadata: built.metadata,
      metadata_revision: metadataRevision,
      changed: true,
      projection_preserved: false,
      observations_projection_changed: false,
      reason: null,
    };
  if (contentReady)
    return {
      outcome: "preserved",
      metadata: current,
      metadata_revision: metadataRevision,
      changed: false,
      projection_preserved: true,
      observations_projection_changed: false,
      reason: "content-ready-current-metadata-preserved",
    };
  if (equal(current, built.metadata))
    return {
      outcome: "unchanged",
      metadata: current,
      metadata_revision: metadataRevision,
      changed: false,
      projection_preserved: false,
      observations_projection_changed: false,
      reason: null,
    };
  return {
    outcome: "projected",
    metadata: built.metadata,
    metadata_revision: metadataRevision + 1,
    changed: true,
    projection_preserved: false,
    observations_projection_changed: false,
    reason: null,
  };
}

function observationSemanticValue(
  observation: MetadataObservation,
): Record<string, unknown> {
  return {
    asset_hints: observation.asset_hints,
    cited_by_count: observation.cited_by_count,
    declared_keywords: observation.declared_keywords,
    metadata: observation.metadata,
    provenance: {
      source_kind: observation.provenance.source_kind,
      source_name: observation.provenance.source_name,
      source_record_id: observation.provenance.source_record_id,
      input_sha256: observation.provenance.input_sha256,
      parameters_sha256: observation.provenance.parameters_sha256,
    },
    reference_count: observation.reference_count,
    reference_texts: observation.reference_texts,
    version_links: observation.version_links,
    version_role: observation.version_role,
  };
}

export function sameUserObservation(
  leftValue: MetadataObservation,
  rightValue: MetadataObservation,
): boolean {
  const left = parseMetadataObservation(leftValue);
  const right = parseMetadataObservation(rightValue);
  return (
    left.provenance.source_kind === "user" &&
    right.provenance.source_kind === "user" &&
    equal(observationSemanticValue(left), observationSemanticValue(right))
  );
}

export function sameProviderObservation(
  leftValue: MetadataObservation,
  rightValue: MetadataObservation,
): boolean {
  const left = parseMetadataObservation(leftValue);
  const right = parseMetadataObservation(rightValue);
  return (
    left.provenance.source_kind === "metadata-provider" &&
    right.provenance.source_kind === "metadata-provider" &&
    equal(observationSemanticValue(left), observationSemanticValue(right))
  );
}

export function userObservationSemanticSha256(
  value: MetadataObservation,
): Promise<string> {
  const observation = parseMetadataObservation(value);
  if (observation.provenance.source_kind !== "user")
    throw new TypeError("semantic hash requires a user observation");
  return sha256(
    canonicalJsonBytes({
      schema: USER_OBSERVATION_HASH_TAG,
      value: observationSemanticValue(observation),
    }),
  );
}

export function acceptMetadataObservation(
  value: MetadataObservation,
  options: {
    readonly existing_literature?: readonly Literature[];
    readonly existing_observations?: readonly MetadataObservation[];
    readonly provider_precedence?: readonly string[];
    readonly current_metadata?: LiteratureMetadata | null;
    readonly metadata_revision?: number;
    readonly expected_metadata_revision?: number | null;
    readonly content_ready?: boolean;
  } = {},
): MetadataObservationAcceptanceDecision {
  const observation = parseMetadataObservation(value);
  const existing = (options.existing_observations ?? []).map(
    parseMetadataObservation,
  );
  const literatures = (options.existing_literature ?? []).map(parseLiterature);
  if (
    observation.metadata.title === null &&
    !observation.metadata.identifiers.some(
      (identifier) => identifier.namespace === "doi",
    )
  )
    return rejectedAcceptance("missing-title-or-doi");
  const identity = resolveLiteratureIdentity(observation.metadata, literatures);
  if (identity.decision === "identity-conflict")
    return rejectedAcceptance(identity.reason, identity);
  const sameId = existing.filter(
    (item) => item.observation_id === observation.observation_id,
  );
  if (sameId.length > 1)
    return rejectedAcceptance("observation-replay-ambiguous", identity);
  if (
    sameId.length === 1 &&
    !(
      sameUserObservation(sameId[0]!, observation) ||
      sameProviderObservation(sameId[0]!, observation)
    )
  )
    return rejectedAcceptance("observation-id-conflict", identity);
  const semanticMatches =
    observation.provenance.source_kind === "user"
      ? existing.filter((item) => sameUserObservation(item, observation))
      : sameId;
  if (semanticMatches.length > 1)
    return rejectedAcceptance("observation-replay-ambiguous", identity);
  const duplicate = semanticMatches[0] ?? null;
  const merged = duplicate ? existing : [...existing, observation];
  const projectionOptions = {
    ...(options.provider_precedence === undefined
      ? {}
      : { provider_precedence: options.provider_precedence }),
    ...(options.current_metadata === undefined
      ? {}
      : { current_metadata: options.current_metadata }),
    ...(options.metadata_revision === undefined
      ? {}
      : { metadata_revision: options.metadata_revision }),
    ...(options.expected_metadata_revision === undefined
      ? {}
      : { expected_metadata_revision: options.expected_metadata_revision }),
    ...(options.content_ready === undefined
      ? {}
      : { content_ready: options.content_ready }),
  };
  let projection = projectMetadata(merged, projectionOptions);
  if (projection.outcome === "rejected")
    return rejectedAcceptance(projection.reason, identity);
  if (!duplicate) {
    const precedenceOptions =
      options.provider_precedence === undefined
        ? {}
        : { provider_precedence: options.provider_precedence };
    const before = projectMetadata(existing, precedenceOptions);
    const after = projectMetadata(merged, precedenceOptions);
    if (before.outcome === "rejected")
      return rejectedAcceptance(before.reason, identity);
    if (after.outcome === "rejected")
      return rejectedAcceptance(after.reason, identity);
    projection = {
      ...projection,
      observations_projection_changed: !equal(before.metadata, after.metadata),
    };
  }
  return {
    outcome:
      duplicate !== null || identity.decision === "matched"
        ? "matched"
        : "created",
    observation: duplicate ?? observation,
    literature: identity.decision === "matched" ? identity.literature : null,
    observations: Object.freeze(merged),
    identity,
    projection,
    reason: duplicate ? "duplicate-observation" : identity.reason,
    deduplicated: duplicate !== null,
  };
}
