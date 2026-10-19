import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Optional isolated review metrics; regression runs do not write reports by default. */
export async function recordReading(name: string, value: unknown) {
  const directory =
    process.env.SCIRETRIEVER_READING_METRICS_OUTPUT ??
    process.env.SCIRETRIEVER_WEB_REVIEW_OUTPUT;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${name}.json`),
    JSON.stringify(value, null, 2),
  );
}
