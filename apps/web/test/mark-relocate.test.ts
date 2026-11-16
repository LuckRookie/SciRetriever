/** User organization 9.4: finding a mark again on another PDF or text version. */
import { describe, expect, it } from "vitest";
import { MARK_LOCATE_METHOD, type ReadingMark } from "@sciretriever/contracts";
import { canon } from "../src/reading/mark-locate.js";
import {
  grade,
  partOf,
  recordedPlace,
  relocate,
  samePart,
  versionParts,
  wantsSearch,
} from "../src/reading/mark-relocate.js";

const SHA_A = "a".repeat(64),
  SHA_B = "b".repeat(64),
  SHA_SUPP = "c".repeat(64);
function mark(over: Partial<ReadingMark> = {}): ReadingMark {
  return {
    mark_id: "00000000-0000-4000-8000-000000000001",
    literature_id: "00000000-0000-4000-8000-000000000002",
    kind: "highlight",
    color: "blue",
    note: "",
    tags: [],
    quote: "the density of the salt is 1.86 g per cubic centimetre",
    quote_prefix: "At room temperature ",
    quote_suffix: " as measured by pycnometry.",
    pdf: { sha256: SHA_A, page: 2, rects: [[10, 10, 100, 12]] },
    document: null,
    created_at: "2026-11-17T00:00:00.000Z",
    updated_at: "2026-11-17T00:00:00.000Z",
    deleted_at: null,
    places: [],
    ...over,
  };
}
const page = (text: string) => canon(text);

describe("relocating on another PDF (9.4)", () => {
  const original =
    "Results. At room temperature the density of the salt is 1.86 g per cubic centimetre as measured by pycnometry. Other values follow.";
  it("places a mark where the words are the same", () => {
    const hit = relocate(mark(), page(original));
    expect(hit).toMatchObject({
      grade: "place",
      similarity: 1,
      method: MARK_LOCATE_METHOD,
    });
  });
  it("is approximate after small changes, and not found once the passage is gone", () => {
    const edited = original.replace(
      "the density of the salt is 1.86 g per cubic centimetre",
      "the density of this salt is about 1.85 g per cubic centimeter",
    );
    expect(relocate(mark(), page(edited))?.grade).toBe("near");
    expect(
      relocate(mark(), page("Results. Nothing about densities here at all.")),
    ).toBeNull();
  });
  it("tells two occurrences of one sentence apart by the words around it", () => {
    const twice =
      "In the abstract the density of the salt is 1.86 g per cubic centimetre and more. " +
      "At room temperature the density of the salt is 1.86 g per cubic centimetre as measured by pycnometry.";
    const text = page(twice),
      hit = relocate(mark(), text)!;
    const second = text.lastIndexOf(canon(mark().quote));
    expect(hit.start).toBe(second);
  });
  it("grades by the same thresholds as 5.3", () => {
    expect([
      grade(0.9),
      grade(0.85),
      grade(0.8),
      grade(0.7),
      grade(0.69),
    ]).toEqual(["place", "place", "near", "near", "none"]);
  });
});

