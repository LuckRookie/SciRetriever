import { randomUUID } from "node:crypto";
import {
  canonicalJsonBytes,
  parseLiterature,
  parseMetaLiterature,
  parseMetadataObservation,
  sha256,
  type Literature,
  type MetaLiterature,
  type MetadataObservation,
} from "@sciretriever/contracts";
import type {
  IdentityPublicationCommand,
  IdentityReadContext,
  IdentityReadRequest,
  SqliteWorker,
} from "../storage/sqlite/worker.js";
import type { CatalogWriteAdmission } from "../storage/write-admission.js";
import {
  fallbackIdentityKey,
  fallbackIdentitySha256,
  resolveLiteratureIdentity,
  resolveMetaLiterature,
  stableIdentifierIndex,
  stableIdentifierKeys,
  type VersionEvidence,
} from "./identity-rules.js";
import {
  acceptMetadataObservation,
  sameProviderObservation,
  sameUserObservation,
  userObservationSemanticSha256,
  type MetadataProjectionDecision,
} from "./metadata-rules.js";

export type LiteratureIdentityDecision =
  | {
      readonly disposition: "accepted";
      readonly literature_id: string;
      readonly meta_literature_id: string;
      readonly outcome: "created" | "enriched" | "matched";
      readonly created: boolean;
    }
  | {
      readonly disposition: "rejected" | "uncertain";
      readonly reason: string;
    };

type AcceptedProjection = Exclude<
  MetadataProjectionDecision,
  { readonly outcome: "rejected" }
>;
type IdentityFact = IdentityReadContext["facts"][number];

function rejected(reason: string): LiteratureIdentityDecision {
  return { disposition: "rejected", reason };
}

function observationsFor(
  context: IdentityReadContext,
  literatureId: string,
): readonly MetadataObservation[] {
  return context.observations
    .filter((item) => item.literature_id === literatureId)
    .map((item) => item.observation);
}

function literatureFor(
  context: IdentityReadContext,
  literatureId: string,
): Literature {
  const matches = context.literatures.filter(
    (item) => item.literature_id === literatureId,
  );
  if (matches.length !== 1)
    throw new Error("Literature identity closure is incomplete or ambiguous");
  return matches[0]!;
}

function factFor(
  context: IdentityReadContext,
  literatureId: string,
): IdentityFact {
  const matches = context.facts.filter(
    (item) => item.literature.literature_id === literatureId,
  );
  if (matches.length !== 1)
    throw new Error("Literature facts closure is incomplete or ambiguous");
  return matches[0]!;
}

function metaFor(context: IdentityReadContext, metaId: string): MetaLiterature {
  const matches = context.meta_literatures.filter(
    (item) => item.meta_literature_id === metaId,
  );
  if (matches.length !== 1)
    throw new Error("MetaLiterature closure is incomplete or ambiguous");
  return matches[0]!;
}

function membersFor(
  context: IdentityReadContext,
  metaId: string,
): readonly Literature[] {
  const members = context.literatures.filter(
    (item) => item.meta_literature_id === metaId,
  );
  if (
    !members.length ||
    new Set(members.map((item) => item.literature_id)).size !== members.length
  )
    throw new Error("MetaLiterature membership is incomplete or ambiguous");
  return members;
}

function literatureToken(fact: IdentityFact) {
  return Object.freeze({
    literature_id: fact.literature.literature_id,
    meta_literature_id: fact.literature.meta_literature_id,
    metadata_revision: fact.metadata_revision,
    metadata_sha256: fact.metadata_sha256,
  });
}

function metaToken(context: IdentityReadContext, meta: MetaLiterature) {
  const memberIds = membersFor(context, meta.meta_literature_id)
    .map((item) => item.literature_id)
    .sort();
  if (!memberIds.includes(meta.representative_literature_id))
    throw new Error("MetaLiterature representative is not a member");
  return Object.freeze({
    meta_literature_id: meta.meta_literature_id,
    representative_literature_id: meta.representative_literature_id,
    member_literature_ids: Object.freeze(memberIds),
  });
}

function representative(members: readonly Literature[]): Literature {
  const order = new Map([
    ["published", 0],
    ["accepted-manuscript", 1],
    ["preprint", 2],
    ["other", 3],
  ]);
  if (!members.length) throw new Error("MetaLiterature cannot be empty");
  return [...members].sort((left, right) => {
    const role = order.get(left.version_role)! - order.get(right.version_role)!;
    return role || left.literature_id.localeCompare(right.literature_id);
  })[0]!;
}

