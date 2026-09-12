import type { CatalogWriteAdmission } from "../write-admission.js";
import type {
  RelativeArtifactPath,
  ArtifactRef,
} from "@sciretriever/contracts";
import {
  openVerifiedFile,
  type VerifiedFileScope,
  type ArtifactReadOptions,
} from "./reader.js";
import {
  publishStagedFile,
  readPublishedFile,
  type PublishedFile,
  type PublicationDependencies,
} from "./publication.js";
import {
  createStaging,
  FileStagingError,
  type StagedFile,
  type StagingFile,
  type StagingOptions,
} from "./staging.js";

export class FileStoreError extends Error {
  readonly code = "file-store" as const;
  constructor() {
    super("file store operation failed");
    this.name = "FileStoreError";
  }
}

export class FileStore {
  readonly root: string;
  private closed = false;
  private readonly stages = new Set<StagingFile>();
  private readonly readerStop = new AbortController();
  private readonly opening = new Set<Promise<VerifiedFileScope>>();
  private readonly readers = new Set<VerifiedFileScope>();

  constructor(
    root: string,
    private readonly admission?: CatalogWriteAdmission,
  ) {
    if (typeof root !== "string" || !root.startsWith("/"))
      throw new FileStoreError();
    this.root = root;
  }

  async stage(options: StagingOptions = {}): Promise<StagingFile> {
    if (this.closed) throw new FileStoreError();
    try {
      const value = await createStaging(this.root, options);
      this.stages.add(value);
      return value;
    } catch (error) {
      if (error instanceof FileStagingError) throw error;
      throw new FileStoreError();
    }
  }

  withWrite<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new FileStoreError());
    return this.admission ? this.admission.run(operation, signal) : operation();
  }
  async publish(
    stage: StagingFile,
    target: string,
    dependencies?: PublicationDependencies,
  ): Promise<PublishedFile> {
    if (this.closed || !this.stages.has(stage)) throw new FileStoreError();
    try {
      const result = await this.withWrite(() =>
        publishStagedFile(this.root, stage, target, dependencies),
      );
      this.stages.delete(stage);
      return result;
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new FileStoreError();
    }
  }

  async read(
    reference: RelativeArtifactPath | string,
    maxBytes: number,
  ): Promise<Uint8Array> {
    if (this.closed) throw new FileStoreError();
    return readPublishedFile(this.root, reference, maxBytes);
  }
  async withVerified<T>(
    reference: string,
    expected: ArtifactRef,
    consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
    options: ArtifactReadOptions = {},
  ): Promise<T> {
    if (this.closed) throw new FileStoreError();
    const signal = options.signal
      ? AbortSignal.any([options.signal, this.readerStop.signal])
      : this.readerStop.signal;
    const pending = openVerifiedFile(this.root, reference, expected, {
      ...options,
      signal,
    });
    this.opening.add(pending);
    let scope: VerifiedFileScope;
    try {
      scope = await pending;
    } finally {
      this.opening.delete(pending);
    }
    if (this.closed) {
      await scope.close();
      throw new FileStoreError();
    }
    this.readers.add(scope);
    try {
      return await scope.use(consume);
    } finally {
      this.readers.delete(scope);
    }
  }

  async describe(stage: StagingFile): Promise<StagedFile> {
    if (this.closed || !this.stages.has(stage)) throw new FileStoreError();
    return stage.describe();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.readerStop.abort();
    const opening = await Promise.allSettled([...this.opening]);
    await Promise.allSettled(
      [
        ...this.readers,
        ...opening.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])),
      ].map((scope) => scope.close()),
    );
    const stages = [...this.stages];
    this.stages.clear();
    for (const stage of stages) await stage.discard().catch(() => undefined);
  }
}
