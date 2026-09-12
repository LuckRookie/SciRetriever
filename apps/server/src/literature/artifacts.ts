import {
  parseAsset,
  parseArtifactRef,
  type Asset,
  type ArtifactRef,
} from "@sciretriever/contracts";

export interface ArtifactReadOptions {
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}
export interface ArtifactRepository {
  locateArtifact(value: Asset | ArtifactRef): Promise<{
    readonly reference: string;
    readonly artifact: ArtifactRef;
  } | null>;
}
export interface VerifiedArtifactStore {
  withVerified<T>(
    reference: string,
    artifact: ArtifactRef,
    consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
    options?: ArtifactReadOptions,
  ): Promise<T>;
}
export class LiteratureArtifactError extends Error {
  readonly code = "literature-artifact";
  constructor() {
    super("literature artifact read failed");
  }
}
export class LiteratureArtifactService {
  constructor(
    private readonly repository: ArtifactRepository,
    private readonly files: VerifiedArtifactStore,
  ) {}
  async withArtifact<T>(
    value: unknown,
    consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
    options: ArtifactReadOptions = {},
  ): Promise<T> {
    const descriptor =
      value && typeof value === "object" && "asset_id" in value
        ? parseAsset(value)
        : parseArtifactRef(value);
    if (options.signal?.aborted) throw new LiteratureArtifactError();
    const located = await this.repository.locateArtifact(descriptor);
    if (!located) throw new LiteratureArtifactError();
    return this.files.withVerified(
      located.reference,
      located.artifact,
      consume,
      options,
    );
  }
}
