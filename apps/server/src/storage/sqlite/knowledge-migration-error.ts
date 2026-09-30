export class KnowledgeMigrationError extends Error {
  constructor() {
    super("knowledge catalog migration failed");
  }
}