function versionTarget(
  context: IdentityReadContext,
  current: Literature,
  observation: MetadataObservation,
): Literature | null {
  const evidence: VersionEvidence[] = context.literatures.map((literature) => ({
    literature,
    observations: observationsFor(context, literature.literature_id),
  }));
  const decision = resolveMetaLiterature(current, observation, evidence);
  if (decision.decision !== "linked") return null;
  const targetId = decision.linked_literature_ids.find(
    (item) => item !== current.literature_id,
  );
  return targetId === undefined ? null : literatureFor(context, targetId);
}

async function fallbackDigest(literature: Literature): Promise<string | null> {
  if (stableIdentifierKeys(literature.metadata).length) return null;
  const key = fallbackIdentityKey(literature.metadata);
  return key ? fallbackIdentitySha256(key) : null;
}

async function changedLiterature(
  literature: Literature,
  metadataRevision: number,
  metadataSha256?: string,
): Promise<IdentityPublicationCommand["literatures"][number]> {
  return Object.freeze({
    literature,
    metadata_revision: metadataRevision,
    metadata_sha256:
      metadataSha256 ?? (await sha256(canonicalJsonBytes(literature.metadata))),
    fallback_identity_sha256: await fallbackDigest(literature),
  });
}

function observationReplay(
  existing: MetadataObservation,
  incoming: MetadataObservation,
): boolean {
  return incoming.provenance.source_kind === "user"
    ? sameUserObservation(existing, incoming)
    : incoming.provenance.source_kind === "metadata-provider"
      ? sameProviderObservation(existing, incoming)
      : false;
}

function ownerForLink(
  context: IdentityReadContext,
  literatureId: string,
): Literature {
  return literatureFor(context, literatureId);
}

function observationOwner(
  context: IdentityReadContext,
  observation: MetadataObservation,
): Literature | null {
  const sameId = context.observations.filter(
    (item) => item.observation.observation_id === observation.observation_id,
  );
  let exact: Literature | null = null;
  if (sameId.length) {
    if (
      sameId.length !== 1 ||
      !observationReplay(sameId[0]!.observation, observation)
    )
      throw new Error(
        "observation ID is already bound to different source data",
      );
    exact = ownerForLink(context, sameId[0]!.literature_id);
  }
  if (
    exact &&
    (observation.provenance.source_kind !== "metadata-provider" ||
      observation.provenance.source_record_id === null)
  )
    return exact;
  if (observation.provenance.source_kind === "user") {
    const matches = context.observations.filter(
      (item) =>
        item.observation.provenance.source_kind === "user" &&
        sameUserObservation(item.observation, observation),
    );
    if (matches.length > 1)
      throw new Error("user observation has multiple owners");
    return matches.length
      ? ownerForLink(context, matches[0]!.literature_id)
      : null;
  }
  if (
    observation.provenance.source_kind !== "metadata-provider" ||
    observation.provenance.source_record_id === null
  )
    return null;
  const providerMatches = context.observations.filter(
    (item) =>
      item.observation.provenance.source_kind === "metadata-provider" &&
      item.observation.provenance.source_name ===
        observation.provenance.source_name &&
      item.observation.provenance.source_record_id ===
        observation.provenance.source_record_id,
  );
  const owners = new Map(
    providerMatches.map((item) => [
      item.literature_id,
      ownerForLink(context, item.literature_id),
    ]),
  );
  if (owners.size > 1) throw new Error("provider record has multiple owners");
  const provider = [...owners.values()][0] ?? null;
  if (exact && !provider)
    throw new Error("observation owner is missing or ambiguous");
  if (exact && provider && exact.literature_id !== provider.literature_id)
    throw new Error("observation-owner-identity-conflict");
  return provider;
}

