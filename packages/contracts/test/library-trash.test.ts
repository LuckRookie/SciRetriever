import { expect, it } from "vitest";
import {
  ContractValidationError,
  LIBRARY_TRASH_MAX_IDS,
  parseLibraryTrashCount,
  parseLibraryTrashPage,
  parseLibraryTrashQuery,
  parseLibraryTrashRequest,
  parseLibraryTrashResult,
} from "../src/index.js";

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = (n: number) => Array.from({ length: n }, (_, i) => uuid(i));
const a = uuid(0xa);
const request = (operation: unknown, literature_ids: unknown) => ({
  operation,
  selector: { kind: "literatures", literature_ids },
});

it("accepts one to a thousand distinct papers for delete or restore", () => {
  expect(parseLibraryTrashRequest(request("delete", [a]))).toEqual(
    request("delete", [a]),
  );
  expect(
    parseLibraryTrashRequest(request("restore", ids(LIBRARY_TRASH_MAX_IDS)))
      .selector.literature_ids,
  ).toHaveLength(1000);
  for (const invalid of [
    request("delete", []),
    request("delete", ids(1001)),
    request("delete", [a, a]),
    request("delete", [a, 1]),
    request("delete", a),
    request("purge", [a]),
    { operation: "delete", selector: { kind: "query", query: {} } },
    { ...request("delete", [a]), extra: true },
    {
      operation: "delete",
      selector: { kind: "literatures", literature_ids: [a], extra: 1 },
    },
  ])
    expect(() => parseLibraryTrashRequest(invalid)).toThrow(
      ContractValidationError,
    );
});

it("keeps the result's changed count within the request", () => {
  expect(
    parseLibraryTrashResult({
      operation: "delete",
      target_count: 3,
      changed: 2,
    }),
  ).toEqual({ operation: "delete", target_count: 3, changed: 2 });
  for (const invalid of [
    { operation: "delete", target_count: 1, changed: 2 },
    { operation: "delete", target_count: 0, changed: 0 },
    { operation: "delete", target_count: 1001, changed: 0 },
    { operation: "delete", target_count: 1, changed: -1 },
    { operation: "restore", target_count: 1 },
  ])
    expect(() => parseLibraryTrashResult(invalid)).toThrow(
      ContractValidationError,
    );
});

it("parses the list and count reads with bounded pages", () => {
  expect(parseLibraryTrashQuery({ operation: "count", request: {} })).toEqual({
    operation: "count",
    request: {},
  });
  expect(
    parseLibraryTrashQuery({
      operation: "list",
      request: { limit: 100, cursor: "abc_-1" },
    }),
  ).toEqual({ operation: "list", request: { limit: 100, cursor: "abc_-1" } });
  for (const invalid of [
    { operation: "list", request: { limit: 0, cursor: null } },
    { operation: "list", request: { limit: 101, cursor: null } },
    { operation: "list", request: { limit: 1 } },
    { operation: "list", request: { limit: 1, cursor: "" } },
    { operation: "list", request: { limit: 1, cursor: "a=b" } },
    { operation: "count", request: { limit: 1 } },
    { operation: "delete", request: {} },
  ])
    expect(() => parseLibraryTrashQuery(invalid)).toThrow(
      ContractValidationError,
    );

  const item = {
    literature: {
      literature_id: a,
      identifiers: [{ namespace: "doi", value: "10.1000/a" }],
      title: "A",
      year: 2024,
    },
    deleted_at: "2026-11-25T08:00:00.000Z",
    deleted_by: "cli:local",
  };
  expect(parseLibraryTrashPage({ items: [item], next_cursor: "n" })).toEqual({
    items: [item],
    next_cursor: "n",
  });
  for (const invalid of [
    { items: [{ ...item, deleted_by: "" }], next_cursor: null },
    { items: [{ ...item, deleted_at: "yesterday" }], next_cursor: null },
    { items: [{ ...item, extra: 1 }], next_cursor: null },
    { items: Array.from({ length: 101 }, () => item), next_cursor: null },
    { items: [], next_cursor: "" },
  ])
    expect(() => parseLibraryTrashPage(invalid)).toThrow(
      ContractValidationError,
    );
  expect(parseLibraryTrashCount({ total_count: 0 })).toEqual({
    total_count: 0,
  });
  expect(() => parseLibraryTrashCount({ total_count: -1 })).toThrow(
    ContractValidationError,
  );
});
