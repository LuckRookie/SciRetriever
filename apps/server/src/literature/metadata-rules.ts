import { normalizeQueryText } from "./unicode-casefold.js";
import {
  adjudicateMetadataFields,
  metadataFieldEmpty,
} from "./metadata-fields.js";
import {
  EMPTY_METADATA,
  METADATA_FIELDS,
  type MetadataFieldState,
  type MetadataFieldCandidate,
} from "@sciretriever/contracts";
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
      readonly field_states: readonly MetadataFieldState[];
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
  // This source replaces an unrecognized intake placeholder. Keep that choice
  // when later observations rebuild candidates; explicit manual locks still win.
  users.sort(
    (a, b) =>
      Number(b.provenance.source_name === "post-parse-recognition") -
      Number(a.provenance.source_name === "post-parse-recognition"),
  );
  const providers = observations
    .filter((item) => item.provenance.source_kind === "metadata-provider")
    .map((item) => ({
      ...item,
      metadata: { ...item.metadata, keywords: item.declared_keywords },
    }));
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

export function authorListsAlign(
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
    "publication_form",
    "article_kind",
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
    observations.find((o) => o.metadata.keywords.length > 0)?.metadata
      .keywords ?? [];
  const subject_terms: string[] = [],
    termsSeen = new Set<string>();
  for (const o of observations.filter(
    (o) => o.provenance.source_kind === "metadata-provider",
  ))
    for (const term of o.metadata.subject_terms) {
      const key = normalizeQueryText(term);
      if (!termsSeen.has(key)) {
        termsSeen.add(key);
        subject_terms.push(term);
      }
    }
  return {
    metadata: parseLiteratureMetadata({
      ...values,
      authors,
      identifiers,
      keywords,
      subject_terms: subject_terms.slice(0, 8),
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

export function metadataObservationCandidates(
  observations: readonly MetadataObservation[],
  precedence: readonly string[] = [],
): readonly MetadataFieldCandidate[] {
  const ordered = orderedObservations(observations, precedence);
  const built = buildProjection(
    ordered.filter((o) => o.provenance.source_name !== "manual-metadata"),
  );
  if (!built.metadata)
    throw new Error(built.failure ?? "metadata-projection-invalid");
  const candidates: MetadataFieldCandidate[] = [];
  for (const field of METADATA_FIELDS) {
    const sources = ordered.filter(
      (o) =>
        o.provenance.source_name !== "manual-metadata" &&
        !metadataFieldEmpty(o.metadata[field]) &&
        (field !== "keywords" ||
          o.provenance.source_kind !== "metadata-provider" ||
          o.declared_keywords.length > 0),
    );
    for (let index = 0; index < sources.length; index++) {
      const observation = sources[index]!;
      candidates.push({
        field,
        value:
          index === 0 && (field === "authors" || field === "identifiers")
            ? built.metadata[field]
            : observation.metadata[field],
        evidence: {
          source:
            observation.provenance.source_kind === "user"
              ? "manual"
              : "authority",
          observation_id: observation.observation_id,
          provenance: observation.provenance,
        },
      });
    }
  }
  return candidates;
}

export function projectMetadata(
  values: readonly MetadataObservation[],
  options: {
    readonly provider_precedence?: readonly string[];
    readonly current_metadata?: LiteratureMetadata | null;
    readonly metadata_revision?: number;
    readonly expected_metadata_revision?: number | null;
    readonly content_ready?: boolean;
    readonly field_states?: readonly MetadataFieldState[];
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
  const built = buildProjection(
    ordered.filter((o) => o.provenance.source_name !== "manual-metadata"),
  );
  if (!built.metadata)
    return rejectedProjection(metadataRevision, built.failure!);
  if (current && pairConflict(current, built.metadata))
    return rejectedProjection(metadataRevision, "stable-identifier-conflict");
  const candidates = metadataObservationCandidates(
    ordered,
    options.provider_precedence,
  );
  const resolved = adjudicateMetadataFields({
    current: current ?? EMPTY_METADATA,
    states: options.field_states ?? [],
    candidates,
    preserve_nonempty: contentReady,
  });
  const projectedMetadata = parseLiteratureMetadata({
    ...resolved.metadata,
    subject_terms: built.metadata.subject_terms,
  });
  const stateOrder = (states: readonly MetadataFieldState[]) =>
    [...states].sort((a, b) => a.field.localeCompare(b.field));
  const same =
    current !== null &&
    equal(current, projectedMetadata) &&
    (options.field_states === undefined ||
      equal(stateOrder(options.field_states), stateOrder(resolved.states)));
  return {
    outcome: same ? (contentReady ? "preserved" : "unchanged") : "projected",
    metadata: projectedMetadata,
    field_states: resolved.states,
    metadata_revision: metadataRevision + (current && !same ? 1 : 0),
    changed: !same,
    projection_preserved: contentReady,
    observations_projection_changed: false,
    reason: contentReady ? "ready-nonempty-metadata-preserved" : null,
  };
}

function observationSemanticValue(
  observation: MetadataObservation,
): Record<string, unknown> {
  const { subject_terms, ...historicMetadata } = observation.metadata;
  return {
    asset_hints: observation.asset_hints,
    cited_by_count: observation.cited_by_count,
    declared_keywords: observation.declared_keywords,
    metadata: subject_terms.length ? observation.metadata : historicMetadata,
    source_type: observation.source_type,
    source_type_mapping_version: observation.source_type_mapping_version,
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
    readonly field_states?: readonly MetadataFieldState[];
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
      (identifier) =>
        identifier.namespace === "doi" ||
        (identifier.namespace === "arxiv" &&
          observation.provenance.source_kind === "user" &&
          observation.provenance.source_name === "web-capture"),
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
    ...(options.field_states === undefined
      ? {}
      : { field_states: options.field_states }),
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

export {
  mapSourceType,
  SOURCE_TYPE_MAPPING_VERSION,
} from "./metadata-types.js";
