import {
  canonicalJsonBytes,
  parseLiterature,
  parseLiteratureMetadata,
  parseMetadataObservation,
  sha256,
  type Literature,
  type LiteratureMetadata,
  type MetadataObservation,
  type ProviderLiteratureKey,
} from "@sciretriever/contracts";
import { normalizeQueryText } from "./unicode-casefold.js";

export const STABLE_IDENTIFIER_NAMESPACES = Object.freeze(
  new Set(["doi", "arxiv", "pmid", "pmcid"]),
);
const FALLBACK_IDENTITY_HASH_TAG =
  "sciretriever-literature-fallback-identity-v1";

export type StableIdentifierKey = readonly [namespace: string, value: string];
export type FallbackIdentityKey = readonly [
  title: string,
  authors: readonly string[],
  publicationYear: number,
  documentType: string,
];
export type LiteratureIdentityResolution =
  | {
      readonly decision: "matched";
      readonly literature: Literature;
      readonly reason: "stable-identifier" | "fallback";
    }
  | {
      readonly decision: "created";
      readonly literature: null;
      readonly reason:
        | "no-stable-identifier-match"
        | "incomplete-fallback-key"
        | "no-fallback-match";
    }
  | {
      readonly decision: "identity-conflict";
      readonly literature: null;
      readonly reason:
        | "incoming-stable-identifier-conflict"
        | "stable-identifier-ambiguity"
        | "stable-identifier-conflict"
        | "fallback-ambiguity";
    };

export interface VersionEvidence {
  readonly literature: Literature;
  readonly observations: readonly MetadataObservation[];
}
export type MetaLiteratureResolution =
  | {
      readonly decision: "linked";
      readonly meta_literature_id: string;
      readonly linked_literature_ids: readonly string[];
    }
  | {
      readonly decision: "independent" | "identity-conflict";
      readonly meta_literature_id: null;
      readonly linked_literature_ids: readonly [];
    };

export function normalizeIdentityText(value: string): string {
  if (typeof value !== "string")
    throw new TypeError("identity text must be a string");
  return normalizeQueryText(value);
}

export function stableIdentifierKeys(
  value: LiteratureMetadata,
): readonly StableIdentifierKey[] {
  const metadata = parseLiteratureMetadata(value);
  const seen = new Set<string>();
  const result: StableIdentifierKey[] = [];
  for (const identifier of metadata.identifiers) {
    if (!STABLE_IDENTIFIER_NAMESPACES.has(identifier.namespace)) continue;
    const composite = `${identifier.namespace}\u0000${identifier.value}`;
    if (seen.has(composite)) continue;
    seen.add(composite);
    result.push(Object.freeze([identifier.namespace, identifier.value]));
  }
  return Object.freeze(result);
}

export function stableIdentifierIndex(
  metadata: LiteratureMetadata,
): readonly StableIdentifierKey[] {
  return Object.freeze(
    [...stableIdentifierKeys(metadata)].sort(
      ([leftNamespace, leftValue], [rightNamespace, rightValue]) =>
        leftNamespace === rightNamespace
          ? leftValue.localeCompare(rightValue)
          : leftNamespace.localeCompare(rightNamespace),
    ),
  );
}

function byNamespace(
  keys: readonly StableIdentifierKey[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const values = new Map<string, Set<string>>();
  for (const [namespace, value] of keys) {
    const current = values.get(namespace) ?? new Set<string>();
    current.add(value);
    values.set(namespace, current);
  }
  return values;
}

export function providerKeyMatchesSeed(
  providerName: string,
  key: ProviderLiteratureKey,
  seedObservations: readonly MetadataObservation[],
): boolean {
  if (typeof providerName !== "string")
    throw new TypeError("provider name must be a string");
  if (!providerName.trim())
    throw new TypeError("provider name must be nonblank");
  if (
    !key ||
    typeof key !== "object" ||
    !Array.isArray(key.identifiers) ||
    !Array.isArray(seedObservations)
  )
    throw new TypeError("provider key match input is invalid");
  const observations = seedObservations.map(parseMetadataObservation);
  const keyStable = stableIdentifierKeys(
    parseLiteratureMetadata({
      title: null,
      authors: [],
      abstract: null,
      publication_date: null,
      publication_year: null,
      document_type: null,
      language: null,
      venue: null,
      publisher: null,
      volume: null,
      issue: null,
      pages: null,
      identifiers: key.identifiers,
      keywords: [],
    }),
  );
  if ([...byNamespace(keyStable).values()].some((values) => values.size > 1))
    return false;
  const seedStable = new Set(
    observations
      .flatMap((observation) => stableIdentifierKeys(observation.metadata))
      .map(([namespace, value]) => `${namespace}\u0000${value}`),
  );
  const recordMatches =
    key.record_id !== null &&
    observations.some(
      (observation) =>
        observation.provenance.source_kind === "metadata-provider" &&
        observation.provenance.source_name === providerName &&
        observation.provenance.source_record_id === key.record_id,
    );
  if (key.record_id !== null && !recordMatches) return false;
  if (
    keyStable.some(
      ([namespace, value]) => !seedStable.has(`${namespace}\u0000${value}`),
    )
  )
    return false;
  return recordMatches || keyStable.length > 0;
}

export function fallbackIdentityKey(
  value: LiteratureMetadata,
): FallbackIdentityKey | null {
  const metadata = parseLiteratureMetadata(value);
  if (
    metadata.title === null ||
    metadata.authors.length === 0 ||
    metadata.publication_year === null ||
    metadata.document_type === null
  )
    return null;
  return Object.freeze([
    normalizeIdentityText(metadata.title),
    Object.freeze(
      metadata.authors.map((author) =>
        normalizeIdentityText(author.display_name),
      ),
    ),
    metadata.publication_year,
    metadata.document_type,
  ]);
}

export function fallbackIdentitySha256(
  key: FallbackIdentityKey,
): Promise<string> {
  if (
    !Array.isArray(key) ||
    key.length !== 4 ||
    typeof key[0] !== "string" ||
    !Array.isArray(key[1]) ||
    key[1].some((author) => typeof author !== "string") ||
    !Number.isSafeInteger(key[2]) ||
    typeof key[3] !== "string"
  )
    throw new TypeError("fallback identity key is invalid");
  return sha256(
    canonicalJsonBytes({
      schema: FALLBACK_IDENTITY_HASH_TAG,
      value: key,
    }),
  );
}

function sameFallbackKey(
  left: FallbackIdentityKey | null,
  right: FallbackIdentityKey | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left[0] === right[0] &&
    left[2] === right[2] &&
    left[3] === right[3] &&
    left[1].length === right[1].length &&
    left[1].every((author, index) => author === right[1][index])
  );
}