describe("when to look (9.4)", () => {
  const onB = { kind: "pdf" as const, sha256: SHA_B };
  it("looks on another PDF of the same part only", () => {
    expect(wantsSearch(mark(), onB, true)).toBe(true);
    expect(wantsSearch(mark(), onB, false)).toBe(false);
    expect(wantsSearch(mark(), { kind: "pdf", sha256: SHA_A }, true)).toBe(
      false,
    );
  });
  it("tells the part by the anchor's asset; a PDF no longer in the paper is the main one", () => {
    const parts = {
      pdf: new Map([
        [SHA_A, "main"],
        [SHA_SUPP, "supplement-1"],
      ]),
      version: new Map([["supplement-text-v1", "supplement-1"]]),
    };
    expect(partOf(mark(), parts)).toBe("main");
    expect(
      partOf(mark({ pdf: { sha256: SHA_SUPP, page: 1, rects: [] } }), parts),
    ).toBe("supplement-1");
    expect(
      partOf(
        mark({ pdf: { sha256: "d".repeat(64), page: 1, rects: [] } }),
        parts,
      ),
    ).toBe("main");
    expect(
      partOf(
        mark({
          pdf: null,
          document: {
            document_version_id: "supplement-text-v1",
            start_utf8: 0,
            end_utf8: 5,
          },
        }),
        parts,
      ),
    ).toBe("supplement-1");
  });
  it("does not look for a mark whose part cannot be told (nothing is guessed)", () => {
    const parts = {
      pdf: new Map([[SHA_A, "main"]]),
      version: new Map<string, string>(),
    };
    const old = mark({
      pdf: null,
      document: {
        document_version_id: "unknown-old-v1",
        start_utf8: 0,
        end_utf8: 5,
      },
    });
    expect(partOf(old, parts)).toBeNull();
    const same = samePart(old, "main", parts);
    expect(same).toBe(false);
    expect(
      wantsSearch(old, { kind: "document", version: "current-v2" }, same),
    ).toBe(false);
  });
  it("learns an older version's part from describe: the main part's is looked for on the main text, a supplement's only on the supplement's", () => {
    const version = versionParts(
      [
        { version: "draft-v1", assetId: "primary-asset" },
        { version: "supp-old-v1", assetId: "supp-asset" },
        { version: "gone-v1", assetId: "replaced-asset" },
      ],
      { primary: "primary-asset", additional: ["supp-asset"] },
    );
    expect([...version]).toEqual([
      ["draft-v1", "main"],
      ["supp-old-v1", "part-supp-asset"],
    ]);
    const parts = { pdf: new Map<string, string>(), version };
    const onDraft = mark({
      pdf: null,
      document: { document_version_id: "draft-v1", start_utf8: 0, end_utf8: 9 },
    });
    // A draft's mark, once the proofread text is the main one: looked for there.
    expect(
      wantsSearch(
        onDraft,
        { kind: "document", version: "proofread-v2" },
        samePart(onDraft, "main", parts),
      ),
    ).toBe(true);
    const onSupp = mark({
      pdf: null,
      document: {
        document_version_id: "supp-old-v1",
        start_utf8: 0,
        end_utf8: 9,
      },
    });
    expect(samePart(onSupp, "main", parts)).toBe(false);
    expect(samePart(onSupp, "part-supp-asset", parts)).toBe(true);
    // A version whose asset left the paper: not looked for.
    const gone = mark({
      pdf: null,
      document: { document_version_id: "gone-v1", start_utf8: 0, end_utf8: 9 },
    });
    expect(samePart(gone, "main", parts)).toBe(false);
  });
  it("never looks for a region", () => {
    expect(wantsSearch(mark({ kind: "region", quote: "" }), onB, true)).toBe(
      false,
    );
  });
  it("reads what was recorded under the current method, and looks again under another", () => {
    const recorded = mark({
      places: [
        {
          target: { pdf: { sha256: SHA_B, page: 3, rects: [[1, 2, 3, 4]] } },
          similarity: 0.9,
          method: MARK_LOCATE_METHOD,
          located_at: "2026-11-17T00:00:00.000Z",
        },
      ],
    });
    expect(recordedPlace(recorded, onB)?.similarity).toBe(0.9);
    expect(wantsSearch(recorded, onB, true)).toBe(false);
    const old = mark({
      places: [{ ...recorded.places[0]!, method: "mark-locate-v0" }],
    });
    expect(recordedPlace(old, onB)).toBeNull();
    expect(wantsSearch(old, onB, true)).toBe(true);
  });
  it("looks on another text version, a draft's proofread version included", () => {
    const onDraft = mark({
      pdf: null,
      document: {
        document_version_id: "draft-v1",
        start_utf8: 10,
        end_utf8: 60,
      },
    });
    expect(
      wantsSearch(onDraft, { kind: "document", version: "draft-v1" }, true),
    ).toBe(false);
    expect(
      wantsSearch(onDraft, { kind: "document", version: "proofread-v2" }, true),
    ).toBe(true);
    expect(
      recordedPlace(
        mark({
          document: { document_version_id: "v1", start_utf8: 0, end_utf8: 1 },
          places: [
            {
              target: {
                document: {
                  document_version_id: "v2",
                  start_utf8: 5,
                  end_utf8: 9,
                },
              },
              similarity: 1,
              method: MARK_LOCATE_METHOD,
              located_at: "2026-11-17T00:00:00.000Z",
            },
          ],
        }),
        { kind: "document", version: "v2" },
      )?.target,
    ).toEqual({
      document: { document_version_id: "v2", start_utf8: 5, end_utf8: 9 },
    });
  });
});
