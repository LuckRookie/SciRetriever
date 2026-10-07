/** Caller-owned temporary-byte budget; Storage does not choose business limits. */
export interface TemporaryFileLease {
  /** Reserve the complete next size before writing any bytes. */
  reserve(size: number): Promise<void>;
  /** Confirm bytes already written so free-space checks do not count them twice. */
  written(size: number): void;
  /** Release only after deletion/descriptor close or immutable publication. */
  release(): void;
}

export interface TemporaryFileBudget {
  open(
    directory: string,
    kind: "staging" | "publication-preparation",
  ): TemporaryFileLease;
}
