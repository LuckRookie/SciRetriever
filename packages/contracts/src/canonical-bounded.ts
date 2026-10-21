import { ContractValidationError } from "./index.js";
function fail(): never {
  throw new ContractValidationError();
}
function hasLoneSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    value,
  );
}

/** Shared deterministic encoder; each public owner supplies its own bounded policy. */
export function boundedCanonicalJsonBytes(
  value: unknown,
  maxBytes: number,
  limits: {
    readonly maxDepth: number;
    readonly maxNodes: number;
    readonly maxArrayLength?: number;
  },
): Uint8Array {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(limits.maxDepth) ||
    limits.maxDepth < 0 ||
    limits.maxDepth > 33 ||
    !Number.isSafeInteger(limits.maxNodes) ||
    limits.maxNodes < 1 ||
    (limits.maxArrayLength !== undefined &&
      (!Number.isSafeInteger(limits.maxArrayLength) ||
        limits.maxArrayLength < 1 ||
        limits.maxArrayLength > 20480))
  )
    fail();
  const encoder = new TextEncoder();
  let budget = maxBytes;
  let nodes = 0;
  const consume = (size: number) => {
    budget -= size;
    if (budget < 0) fail();
  };
  const compareKeys = (left: string, right: string): number => {
    const a = Array.from(left);
    const b = Array.from(right);
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
      if (difference) return difference;
    }
    return a.length - b.length;
  };
  const visit = (item: unknown, depth: number): string => {
    if (depth > limits.maxDepth || ++nodes > limits.maxNodes) fail();
    if (item === null || typeof item === "boolean") {
      const serialized = JSON.stringify(item);
      consume(serialized.length);
      return serialized;
    }
    if (typeof item === "string") {
      if (hasLoneSurrogate(item) || item.length > maxBytes) fail();
      const serialized = JSON.stringify(item);
      consume(encoder.encode(serialized).length);
      return serialized;
    }
    if (typeof item === "number") {
      if (
        !Number.isFinite(item) ||
        (Number.isInteger(item) && !Number.isSafeInteger(item))
      )
        fail();
      const serialized = JSON.stringify(item);
      consume(serialized.length);
      return serialized;
    }
    if (Array.isArray(item)) {
      if (item.length > (limits.maxArrayLength ?? 256)) fail();
      const ownKeys = Reflect.ownKeys(item);
      if (
        ownKeys.length !== item.length + 1 ||
        ownKeys.some(
          (key) =>
            key !== "length" &&
            (typeof key !== "string" ||
              !/^(0|[1-9][0-9]*)$/.test(key) ||
              Number(key) >= item.length),
        )
      )
        fail();
      consume(item.length > 0 ? item.length + 1 : 2);
      const parts: string[] = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, "value")) fail();
        parts.push(visit(descriptor.value, depth + 1));
      }
      return `[${parts.join(",")}]`;
    }
    if (
      !item ||
      typeof item !== "object" ||
      Object.getPrototypeOf(item) !== Object.prototype
    )
      fail();
    const record = item as Record<string, unknown>;
    const keys: string[] = [];
    for (const key in record) {
      if (!Object.hasOwn(record, key)) continue;
      keys.push(key);
      if (keys.length > 256) fail();
    }
    const ownKeys = Reflect.ownKeys(record);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some(
        (key) =>
          typeof key !== "string" ||
          !Object.getOwnPropertyDescriptor(record, key)?.enumerable,
      )
    )
      fail();
    keys.sort(compareKeys);
    if (new Set(keys.map((key) => key.normalize("NFC"))).size !== keys.length)
      fail();
    consume(keys.length > 0 ? keys.length + 1 : 2);
    const parts: string[] = [];
    for (const key of keys) {
      if (hasLoneSurrogate(key) || key.length > maxBytes) fail();
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) fail();
      const serializedKey = JSON.stringify(key);
      consume(encoder.encode(serializedKey).length + 1);
      parts.push(`${serializedKey}:${visit(descriptor.value, depth + 1)}`);
    }
    return `{${parts.join(",")}}`;
  };
  const bytes = encoder.encode(visit(value, 0));
  if (bytes.length > maxBytes) fail();
  return bytes;
}
