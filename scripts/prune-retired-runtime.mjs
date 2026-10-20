import { lstat, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Only the outputs of explicitly retired source modules are removed. */
export async function pruneRetiredRuntime(repository) {
  const inspect = async (path) => {
    try {
      return await lstat(path);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  };
  const files = [];
  const modules = [
    "acquisition/candidate-cleanup",
    "analysis/service",
    "proofread/align",
    "proofread/compare",
    "proofread/merge",
    "proofread/arbitration",
    "proofread/crop",
    "analysis/ts-rules",
    "analysis/knowledge",
    "analysis/knowledge-port",
    "analysis/synthesis",
    "analysis/synthesis-prepare",
    "entry/content-analysis",
    "entry/no-usable-content",
    "literature/content",
    "literature/cleanup",
    "storage/knowledge",
    "storage/synthesis",
    "storage/sqlite/knowledge-engine",
    "retrieval/knowledge-index",
    "parsing/service",
    "parsing/publication",
    "entry/bibliography",
    "storage/sqlite/schema-v2",
    "storage/sqlite/schema-v3",
    "storage/sqlite/schema-v4",
    "storage/sqlite/schema-v5",
    "storage/sqlite/schema-v6",
    "storage/sqlite/schema-v7",
    "storage/sqlite/schema-v8",
    "storage/sqlite/schema-v9",
    "storage/sqlite/schema-v10",
    "storage/sqlite/schema-v11",
    "storage/sqlite/schema-v12",
    "storage/sqlite/schema-v13",
    "storage/sqlite/schema-v14",
    "storage/sqlite/schema-v15",
    "storage/sqlite/schema-v16",
    "storage/sqlite/schema-v17",
    "storage/sqlite/document-migration",
    "storage/sqlite/retrieval-migration",
    "storage/sqlite/extraction-migration",
    "storage/sqlite/knowledge-migration",
    "storage/sqlite/synthesis-migration",
    "storage/sqlite/knowledge-retrieval-migration",
    "storage/sqlite/article-identity-migration",
    "storage/sqlite/processor-migration",
    "storage/sqlite/raw-parsing-migration",
    "storage/sqlite/proofread-migration",
    "storage/sqlite/proofread-document-migration",
    "storage/sqlite/structure-annotation-migration",
    "storage/sqlite/metadata-migration",
    "storage/sqlite/archive-reference-migration",
    "storage/sqlite/tag-migration",
    "storage/sqlite/archive-migration",
    "storage/sqlite/archive-metadata-migration",
    "storage/sqlite/extraction-migration-error",
    "storage/sqlite/knowledge-migration-error",
    "storage/sqlite/migration-scope",
    "storage/sqlite/archive-schema",
    "storage/execution/migration-gate",
  ].map((module) => `apps/server/dist/${module}`);
  modules.push(
    ...["knowledge", "synthesis", "synthesis-manifest"].map(
      (module) => `packages/contracts/dist/${module}`,
    ),
  );
  for (const module of modules) {
    let missing = false;
    const parts = dirname(module).split("/");
    for (let index = 1; index <= parts.length; index++) {
      const metadata = await inspect(
        resolve(repository, ...parts.slice(0, index)),
      );
      if (!metadata) {
        missing = true;
        break;
      }
      if (!metadata.isDirectory())
        throw new Error("Runtime build output must be a real directory");
    }
    if (missing) continue;
    for (const suffix of [".js", ".js.map", ".d.ts", ".d.ts.map"]) {
      const path = resolve(repository, module + suffix);
      const metadata = await inspect(path);
      if (!metadata) continue;
      if (!metadata.isFile())
        throw new Error("Retired runtime output must be a regular file");
      files.push(path);
    }
  }
  for (const path of files) {
    try {
      await unlink(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await pruneRetiredRuntime(fileURLToPath(new URL("..", import.meta.url)));
}
