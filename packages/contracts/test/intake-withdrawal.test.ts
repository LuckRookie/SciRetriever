import { expect, it } from "vitest";
import {
  parseIntakeWithdrawalPreview,
  parseIntakeWithdrawalReport,
  parseIntakeRestorePreview,
} from "../src/index.js";

it("parses exact, bounded withdrawal and restoration reports without inventing legacy ownership", () => {
  const counts = {
    literatures: 1,
    file_relations: 0,
    folders: 0,
    folder_members: 0,
    marks: 0,
  };
  const preview = {
    remove: counts,
    keep: { literatures: 1, by_reason: { "folder-changed": 1 } },
    kept_items: [
      {
        literature_id: "00000000-0000-0000-0000-000000000001",
        title: "Retained",
        reasons: ["folder-changed"],
      },
    ],
    registered: false,
  };
  expect(parseIntakeWithdrawalPreview(preview)).toEqual(preview);
  const { remove, ...common } = preview;
  for (const kind of ["remove", "restore"]) {
    const report = {
      ...common,
      [kind]: remove,
      at: "2026-11-17T00:00:00.000Z",
      by: "web",
    };
    expect(parseIntakeWithdrawalReport(report)).toEqual(report);
    expect(() =>
      parseIntakeWithdrawalReport({ ...report, by: "device" }),
    ).toThrow();
  }
  for (const bad of [
    { ...preview, extra: 1 },
    { ...preview, registered: null },
    { ...preview, remove: { ...counts, literatures: -1 } },
    { ...preview, keep: { literatures: 1, by_reason: { unknown: 1 } } },
    { ...preview, kept_items: Array(201).fill(preview.kept_items[0]) },
    {
      ...preview,
      kept_items: [
        {
          ...preview.kept_items[0],
          reasons: ["folder-changed", "folder-changed"],
        },
      ],
    },
  ])
    expect(() => parseIntakeWithdrawalPreview(bad)).toThrow();
});

it("parses exact restore previews with nonnegative integral counts", () => {
  const preview = {
    restore: {
      literatures: 2,
      file_relations: 1,
      folders: 0,
      folder_members: 3,
      marks: 1,
    },
    already_restored: { literatures: 1 },
  };
  expect(parseIntakeRestorePreview(preview)).toEqual(preview);
  for (const bad of [
    { ...preview, extra: true },
    { ...preview, restore: { ...preview.restore, extra: 0 } },
    { ...preview, restore: { ...preview.restore, marks: -1 } },
    { ...preview, restore: { ...preview.restore, literatures: 0.5 } },
    { ...preview, already_restored: { literatures: -1 } },
    { ...preview, already_restored: { literatures: 1, folders: 0 } },
    { ...preview, already_restored: null },
  ])
    expect(() => parseIntakeRestorePreview(bad)).toThrow();
});
