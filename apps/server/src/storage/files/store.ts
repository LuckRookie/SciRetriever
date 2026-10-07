import type { CatalogWriteAdmission } from "../write-admission.js";
import type {
  RelativeArtifactPath,
  ArtifactRef,
} from "@sciretriever/contracts";
import {
  openVerifiedFile,
  type VerifiedFileScope,
  type ArtifactReadOptions,
  type ScopedFileReader,
} from "./reader.js";
import {
  PreparedFilePublication,
  settlePreparedPublication,
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
  private readonly preparing = new Set<Promise<PreparedFilePublication>>();
  private readonly prepared = new Set<PreparedFilePublication>();
  private readonly preparedStages = new Map<
    PreparedFilePublication,
    StagingFile
  >();

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
      const prepared = await this.preparePublication(
        stage,
        target,
        dependencies,
      );
      try {
        return await settlePreparedPublication(prepared, () =>
          this.withWrite(() => this.commitPrepared(prepared)),
        );
      } finally {
        await this.releasePrepared(prepared);
      }
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new FileStoreError();
    }
  }

  async preparePublication(
    stage: StagingFile,
    target: string,
    dependencies?: PublicationDependencies,
    options: ArtifactReadOptions = {},
  ): Promise<PreparedFilePublication> {
    if (this.closed || !this.stages.has(stage)) throw new FileStoreError();
    const signal = AbortSignal.any([
      this.readerStop.signal,
      ...(options.signal ? [options.signal] : []),
      ...(stage.signal ? [stage.signal] : []),
    ]);
    const pending = PreparedFilePublication.create(
      this.root,
      stage,
      target,
      dependencies,
      { ...options, signal },
    );
    this.preparing.add(pending);
    try {
      const prepared = await pending;
      if (this.closed) {
        await prepared.close();
        throw new FileStoreError();
      }
      this.prepared.add(prepared);
      this.preparedStages.set(prepared, stage);
      return prepared;
    } finally {
      this.preparing.delete(pending);
    }
  }
  async commitPrepared(
    prepared: PreparedFilePublication,
  ): Promise<PublishedFile> {
    if (this.closed || !this.prepared.has(prepared)) throw new FileStoreError();
    const result = await prepared.commit();
    this.stages.delete(this.preparedStages.get(prepared)!);
    return result;
  }
  async releasePrepared(prepared: PreparedFilePublication): Promise<void> {
    if (!this.prepared.delete(prepared)) return;
    this.preparedStages.delete(prepared);
    await prepared.close();
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
    return this.withVerifiedFile(
      reference,
      expected,
      (file) => consume(file.chunks()),
      options,
    );
  }
  async withVerifiedFile<T>(
    reference: string,
    expected: ArtifactRef,
    consume: (file: ScopedFileReader) => Promise<T>,
    options: ArtifactReadOptions = {},
  ): Promise<T> {
    const scope = await this.openVerifiedScope(reference, expected, options);
    try {
      return await scope.useFile(consume);
    } finally {
      this.readers.delete(scope);
    }
  }
  async openVerifiedScope(
    reference: string,
    expected: ArtifactRef,
    options: ArtifactReadOptions = {},
  ): Promise<VerifiedFileScope> {
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
    const managed: VerifiedFileScope = {
      ...scope,
      close: async () => {
        try {
          await scope.close();
        } finally {
          this.readers.delete(managed);
        }
      },
    };
    this.readers.add(managed);
    return managed;
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
    const preparing = await Promise.allSettled([...this.preparing]);
    await Promise.allSettled(
      [
        ...this.prepared,
        ...preparing.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        ),
      ].map((prepared) => prepared.close()),
    );
    this.prepared.clear();
    this.preparedStages.clear();
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
