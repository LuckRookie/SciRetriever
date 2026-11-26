import { createHash } from "node:crypto";
import {
  EMPTY_METADATA,
  parseLiteratureId,
  type Identifier,
  type IntakeRecognition,
  type LiteratureMetadata,
  type MetadataObservation,
} from "@sciretriever/contracts";
import type { MetadataRegistry } from "../metadata/registry.js";
import type { FileClues } from "./file-clues.js";
import { normalizeRecognitionTitle as normalized } from "./import-clues.js";

export interface RecognitionClues {
  readonly identifiers: readonly Identifier[];
  readonly titles: readonly string[];
  readonly text: string;
  readonly corroboration: string;
  readonly fallback: string;
}
export interface RecognitionSources {
  lookup(
    ids: readonly Identifier[],
    signal: AbortSignal,
  ): Promise<readonly MetadataObservation[]>;
  search(
    title: string,
    signal: AbortSignal,
  ): Promise<readonly MetadataObservation[]>;
  /** Which kinds of source are configured; absent means both may answer. */
  configured?(): { readonly lookup: boolean; readonly search: boolean };
}
/** A paper of this library that carries the identifier, or null (6.4.6 step 2). */
export type RecognitionLibrary = (identifier: Identifier) => Promise<{
  readonly literature_id: string;
  readonly metadata: LiteratureMetadata;
} | null>;
export interface RecognizedCandidate {
  readonly candidate_id: string;
  readonly observation: MetadataObservation;
  readonly similarity: number;
}
export interface RecognitionResult {
  readonly recognition: IntakeRecognition;
  readonly metadata: LiteratureMetadata;
  readonly observation: MetadataObservation | null;
  readonly candidates: readonly RecognizedCandidate[];
}
export function fileRecognitionClues(clues: FileClues): RecognitionClues {
  const titles = [
    clues.xmp.title,
    clues.info.title,
    ...clues.prominent_titles,
  ].filter((v): v is string => !!v);
  return {
    identifiers: clues.identifiers,
    titles,
    text: clues.pages.map((p) => p.text).join(" "),
    corroboration: [
      ...clues.pages.map((p) => p.text),
      ...Object.values(clues.info),
    ].join(" "),
    fallback: titles[0] ?? clues.file_name,
  };
}
/** Unicode-codepoint Levenshtein; memory is bounded by the shorter title. */
export function recognitionSimilarity(left: string, right: string): number {
  let a = [...normalized(left)],
    b = [...normalized(right)];
  if (!a.length && !b.length) return 0;
  if (a.length > b.length) [a, b] = [b, a];
  let row = a.map((_, i) => i + 1);
  row.unshift(0);
  for (let j = 1; j <= b.length; j++) {
    const next = [j];
    for (let i = 1; i <= a.length; i++)
      next[i] = Math.min(
        next[i - 1]! + 1,
        row[i]! + 1,
        row[i - 1]! + Number(a[i - 1] !== b[j - 1]),
      );
    row = next;
  }
  return 1 - row[a.length]! / Math.max(a.length, b.length);
}
function sameTitle(a: string, b: string) {
  return (
    (!!normalized(a) && normalized(a) === normalized(b)) ||
    recognitionSimilarity(a, b) >= 0.95
  );
}
/** 6.4.6 step 2: the title can be found in the file's clues. */
function titleInClues(title: string | null, clues: RecognitionClues): boolean {
  return (
    !!title &&
    !!normalized(title) &&
    (normalized(clues.text).includes(normalized(title)) ||
      clues.titles.some((t) => sameTitle(t, title)))
  );
}
function identity(metadata: LiteratureMetadata) {
  const id =
    metadata.identifiers.find((i) => i.namespace === "doi") ??
    metadata.identifiers.find((i) => i.namespace === "arxiv");
  return id
    ? `${id.namespace}:${id.value}`
    : JSON.stringify(
        [...metadata.identifiers]
          .map((i) => `${i.namespace}:${i.value}`)
          .sort(),
      );
}
function candidateId(observation: MetadataObservation) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        observation.provenance.source_name,
        observation.metadata,
      ]),
    )
    .digest("hex");
}
/** At most three, by similarity, then Crossref first, then candidate ID. */
function withCandidates(
  fallback: RecognitionResult,
  candidates: RecognizedCandidate[],
): RecognitionResult {
  const ordered = candidates
    .sort(
      (a, b) =>
        b.similarity - a.similarity ||
        Number(b.observation.provenance.source_name === "crossref") -
          Number(a.observation.provenance.source_name === "crossref") ||
        a.candidate_id.localeCompare(b.candidate_id),
    )
    .slice(0, 3);
  return !ordered.length
    ? fallback
    : {
        ...fallback,
        candidates: ordered,
        recognition: {
          ...fallback.recognition,
          state: "candidates",
          step: 3,
          candidates: ordered.map((c) => ({
            candidate_id: c.candidate_id,
            title: c.observation.metadata.title,
            authors: c.observation.metadata.authors,
            publication_year: c.observation.metadata.publication_year,
            identifiers: c.observation.metadata.identifiers,
            source_name: c.observation.provenance.source_name,
            similarity: c.similarity,
          })),
        },
      };
}
export class IntakeRecognitionService {
  constructor(private readonly sources: RecognitionSources) {}
  /** False when no bibliographic source at all is configured. */
  sourcesConfigured(): boolean {
    const configured = this.sources.configured?.();
    return !configured || configured.lookup || configured.search;
  }
  /** Step 4 because there was nobody to ask: said, not left blank. */
  private noSource(result: RecognitionResult): RecognitionResult {
    return {
      ...result,
      recognition: { ...result.recognition, reason: "no-metadata-source" },
    };
  }
  fallback(
    clues: RecognitionClues,
    state: "unrecognized" | "cancelled" = "unrecognized",
  ): RecognitionResult {
    return this.unrecognized(
      { ...EMPTY_METADATA, title: clues.fallback || "document" },
      state,
    );
  }
  /** Step 4 with the given bibliography (the clue title or the named line). */
  unrecognized(
    metadata: LiteratureMetadata,
    state: "unrecognized" | "cancelled" = "unrecognized",
  ): RecognitionResult {
    return {
      recognition: { state, step: 4, literature_id: null, candidates: [] },
      metadata,
      observation: null,
      candidates: [],
    };
  }
  /**
   * A paper the user named by one identifier or one title (literature
   * materials 6.4.12). Same sources and order as recognize(); an identifier is
   * not checked against a title, and a title is adopted only when exactly one
   * work matches it. `fallback` is the bibliography kept when nothing is
   * adopted.
   */
  async recognizeNamed(
    named: { readonly identifier: Identifier } | { readonly title: string },
    fallback: LiteratureMetadata,
    signal: AbortSignal,
  ): Promise<RecognitionResult> {
    const check = () => signal.throwIfAborted();
    check();
    if (!this.sourcesConfigured())
      return this.noSource(this.unrecognized(fallback));
    if ("identifier" in named) {
      const wanted = named.identifier;
      let observations: readonly MetadataObservation[] = [];
      try {
        observations = await this.sources.lookup([wanted], signal);
      } catch {
        check();
      }
      check();
      const found = observations.find(
        (o) =>
          !!o.metadata.title &&
          o.metadata.identifiers.some(
            (i) => i.namespace === wanted.namespace && i.value === wanted.value,
          ),
      );
      return found ? this.accept(found, 2) : this.unrecognized(fallback);
    }
    let found: readonly MetadataObservation[] = [];
    try {
      found = await this.sources.search(named.title, signal);
    } catch {
      check();
    }
    check();
    const candidates: RecognizedCandidate[] = [],
      matching: RecognizedCandidate[] = [];
    for (const observation of found) {
      const m = observation.metadata;
      if (!m.title) continue;
      const similarity = recognitionSimilarity(named.title, m.title);
      if (similarity < 0.85) continue;
      const candidate = {
        candidate_id: candidateId(observation),
        observation,
        similarity,
      };
      if (candidates.some((c) => c.candidate_id === candidate.candidate_id))
        continue;
      candidates.push(candidate);
      if (sameTitle(named.title, m.title) && m.identifiers.length)
        matching.push(candidate);
    }
    if (
      matching.length &&
      new Set(matching.map((c) => identity(c.observation.metadata))).size === 1
    )
      return this.accept(matching[0]!.observation, 3);
    return withCandidates(this.unrecognized(fallback), candidates);
  }
  async recognize(
    clues: RecognitionClues,
    signal: AbortSignal,
    titleOnly = false,
    /** File intake: a paper already here is checked first, sources or not. */
    library?: RecognitionLibrary,
  ): Promise<RecognitionResult> {
    const check = () => signal.throwIfAborted();
    check();
    if (library && !titleOnly)
      for (const identifier of clues.identifiers) {
        const known = await library(identifier);
        check();
        // A DOI from a cited reference names another paper: its title is
        // not in this file, so it counts as not in the library.
        if (known && titleInClues(known.metadata.title, clues))
          return {
            recognition: {
              state: "recognized",
              step: 2,
              literature_id: parseLiteratureId(known.literature_id),
              candidates: [],
            },
            metadata: known.metadata,
            observation: null,
            candidates: [],
          };
      }
    if (!this.sourcesConfigured()) return this.noSource(this.fallback(clues));
    if (!titleOnly && clues.identifiers.length) {
      let observations: readonly MetadataObservation[] = [];
      try {
        observations = await this.sources.lookup(clues.identifiers, signal);
      } catch {
        check();
      }
      check();
      for (const observation of observations) {
        const title = observation.metadata.title;
        if (
          observation.metadata.identifiers.some((found) =>
            clues.identifiers.some(
              (wanted) =>
                wanted.namespace === found.namespace &&
                wanted.value === found.value,
            ),
          ) &&
          titleInClues(title, clues)
        )
          return this.accept(observation, 2);
      }
    }
    const candidates: RecognizedCandidate[] = [],
      accepted: RecognizedCandidate[] = [];
    for (const title of clues.titles) {
      check();
      let found: readonly MetadataObservation[] = [];
      try {
        found = await this.sources.search(title, signal);
      } catch {
        check();
      }
      for (const observation of found) {
        check();
        const m = observation.metadata;
        if (!m.title) continue;
        const similarity = Math.max(
          ...clues.titles.map((t) => recognitionSimilarity(t, m.title!)),
        );
        if (similarity < 0.85) continue;
        const candidate_id = candidateId(observation);
        const candidate = { candidate_id, observation, similarity };
        if (!candidates.some((c) => c.candidate_id === candidate_id))
          candidates.push(candidate);
        const evidence = normalized(clues.corroboration);
        const author = m.authors.some((a) => {
          const family =
            a.family_name ??
            a.display_name
              .split(/[,\s]+/u)
              .filter(Boolean)
              .at(-1);
          return family && ` ${evidence} `.includes(` ${normalized(family)} `);
        });
        const year =
          m.publication_year !== null &&
          new RegExp(`(?:^|\\D)${m.publication_year}(?:\\D|$)`, "u").test(
            clues.corroboration,
          );
        if (
          similarity >= 0.95 &&
          (author || year) &&
          m.identifiers.length &&
          !accepted.some((c) => c.candidate_id === candidate_id)
        )
          accepted.push(candidate);
      }
    }
    check();
    if (
      accepted.length &&
      new Set(accepted.map((c) => identity(c.observation.metadata))).size === 1
    )
      return this.accept(accepted[0]!.observation, 3);
    return withCandidates(this.fallback(clues), candidates);
  }
  private accept(
    observation: MetadataObservation,
    step: 2 | 3,
  ): RecognitionResult {
    return {
      recognition: {
        state: "recognized",
        step,
        literature_id: null,
        candidates: [],
      },
      metadata: observation.metadata,
      observation,
      candidates: [],
    };
  }
}
/** Reuses configured metadata adapters and Network policy; never creates another HTTP client. */
export function metadataRecognitionSources(
  registry: MetadataRegistry,
): RecognitionSources {
  return {
    async lookup(ids, signal) {
      const observations: MetadataObservation[] = [];
      for (const provider_name of registry.lookup_selection) {
        signal.throwIfAborted();
        const result = await registry.service.lookup(
          {
            provider_name,
            key: { record_id: null, identifiers: ids },
            scan_limit: 1,
          },
          signal,
        );
        observations.push(...result.observations);
      }
      return observations;
    },
    configured() {
      return {
        lookup: registry.lookup_selection.length > 0,
        search: ["crossref", "openalex"].some((p) =>
          registry.topic_selection.includes(p),
        ),
      };
    },
    async search(title, signal) {
      const observations: MetadataObservation[] = [];
      for (const provider of ["crossref", "openalex"].filter((p) =>
        registry.topic_selection.includes(p),
      )) {
        signal.throwIfAborted();
        const result = await registry.service.searchTopicProvider(
          provider,
          { query: title, year_from: null, year_to: null },
          5,
          signal,
        );
        observations.push(...result.observations);
      }
      return observations;
    },
  };
}
