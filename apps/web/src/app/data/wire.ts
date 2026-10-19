/** Narrow JSON adapters shared by the workbench pages.
 *
 * The server is an authenticated HTTP boundary, but it is still a wire boundary:
 * stale builds, proxies and malformed test payloads must not become `undefined` DOM
 * values. These helpers deliberately validate only the fields the page renders and
 * preserve unknown fields for forward-compatible detail cards.
 */
export type JsonRecord = Record<string, unknown>;

export function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`invalid ${label}`);
  return value as JsonRecord;
}

export function stringField(
  value: JsonRecord,
  key: string,
  label = key,
): string {
  if (typeof value[key] !== "string") throw new Error(`invalid ${label}`);
  return value[key] as string;
}

export function optionalString(value: JsonRecord, key: string): string | null {
  const item = value[key];
  if (item === null || item === undefined) return null;
  if (typeof item !== "string") throw new Error(`invalid ${key}`);
  return item;
}

export function listField(value: JsonRecord, key: string): readonly unknown[] {
  if (!Array.isArray(value[key])) throw new Error(`invalid ${key}`);
  return value[key] as readonly unknown[];
}

export function envelopeList(
  value: unknown,
  key: string,
): readonly JsonRecord[] {
  const values = listField(record(value, "response"), key);
  return values.map((item) => record(item, key));
}

export function envelopeRecord(value: unknown, key: string): JsonRecord {
  return record(record(value, "response")[key], key);
}

export function jobRecord(value: unknown): JsonRecord {
  const job = record(value, "job");
  stringField(job, "job_id", "job id");
  stringField(job, "status", "job status");
  return job;
}

export function jobStatus(value: unknown): string {
  const status = stringField(record(value, "job"), "status", "job status");
  if (
    ![
      "queued",
      "running",
      "paused",
      "cancelled",
      "completed",
      "failed",
      "interrupted",
    ].includes(status)
  )
    throw new Error("unknown job status");
  return status;
}

export interface ReferencePageWire {
  readonly items: readonly JsonRecord[];
  readonly total_count: number;
  readonly next_cursor: string | null;
}

export function referencePage(value: unknown): ReferencePageWire {
  const page = record(record(value, "response").page, "reference page");
  const items = listField(page, "items").map((item) =>
    record(item, "reference item"),
  );
  const total = page.total_count;
  const cursor = page.next_cursor;
  if (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 0 ||
    (cursor !== null && typeof cursor !== "string")
  )
    throw new Error("invalid reference page");
  return { items, total_count: total, next_cursor: cursor as string | null };
}