async function identityReadRequest(
  observation: MetadataObservation,
): Promise<IdentityReadRequest> {
  const stable = stableIdentifierIndex(observation.metadata);
  const fallback = stable.length
    ? null
    : fallbackIdentityKey(observation.metadata);
  return Object.freeze({
    observation_id: observation.observation_id,
    provider_record_key:
      observation.provenance.source_kind === "metadata-provider" &&
      observation.provenance.source_record_id !== null
        ? Object.freeze({
            source_name: observation.provenance.source_name,
            source_record_id: observation.provenance.source_record_id,
          })
        : null,
    stable_identifier_keys: stable,
    fallback_identity_sha256: fallback
      ? await fallbackIdentitySha256(fallback)
      : null,
    user_observation_semantic_sha256:
      observation.provenance.source_kind === "user"
        ? await userObservationSemanticSha256(observation)
        : null,
    version_link_keys:
      observation.provenance.source_kind === "metadata-provider"
        ? observation.version_links.map((link) =>
            Object.freeze({
              source_name: observation.provenance.source_name,
              record_id: link.record_id,
              stable_identifier_keys: stableIdentifierIndex({
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
                identifiers: link.identifiers,
                keywords: [],
              }),
            }),
          )
        : [],
  });
}

export class LiteratureIdentityService {
  constructor(
    private readonly database: SqliteWorker,
    private readonly writes: CatalogWriteAdmission,
    private readonly providerPrecedence: readonly string[] = [],
  ) {}

  observe(value: unknown): Promise<LiteratureIdentityDecision> {
    const observation = parseMetadataObservation(value);
    return this.writes.run(() => this.observeAdmitted(observation));
  }

  private async observeAdmitted(
    observation: MetadataObservation,
  ): Promise<LiteratureIdentityDecision> {
    const context = await this.database.readIdentity(
      await identityReadRequest(observation),
    );
    let owner: Literature | null;
    try {
      owner = observationOwner(context, observation);
    } catch (error) {
      return rejected(
        error instanceof Error ? error.message : "identity-rejected",
      );
    }
    const identity = resolveLiteratureIdentity(
      observation.metadata,
      context.literatures,
    );
    if (identity.decision === "identity-conflict")
      return rejected(identity.reason);
    if (
      owner &&
      identity.decision === "matched" &&
      identity.literature.literature_id !== owner.literature_id
    )
      return rejected("observation-owner-identity-conflict");
    const current =
      owner ?? (identity.decision === "matched" ? identity.literature : null);
    const currentFact = current
      ? factFor(context, current.literature_id)
      : null;
    const acceptance = acceptMetadataObservation(observation, {
      existing_literature: context.literatures,
      existing_observations: current
        ? observationsFor(context, current.literature_id)
        : [],
      provider_precedence: this.providerPrecedence,
      current_metadata: current?.metadata ?? null,
      metadata_revision: currentFact?.metadata_revision ?? 1,
      content_ready: currentFact?.content_ready ?? false,
    });
    if (acceptance.outcome === "rejected") return rejected(acceptance.reason);
    const publication = current
      ? await this.existingPublication(
          context,
          current,
          currentFact!,
          acceptance.observation,
          acceptance.projection,
          acceptance.deduplicated,
        )
      : await this.newPublication(
          context,
          acceptance.observation,
          acceptance.projection,
        );
    if (!acceptance.deduplicated)
      await this.database.publishIdentityObservation(publication);
    const outcome =
      current === null
        ? "created"
        : acceptance.projection.observations_projection_changed &&
            !acceptance.deduplicated
          ? "enriched"
          : "matched";
    return {
      disposition: "accepted",
      literature_id: publication.result.literature_id,
      meta_literature_id: publication.result.meta_literature_id,
      outcome,
      created: current === null,
    };
  }

  private async newPublication(
    context: IdentityReadContext,
    observation: MetadataObservation,
    projection: AcceptedProjection,
  ): Promise<IdentityPublicationCommand & { readonly result: Literature }> {
    const provisional = parseLiterature({
      literature_id: randomUUID(),
      meta_literature_id: randomUUID(),
      version_role: observation.version_role ?? "other",
      status: "UNREVIEWED",
      metadata: projection.metadata,
    });
    const target = versionTarget(context, provisional, observation);
    const literature = target
      ? parseLiterature({
          ...provisional,
          meta_literature_id: target.meta_literature_id,
        })
      : provisional;
    const meta = target
      ? parseMetaLiterature({
          meta_literature_id: target.meta_literature_id,
          representative_literature_id: representative([
            ...membersFor(context, target.meta_literature_id),
            literature,
          ]).literature_id,
        })
      : parseMetaLiterature({
          meta_literature_id: literature.meta_literature_id,
          representative_literature_id: literature.literature_id,
        });
    return Object.assign(
      {
        literatures: [await changedLiterature(literature, 1)],
        meta_literatures: [meta],
        observation: {
          literature_id: literature.literature_id,
          observation,
          user_semantic_sha256:
            observation.provenance.source_kind === "user"
              ? await userObservationSemanticSha256(observation)
              : null,
        },
        expected_literatures: [],
        expected_meta_literatures: target
          ? [metaToken(context, metaFor(context, target.meta_literature_id))]
          : [],
        retired_meta_literature_ids: [],
        clear_automatic_pdf_exhaustion_for: [literature.literature_id],
      },
      { result: literature },
    );
  }

