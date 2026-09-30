export class ExtractionMigrationError extends Error {
  readonly code = "extraction-migration" as const;
  constructor() {
    super("extraction migration refused");
  }
}
