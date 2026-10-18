import { Worker } from "node:worker_threads";
import {
  EXTRACTION_SCHEMA_URI,
  extractionCanonicalJsonBytes,
  parseExtractionSpec,
  type ExtractionSpec,
} from "@sciretriever/contracts";

export class ExtractionSpecError extends Error {
  constructor(
    readonly code:
      | "invalid-spec"
      | "unsupported-schema"
      | "schema-timeout"
      | "schema-busy"
      | "schema-resource-limit"
      | "schema-cancelled",
  ) {
    super("extraction specification refused");
  }
}
const allowed = new Set([
  "$schema",
  "$defs",
  "$ref",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "enum",
  "const",
  "allOf",
  "anyOf",
  "oneOf",
  "description",
  "title",
]);
const supportedTypes = new Set([
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "integer",
  "string",
]);
function unsupported(): never {
  throw new ExtractionSpecError("unsupported-schema");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    unsupported();
  return value as Record<string, unknown>;
}
function checkSchema(schema: unknown): void {
  const root = object(schema);
  if (
    root.$schema !== EXTRACTION_SCHEMA_URI ||
    (root.type === undefined && root.$ref === undefined)
  )
    unsupported();
  const defs = root.$defs === undefined ? {} : object(root.$defs);
  if (
    Object.keys(defs).length > 128 ||
    Object.keys(defs).some((name) => !/^[A-Za-z0-9_-]{1,64}$/.test(name))
  )
    unsupported();
  let nodes = 0;
  const visit = (
    value: unknown,
    depth: number,
    combinatorDepth: number,
  ): void => {
    if (depth > 8 || combinatorDepth > 3 || ++nodes > 128) unsupported();
    const r = object(value);
    if (
      Object.keys(r).some((key) => !allowed.has(key)) ||
      (depth > 0 && (Object.hasOwn(r, "$schema") || Object.hasOwn(r, "$defs")))
    )
      unsupported();
    if (r.$ref !== undefined) {
      if (
        typeof r.$ref !== "string" ||
        !/^#\/\$defs\/[A-Za-z0-9_-]{1,64}$/.test(r.$ref) ||
        !Object.hasOwn(defs, r.$ref.slice(8))
      )
        unsupported();
    }
    if (r.type !== undefined) {
      const types = Array.isArray(r.type) ? r.type : [r.type];
      if (
        types.length < 1 ||
        types.length > 7 ||
        new Set(types).size !== types.length ||
        types.some((type) => !supportedTypes.has(type as string))
      )
        unsupported();
    }
    if (r.properties !== undefined) {
      const properties = object(r.properties);
      if (Object.keys(properties).length > 128) unsupported();
      for (const child of Object.values(properties))
        visit(child, depth + 1, combinatorDepth);
    }
    if (
      r.required !== undefined &&
      (!Array.isArray(r.required) ||
        r.required.length > 128 ||
        r.required.some((key) => typeof key !== "string") ||
        new Set(r.required).size !== r.required.length)
    )
      unsupported();
    if (
      r.additionalProperties !== undefined &&
      typeof r.additionalProperties !== "boolean"
    )
      visit(r.additionalProperties, depth + 1, combinatorDepth);
    if (r.items !== undefined) visit(r.items, depth + 1, combinatorDepth);
    if (r.prefixItems !== undefined) {
      if (!Array.isArray(r.prefixItems) || r.prefixItems.length > 32)
        unsupported();
      for (const child of r.prefixItems)
        visit(child, depth + 1, combinatorDepth);
    }
    for (const keyword of ["allOf", "anyOf", "oneOf"]) {
      const branches = r[keyword];
      if (branches === undefined) continue;
      if (
        !Array.isArray(branches) ||
        branches.length < 1 ||
        branches.length > 8
      )
        unsupported();
      for (const child of branches)
        visit(child, depth + 1, combinatorDepth + 1);
    }
    for (const key of ["minItems", "maxItems", "minLength", "maxLength"]) {
      const n = r[key];
      if (
        n !== undefined &&
        (!Number.isSafeInteger(n) || (n as number) < 0 || (n as number) > 65536)
      )
        unsupported();
    }
    for (const key of [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
    ]) {
      const n = r[key];
      if (n !== undefined && (typeof n !== "number" || !Number.isFinite(n)))
        unsupported();
    }
    for (const key of ["description", "title"]) {
      const s = r[key];
      if (s !== undefined && (typeof s !== "string" || s.length > 2048))
        unsupported();
    }
    if (r.enum !== undefined && (!Array.isArray(r.enum) || r.enum.length > 256))
      unsupported();
  };
  visit(root, 0, 0);
  for (const definition of Object.values(defs)) visit(definition, 1, 0);
}

const MAX_SCHEMA_WORKERS = 2;
const MAX_SCHEMA_WAITERS = 16;
let activeWorkers = 0;
const waiters: {
  readonly resolve: (release: () => void) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly abort: () => void;
}[] = [];
function releaseWorker(): void {
  const next = waiters.shift();
  if (next) {
    next.signal?.removeEventListener("abort", next.abort);
    next.resolve(releaseWorker);
  } else activeWorkers--;
}
function acquireWorker(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted)
    return Promise.reject(new ExtractionSpecError("schema-cancelled"));
  if (activeWorkers < MAX_SCHEMA_WORKERS) {
    activeWorkers++;
    return Promise.resolve(releaseWorker);
  }
  if (waiters.length >= MAX_SCHEMA_WAITERS)
    return Promise.reject(new ExtractionSpecError("schema-busy"));
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = waiters.findIndex((waiter) => waiter.abort === abort);
      if (index >= 0) waiters.splice(index, 1);
      signal?.removeEventListener("abort", abort);
      reject(new ExtractionSpecError("schema-cancelled"));
    };
    waiters.push({ resolve, reject, signal, abort });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