export function resolveLiteratureIdentity(
  value: LiteratureMetadata,
  candidates: readonly Literature[],
): LiteratureIdentityResolution {
  const incoming = parseLiteratureMetadata(value);
  if (!Array.isArray(candidates))
    throw new TypeError("identity candidates must be an array");
  const existing = candidates.map(parseLiterature);
  const incomingStable = stableIdentifierKeys(incoming);
  const incomingByNamespace = byNamespace(incomingStable);
  if ([...incomingByNamespace.values()].some((values) => values.size > 1))
    return {
      decision: "identity-conflict",
      literature: null,
      reason: "incoming-stable-identifier-conflict",
    };
  const incomingSet = new Set(
    incomingStable.map(([namespace, item]) => `${namespace}\u0000${item}`),
  );
  const matched = existing.filter((literature) =>
    stableIdentifierKeys(literature.metadata).some(([namespace, item]) =>
      incomingSet.has(`${namespace}\u0000${item}`),
    ),
  );
  if (matched.length > 1)
    return {
      decision: "identity-conflict",
      literature: null,
      reason: "stable-identifier-ambiguity",
    };
  if (matched.length === 1) {
    const literature = matched[0]!;
    const existingByNamespace = byNamespace(
      stableIdentifierKeys(literature.metadata),
    );
    for (const [namespace, values] of incomingByNamespace) {
      const actual = existingByNamespace.get(namespace);
      if (actual && [...actual].some((item) => !values.has(item)))
        return {
          decision: "identity-conflict",
          literature: null,
          reason: "stable-identifier-conflict",
        };
    }
    return {
      decision: "matched",
      literature,
      reason: "stable-identifier",
    };
  }
  if (incomingStable.length)
    return {
      decision: "created",
      literature: null,
      reason: "no-stable-identifier-match",
    };
  const fallback = fallbackIdentityKey(incoming);
  if (!fallback)
    return {
      decision: "created",
      literature: null,
      reason: "incomplete-fallback-key",
    };
  const fallbackMatches = existing.filter(
    (literature) =>
      stableIdentifierKeys(literature.metadata).length === 0 &&
      sameFallbackKey(fallbackIdentityKey(literature.metadata), fallback),
  );
  if (fallbackMatches.length > 1)
    return {
      decision: "identity-conflict",
      literature: null,
      reason: "fallback-ambiguity",
    };
  if (fallbackMatches.length === 1)
    return {
      decision: "matched",
      literature: fallbackMatches[0]!,
      reason: "fallback",
    };
  return {
    decision: "created",
    literature: null,
    reason: "no-fallback-match",
  };
}

export function resolveMetaLiterature(
  currentValue: Literature,
  observationValue: MetadataObservation,
  candidates: readonly VersionEvidence[],
): MetaLiteratureResolution {
  const current = parseLiterature(currentValue);
  const observation = parseMetadataObservation(observationValue);
  if (!Array.isArray(candidates))
    throw new TypeError("version evidence must be an array");
  if (
    observation.provenance.source_kind !== "metadata-provider" ||
    observation.version_links.length === 0
  )
    return {
      decision: "independent",
      meta_literature_id: null,
      linked_literature_ids: [],
    };
  const matched = new Map<string, Literature>();
  for (const candidate of candidates) {
    const literature = parseLiterature(candidate.literature);
    const observations: readonly MetadataObservation[] =
      candidate.observations.map((item: MetadataObservation) =>
        parseMetadataObservation(item),
      );
    if (
      observation.version_links.some((key) =>
        observations.some((target) =>
          providerKeyMatchesSeed(observation.provenance.source_name, key, [
            target,
          ]),
        ),
      )
    )
      matched.set(literature.literature_id, literature);
  }
  if (matched.size > 1)
    return {
      decision: "identity-conflict",
      meta_literature_id: null,
      linked_literature_ids: [],
    };
  const target = [...matched.values()][0];
  if (!target)
    return {
      decision: "independent",
      meta_literature_id: null,
      linked_literature_ids: [],
    };
  return {
    decision: "linked",
    meta_literature_id: current.meta_literature_id,
    linked_literature_ids:
      target.literature_id === current.literature_id
        ? [current.literature_id]
        : [current.literature_id, target.literature_id],
  };
}
