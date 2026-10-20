import {
  RAW_PARSE_PROFILES,
  parseAssetId,
  parseLiteratureId,
  parseRawParse,
  parseRawParseProfile,
  sha256,
  type Asset,
  type RawParse,
  type RawParseProfile,
  type RawParseSourceProfile,
} from "@sciretriever/contracts";
import {
  ParsingFailure,
  type RawParserBackend,
  type ParsingSource,
  type ParsingCommit,
  type ParserRequest,
  type StagedRawParseOutput,
} from "./ports.js";

export interface RawParsingSource extends ParsingSource {
  asset(assetId: string): Promise<Asset | null>;
}
export interface RawParseStatus {
  readonly profile: RawParseSourceProfile;
  readonly result: RawParse | null;
  readonly last_failure_code: string | null;
  readonly last_parameters_sha256: string | null;
}
export interface RawParseAttempt {
  readonly asset_id: string;
  readonly profile: RawParseProfile;
  readonly status: "published" | "reused" | "failed";
  readonly page_count: number | null;
  readonly elapsed_ms: number;
  readonly raw_parse_id: string | null;
  readonly failure_code: string | null;
}
export interface RawParseRepository {
  recordAttempt?(value: RawParseAttempt): Promise<unknown>;
  current(
    assetId: string,
    signal?: AbortSignal,
  ): Promise<readonly RawParseStatus[]>;
  load(id: string, signal?: AbortSignal): Promise<StagedRawParseOutput>;
  publish(
    output: StagedRawParseOutput,
    signal?: AbortSignal,
  ): Promise<{ readonly result: RawParse; readonly published: boolean }>;
  failure(
    source: Pick<
      RawParse,
      "source_asset_id" | "source_sha256" | "profile" | "parameters_sha256"
    >,
    code: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
export interface RawProfileOutcome {
  readonly profile: RawParseProfile;
  readonly status: "published" | "reused" | "failed";
  readonly result: RawParse | null;
  readonly failure_code: ParsingFailure["code"] | null;
  readonly failure_source_type: string | null;
}
function check(signal: AbortSignal): void {
  if (signal.aborted) throw new ParsingFailure("parser-cancelled");
}

/** Explicit parsing only. Acquiring assets and archiving cannot invoke this service. */
export class RawParsingService {
  private readonly stop = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private readonly locks = new Map<string, Promise<void>>();
  constructor(
    private readonly source: RawParsingSource,
    private readonly parser: RawParserBackend,
    private readonly repository: RawParseRepository,
    readonly archiveProfile: RawParseProfile = "vlm-engine",
  ) {}
  async close(): Promise<void> {
    this.stop.abort();
    await Promise.allSettled([...this.active]);
  }
  private async recordAttempt(attempt: RawParseAttempt): Promise<void> {
    try {
      await this.repository.recordAttempt?.(attempt);
    } catch {
      // Receipt persistence is part of publication, even when the raw bytes committed.
      throw new ParsingFailure("parser-publication");
    }
  }
  async parseCurrentPrimary(
    literatureId: string,
    profiles: readonly RawParseProfile[] = [this.archiveProfile],
    signal?: AbortSignal,
  ) {
    const id = parseLiteratureId(literatureId);
    const asset = (await this.source.currentFacts(id))?.primary_asset;
    if (!asset) throw new ParsingFailure("parser-stale");
    return this.parseAsset(asset.asset_id, profiles, signal, {
      expected_sha256: asset.sha256,
    });
  }
  parseAsset(
    assetId: string,
    profiles: readonly RawParseProfile[] = [this.archiveProfile],
    signal?: AbortSignal,
    options: {
      readonly commit?: ParsingCommit;
      readonly force?: boolean;
      readonly expected_sha256?: string;
    } = {},
  ): Promise<readonly RawProfileOutcome[]> {
    const active = signal
      ? AbortSignal.any([signal, this.stop.signal])
      : this.stop.signal;
    check(active);
    const id = parseAssetId(assetId);
    if (
      !Array.isArray(profiles) ||
      profiles.length < 1 ||
      profiles.length > RAW_PARSE_PROFILES.length
    )
      throw new ParsingFailure("parser-structure");
    const selected = profiles.map(parseRawParseProfile);
    if (new Set(selected).size !== selected.length)
      throw new ParsingFailure("parser-structure");
    const operation = this.perform(id, selected, active, { ...options });
    this.active.add(operation);
    void operation.then(
      () => this.active.delete(operation),
      () => this.active.delete(operation),
    );
    return operation;
  }
  private async locked<T>(
    key: string,
    signal: AbortSignal,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => held);
    this.locks.set(key, queued);
    try {
      await previous;
      check(signal);
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
  private async perform(
    assetId: string,
    profiles: readonly RawParseProfile[],
    signal: AbortSignal,
    options: {
      readonly force?: boolean;
      readonly expected_sha256?: string;
      readonly commit?: ParsingCommit;
    },
  ): Promise<readonly RawProfileOutcome[]> {
    const publish = async (output: StagedRawParseOutput) => {
      try {
        return await (options.commit ?? ((action) => action()))(() => {
          check(signal);
          return this.repository.publish(output, signal);
        });
      } catch (error) {
        const cancelled =
          (error instanceof ParsingFailure &&
            error.code === "parser-cancelled") ||
          (error instanceof Error && error.name === "AbortError") ||
          (error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "write-admission-cancelled");
        throw new ParsingFailure(
          cancelled ? "parser-cancelled" : "parser-publication",
        );
      }
    };
    const asset = await this.source.asset(assetId);
    check(signal);
    if (
      !asset ||
      asset.media_type !== "application/pdf" ||
      (options.expected_sha256 !== undefined &&
        asset.sha256 !== options.expected_sha256)
    )
      throw new ParsingFailure("parser-stale");
    let input: Promise<{ bytes: Uint8Array; page_count: number }> | undefined;
    const read = () => (input ??= this.readPdf(asset, signal));
    // The backend owns network scheduling; each profile commits independently.
    const settled = await Promise.allSettled(
      profiles.map((profile) =>
        this.locked(
          `${assetId}:${profile}`,
          signal,
          async (): Promise<RawProfileOutcome> => {
            const identity = await this.parser.identity(profile);
            const binding = {
              source_asset_id: asset.asset_id,
              source_sha256: asset.sha256,
              profile,
              parameters_sha256: identity.parameters_sha256,
            };
            const started = performance.now();
            let outcome: RawParseAttempt["status"] = "failed",
              failureCode: string | null = null;
            let result: RawParse | null = null;
            try {
              check(signal);
              const current = (
                await this.repository.current(assetId, signal)
              ).find((s) => s.profile === profile)?.result;
              const reusable =
                !options.force &&
                current?.source_sha256 === asset.sha256 &&
                current.parser_version === identity.parser_version &&
                current.model_identity === identity.model_identity &&
                current.parameters_sha256 === identity.parameters_sha256;
              let staged: StagedRawParseOutput;
              if (reusable) {
                result = await parseRawParse(current);
                staged = await this.load(result, signal);
              } else {
                const pdf = await read();
                let readable = true;
                try {
                  const request: ParserRequest = {
                    source_asset_id: asset.asset_id,
                    source_sha256: asset.sha256,
                    media_type: "application/pdf",
                    withContent: async (consume, consumerSignal) => {
                      const verify = () => {
                        check(signal);
                        if (!readable || consumerSignal?.aborted)
                          throw new ParsingFailure("parser-cancelled");
                      };
                      verify();
                      const chunks = (async function* () {
                        for (
                          let i = 0;
                          i < pdf.bytes.length;
                          i += 1024 * 1024
                        ) {
                          verify();
                          yield Uint8Array.from(
                            pdf.bytes.subarray(i, i + 1024 * 1024),
                          );
                        }
                      })();
                      const value = await consume(chunks);
                      verify();
                      return value;
                    },
                  };
                  staged = structuredClone(
                    await this.parser.parseRaw(request, profile, signal),
                  );
                } finally {
                  readable = false;
                }
                check(signal);
                const parsed = await parseRawParse(staged.result);
                if (
                  parsed.source_asset_id !== asset.asset_id ||
                  parsed.source_sha256 !== asset.sha256 ||
                  parsed.page_count !== pdf.page_count ||
                  parsed.profile !== profile ||
                  parsed.parameters_sha256 !== identity.parameters_sha256 ||
                  parsed.parser_version !== identity.parser_version ||
                  parsed.model_identity !== identity.model_identity
                )
                  throw new ParsingFailure("parser-structure");
                const now = await this.source.asset(assetId);
                if (!now || now.sha256 !== asset.sha256)
                  throw new ParsingFailure("parser-stale");
                result = (await publish(staged)).result;
              }
              check(signal);
              // Re-publication is idempotent and clears a previous publication failure.
              if (reusable) await publish(staged);
              outcome = reusable ? "reused" : "published";
              return {
                profile,
                status: outcome,
                result,
                failure_code: null,
                failure_source_type: null,
              };
            } catch (error) {
              const code =
                error instanceof ParsingFailure &&
                error.code === "parser-publication"
                  ? error.code
                  : signal.aborted
                    ? "parser-cancelled"
                    : error instanceof ParsingFailure
                      ? error.code
                      : "parser-unavailable";
              failureCode = code;
              // A cancelled request cannot prevent a completed sibling from remaining durable.
              try {
                await this.repository.failure(binding, code);
              } catch {
                throw new ParsingFailure("parser-publication");
              }
              return {
                profile,
                status: "failed",
                result,
                failure_code: code,
                failure_source_type:
                  error instanceof ParsingFailure &&
                  error.source_type &&
                  /^[a-z][a-z0-9_-]{0,63}$/u.test(error.source_type)
                    ? error.source_type
                    : null,
              };
            } finally {
              await this.recordAttempt({
                asset_id: assetId,
                profile,
                status: outcome,
                page_count: result?.page_count ?? null,
                elapsed_ms: Math.round(performance.now() - started),
                raw_parse_id: result?.raw_parse_id ?? null,
                failure_code: failureCode,
              });
            }
          },
        ),
      ),
    );
    // A storage failure must survive a concurrent cancellation, including a
    // failed failure-receipt write or a sibling waiting for the profile lock.
    const publicationFailure = settled.find((r) =>
      r.status === "rejected"
        ? r.reason instanceof ParsingFailure &&
          r.reason.code === "parser-publication"
        : r.value.failure_code === "parser-publication",
    );
    const failed = settled.find((r) => r.status === "rejected");
    if (failed) {
      if (publicationFailure) throw new ParsingFailure("parser-publication");
      if (failed.status === "rejected") throw failed.reason;
    }
    return settled.map((r) => {
      if (r.status === "rejected") throw r.reason;
      return r.value;
    });
  }
  private async readPdf(asset: Asset, signal: AbortSignal) {
    const bytes = await this.source.withArtifact(
      asset,
      async (chunks) => {
        const parts: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of chunks) {
          check(signal);
          size += chunk.length;
          if (size > 256 * 1024 * 1024)
            throw new ParsingFailure("parser-structure");
          parts.push(Uint8Array.from(chunk));
        }
        return Buffer.concat(parts);
      },
      { maxBytes: 256 * 1024 * 1024, signal },
    );
    if (
      bytes.length !== asset.size_bytes ||
      (await sha256(bytes)) !== asset.sha256
    )
      throw new ParsingFailure("parser-stale");
    const { page_count } = await this.source.inspectPdf(bytes, signal);
    if (
      !Number.isSafeInteger(page_count) ||
      page_count < 1 ||
      page_count > 10000
    )
      throw new ParsingFailure("parser-structure");
    return { bytes, page_count };
  }
  private async load(
    result: RawParse,
    signal: AbortSignal,
  ): Promise<StagedRawParseOutput> {
    const staged = await this.repository.load(result.raw_parse_id, signal);
    if (staged.result.result_sha256 !== result.result_sha256)
      throw new ParsingFailure("parser-structure");
    return staged;
  }
}