async function runWorker(
  schema: object,
  payload: unknown,
  signal?: AbortSignal,
  batch = false,
): Promise<{
  valid: boolean;
  issue: { instance_path: string; keyword: string } | null;
}> {
  const release = await acquireWorker(signal);
  if (signal?.aborted) {
    release();
    throw new ExtractionSpecError("schema-cancelled");
  }
  const source = import.meta.url.endsWith(".ts");
  let worker: Worker | undefined;
  try {
    worker = new Worker(
      new URL(
        source ? "./schema-worker.ts" : "./schema-worker.js",
        import.meta.url,
      ),
      {
        workerData: batch
          ? { schema, payloads: payload }
          : payload === undefined
            ? { schema }
            : { schema, payload },
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
          codeRangeSizeMb: 16,
          stackSizeMb: 2,
        },
        execArgv: [
          ...process.execArgv.filter(
            (arg) =>
              arg !== "--experimental-strip-types" &&
              !arg.startsWith("--input-type"),
          ),
          ...(source ? ["--experimental-strip-types"] : []),
        ],
      },
    );
    return await new Promise((resolve, reject) => {
      let settled = false;
      const done = (result: unknown, error?: ExtractionSpecError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        worker?.removeAllListeners("message");
        worker?.removeAllListeners("error");
        worker?.removeAllListeners("exit");
        if (error) reject(error);
        else if (
          result &&
          typeof result === "object" &&
          typeof (result as { valid?: unknown }).valid === "boolean" &&
          ((result as { issue?: unknown }).issue === null ||
            (typeof (result as { issue?: unknown }).issue === "object" &&
              typeof (result as { issue?: { instance_path?: unknown } }).issue
                ?.instance_path === "string" &&
              typeof (result as { issue?: { keyword?: unknown } }).issue
                ?.keyword === "string"))
        )
          resolve(
            result as {
              valid: boolean;
              issue: { instance_path: string; keyword: string } | null;
            },
          );
        else reject(new ExtractionSpecError("invalid-spec"));
      };
      const timer = setTimeout(
        () => done(null, new ExtractionSpecError("schema-timeout")),
        3000,
      );
      const abort = () =>
        done(null, new ExtractionSpecError("schema-cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
      worker!.once("message", (result) => done(result));
      worker!.once("error", (error: Error) =>
        done(
          null,
          new ExtractionSpecError(
            (error as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY"
              ? "schema-resource-limit"
              : "invalid-spec",
          ),
        ),
      );
      worker!.once("exit", () =>
        done(null, new ExtractionSpecError("invalid-spec")),
      );
      if (signal?.aborted) abort();
    });
  } finally {
    try {
      await worker?.terminate();
    } finally {
      release();
    }
  }
}

export async function validateExtractionSpec(
  value: unknown,
  signal?: AbortSignal,
): Promise<ExtractionSpec> {
  const spec = await parseExtractionSpec(value);
  extractionCanonicalJsonBytes(spec.output_schema);
  checkSchema(spec.output_schema);
  const checked = await runWorker(spec.output_schema, undefined, signal);
  if (!checked.valid) throw new ExtractionSpecError("invalid-spec");
  return spec;
}

/** T02 uses this same bounded validator for candidate payloads. */
export async function validateExtractionPayload(
  spec: ExtractionSpec,
  payload: unknown,
  signal?: AbortSignal,
) {
  const validatedSpec = await validateExtractionSpec(spec, signal);
  const bytes = extractionCanonicalJsonBytes(payload);
  if (bytes.length > 1024 * 1024) throw new ExtractionSpecError("invalid-spec");
  return runWorker(
    validatedSpec.output_schema,
    JSON.parse(new TextDecoder().decode(bytes)),
    signal,
  );
}

/** Compile the bounded schema once for a complete atomic batch. */
export async function validateExtractionPayloads(
  spec: ExtractionSpec,
  payloads: readonly unknown[],
  signal?: AbortSignal,
) {
  if (!Array.isArray(payloads) || payloads.length > 64)
    throw new ExtractionSpecError("invalid-spec");
  const validatedSpec = await parseExtractionSpec(spec);
  checkSchema(validatedSpec.output_schema);
  const bytes = extractionCanonicalJsonBytes(payloads);
  return runWorker(
    validatedSpec.output_schema,
    JSON.parse(new TextDecoder().decode(bytes)),
    signal,
    true,
  );
}

/** Shared bounded schema validation for durable, caller-defined result records. */
export async function validateRecordPayloads(
  schema: object,
  payloads: readonly unknown[],
  signal?: AbortSignal,
): Promise<void> {
  const output = { ...schema, $schema: EXTRACTION_SCHEMA_URI };
  checkSchema(output);
  if (!payloads.length) {
    if (!(await runWorker(output, undefined, signal)).valid)
      throw new ExtractionSpecError("invalid-spec");
  }
  for (let offset = 0; offset < payloads.length; offset += 64) {
    const bytes = extractionCanonicalJsonBytes(
      payloads.slice(offset, offset + 64),
    );
    const checked = await runWorker(
      output,
      JSON.parse(new TextDecoder().decode(bytes)),
      signal,
      true,
    );
    if (!checked.valid) throw new ExtractionSpecError("invalid-spec");
  }
}