  private async existingPublication(
    context: IdentityReadContext,
    current: Literature,
    currentFact: IdentityFact,
    observation: MetadataObservation,
    projection: AcceptedProjection,
    deduplicated: boolean,
  ): Promise<IdentityPublicationCommand & { readonly result: Literature }> {
    const updated = parseLiterature({
      ...current,
      metadata: projection.metadata,
    });
    const target = versionTarget(context, current, observation);
    if (!target || target.meta_literature_id === current.meta_literature_id) {
      const changed = projection.changed
        ? [await changedLiterature(updated, projection.metadata_revision)]
        : [];
      return Object.assign(
        {
          literatures: changed,
          meta_literatures: [],
          observation: deduplicated
            ? null
            : {
                literature_id: current.literature_id,
                observation,
                user_semantic_sha256:
                  observation.provenance.source_kind === "user"
                    ? await userObservationSemanticSha256(observation)
                    : null,
              },
          expected_literatures: [literatureToken(currentFact)],
          expected_meta_literatures: [],
          retired_meta_literature_ids: [],
          clear_automatic_pdf_exhaustion_for: deduplicated
            ? []
            : [current.literature_id],
        },
        { result: updated },
      );
    }
    const currentMeta = metaFor(context, current.meta_literature_id);
    const targetMeta = metaFor(context, target.meta_literature_id);
    const allMembers = [
      ...membersFor(context, currentMeta.meta_literature_id),
      ...membersFor(context, targetMeta.meta_literature_id),
    ];
    if (
      new Set(allMembers.map((item) => item.literature_id)).size !==
      allMembers.length
    )
      throw new Error("MetaLiterature members are duplicated");
    const replacements = allMembers.map((item) =>
      parseLiterature({
        ...item,
        meta_literature_id: targetMeta.meta_literature_id,
        metadata:
          item.literature_id === current.literature_id
            ? projection.metadata
            : item.metadata,
      }),
    );
    const changed = replacements.filter((replacement, index) => {
      const previous = allMembers[index]!;
      return (
        replacement.meta_literature_id !== previous.meta_literature_id ||
        (replacement.literature_id === current.literature_id &&
          projection.changed)
      );
    });
    const changedItems = await Promise.all(
      changed.map((item) => {
        const fact = factFor(context, item.literature_id);
        return changedLiterature(
          item,
          item.literature_id === current.literature_id
            ? projection.metadata_revision
            : fact.metadata_revision,
          item.literature_id === current.literature_id
            ? undefined
            : fact.metadata_sha256,
        );
      }),
    );
    const survivor = parseMetaLiterature({
      meta_literature_id: targetMeta.meta_literature_id,
      representative_literature_id: representative(replacements).literature_id,
    });
    const result = replacements.find(
      (item) => item.literature_id === current.literature_id,
    )!;
    return Object.assign(
      {
        literatures: changedItems,
        meta_literatures: [survivor],
        observation: deduplicated
          ? null
          : {
              literature_id: current.literature_id,
              observation,
              user_semantic_sha256:
                observation.provenance.source_kind === "user"
                  ? await userObservationSemanticSha256(observation)
                  : null,
            },
        expected_literatures: changed.map((item) =>
          literatureToken(factFor(context, item.literature_id)),
        ),
        expected_meta_literatures: [
          metaToken(context, currentMeta),
          metaToken(context, targetMeta),
        ].sort((left, right) =>
          left.meta_literature_id.localeCompare(right.meta_literature_id),
        ),
        retired_meta_literature_ids: [currentMeta.meta_literature_id],
        clear_automatic_pdf_exhaustion_for: deduplicated
          ? []
          : [current.literature_id],
      },
      { result },
    );
  }
}
