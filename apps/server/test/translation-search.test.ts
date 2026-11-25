import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { MaterialContextBundle } from "@sciretriever/contracts";
import { createQueryApplication } from "../src/bootstrap/application.js";
import { runCli } from "../src/cli/main.js";
import { ftsMatchQuery } from "../src/literature/query.js";
import {
  FTS_CJK_BREAK,
  ftsIndexText,
} from "../src/literature/unicode-casefold.js";
import { archiveFixture } from "./archive-fixture.js";

// Document spec 9.7: full-text search covers stored translations, and CJK is
// indexed and queried one character per word.
const TEXT =
  "# Abstract\n\nFixture Author studies synthetic spectroscopy.\n\n# Introduction\n\nA complete synthetic study.\n\n# Conclusion\n\nSpectroscopy is the main theme.\n\n# References\n\n[1] Example synthetic reference.\n";
const CHINESE: Readonly<Record<string, string>> = {
  Abstract: "摘要",
  Introduction: "引言",
  Conclusion: "结论",
  "Fixture Author studies synthetic spectroscopy.": "作者研究合成光谱。",
  "A complete synthetic study.": "一项完整的合成研究。光谱分析 synthetic",
  "Spectroscopy is the main theme.": "光谱是主题。",
};
type Fixture = Awaited<ReturnType<typeof archiveFixture>>;
async function fixture(words = CHINESE) {
  const e = await archiveFixture({ offline: true });
  e.setText(TEXT);
  let table = words;
  e.setTranslation((input) => ({
    translations: input.units.map((u) => ({
      id: u.id,
      translation: table[u.text.replace(/^#+\s*/u, "")] ?? `译文：${u.text}`,
    })),
  }));
  return Object.assign(e, {
    setWords(next: Readonly<Record<string, string>>) {
      table = next;
    },
  });
}
async function search(e: Fixture, query: string) {
  const q = await createQueryApplication(e.home);
  try {
    return (await q.context!.search({
      query,
      scope: { kind: "library" },
      kinds: ["document"],
      versions: { kind: "default" },
      budget: { max_items: 20, max_bytes: 65_536, token_limit: null },
      continuation: null,
    })) as MaterialContextBundle;
  } finally {
    await q.close();
  }
}

it("splits Han, kana and Hangul into one-character words, and matches a run as a phrase", () => {
  expect(ftsIndexText("中文论文 Spectra")).toBe("中 文 论 文 spectra");
  expect(ftsIndexText("かなとハングル한글")).toBe("か な と ハ ン グ ル 한 글");
  // Punctuation between two runs leaves a word no query contains.
  expect(ftsIndexText("研究。光谱")).toBe(`研 究 ${FTS_CJK_BREAK} 光 谱`);
  expect(ftsIndexText("研究 光谱")).toBe("研 究 光 谱");
  expect(ftsMatchQuery("合成研究 spectra AND")).toBe(
    '"合 成 研 究" AND "spectra"',
  );
  expect(ftsMatchQuery("研究，光谱")).toBe('"研 究" AND "光 谱"');
  // Latin text keeps its words.
  expect(ftsIndexText("Spectro-scopy and NMR")).toBe("spectro scopy nmr");
});

it("finds a paper by its translation and leads back to the original unit, once per unit", async () => {
  const e = await fixture();
  try {
    await e.submit("search-translation");
    await e.app.maintenance!.refreshIndex!();
    const part = (await e.app.archive.status(e.id)).parts.find(
      (p) => p.part === "main",
    )!;
    // Two characters, then one: both find the translated unit.
    for (const query of ["合成研究", "完"]) {
      const found = await search(e, query);
      expect(found.coverage).toBe("complete");
      const item = found.items.find(
        (i) => i.matched === "translation" && i.text.startsWith("一项完整"),
      )!;
      expect(item).toMatchObject({
        kind: "source-text",
        matched: "translation",
        language: "zh-Hans",
        text_level: "proofread",
        text: expect.stringContaining("研究"),
        reference: {
          kind: "document",
          document_version_id: part.document_version_id,
        },
      });
      // The reference and evidence are the original unit's bytes.
      expect(item.evidence.length).toBeGreaterThan(0);
      const q = await createQueryApplication(e.home);
      try {
        const slice = await q.documentRead!.slice({
          document_version_id: part.document_version_id!,
          selector: {
            kind: "range",
            start_utf8: (item.reference as { start_utf8: number }).start_utf8,
            end_utf8: (item.reference as { end_utf8: number }).end_utf8,
          },
          max_bytes: 65_536,
          continuation: null,
        });
        expect(slice.text).toBe("A complete synthetic study.");
      } finally {
        await q.close();
      }
    }
    // A phrase never spans two units or a sentence break inside one.
    expect((await search(e, "究光")).items).toEqual([]);
    expect((await search(e, "谱引")).items).toEqual([]);
    expect((await search(e, "谱是")).items).toHaveLength(1);
    expect((await search(e, "光谱")).items.length).toBeGreaterThan(1);
    // The original and the translation of one unit both match: one item,
    // shown as the original.
    const both = await search(e, "synthetic");
    const units = both.items.filter(
      (i) => i.text === "A complete synthetic study.",
    );
    expect(units).toHaveLength(1);
    expect(units[0]).not.toHaveProperty("matched");
    expect(
      both.items.filter((i) => i.text.includes("光谱分析 synthetic")),
    ).toEqual([]);
  } finally {
    await e.close();
  }
}, 0);

it("drops the old translation's entries when a new translation replaces it", async () => {
  const e = await fixture();
  try {
    await e.submit("search-before-change");
    await e.app.maintenance!.refreshIndex!();
    expect((await search(e, "主题")).items).toHaveLength(1);
    e.setWords({
      ...CHINESE,
      "Spectroscopy is the main theme.": "光谱是中心议题。",
    });
    await e.submit("search-after-change", undefined, "translate");
    // The new file's registration journals the paper; the refresh follows it.
    await e.app.maintenance!.refreshIndex!();
    expect((await search(e, "主题")).items).toEqual([]);
    expect((await search(e, "议题")).items).toMatchObject([
      { matched: "translation", text: "光谱是中心议题。" },
    ]);
  } finally {
    await e.close();
  }
}, 0);

it("reads an index built by an older text rule as stale until an explicit rebuild", async () => {
  const e = await fixture();
  try {
    await e.submit("search-rule");
    await e.app.maintenance!.refreshIndex!();
    expect((await search(e, "研究")).coverage).toBe("complete");
    const db = new DatabaseSync(join(e.home, "catalog.sqlite"));
    try {
      // A generation from before this rule carries no text rule.
      db.exec("UPDATE retrieval_generations SET text_rule=NULL");
    } finally {
      db.close();
    }
    const stale = await search(e, "研究");
    expect(stale.coverage).toBe("index-stale");
    // An incremental refresh does not make it current; a rebuild does.
    await e.app.maintenance!.refreshIndex!();
    expect((await search(e, "研究")).coverage).toBe("index-stale");
    await e.app.maintenance!.rebuildIndex();
    expect((await search(e, "研究")).coverage).toBe("complete");
  } finally {
    await e.close();
  }
}, 0);

it("rewrites library search rows to the new rule with the explicit rebuild command", async () => {
  const e = await fixture();
  try {
    const before = await e.app.metadataFields.read(e.id);
    await e.app.metadataFields.edit({
      literature_id: e.id,
      expected_revision: before.metadata_revision,
      set: [{ field: "title", value: "中文论文的检索" }],
      unlock: [],
    });
    const find = async (text: string) =>
      (await e.app.library.search({ query: { text }, limit: 20, cursor: null }))
        .items.length;
    expect(await find("论文")).toBe(1);
    expect(await find("文的")).toBe(1);
    expect(await find("检文")).toBe(0);
    // Rows written by the old rule kept a run of Han characters as one word.
    const db = new DatabaseSync(join(e.home, "catalog.sqlite"));
    try {
      db.prepare(
        "UPDATE literature_search_fts SET title=? WHERE literature_id=?",
      ).run("中文论文的检索", e.id);
    } finally {
      db.close();
    }
    expect(await find("论文")).toBe(0);
    let out = "";
    const cli = await runCli(["maintenance", "rebuild-library-search"], {
      home: e.home,
      stdout: (s) => {
        out += s;
      },
    });
    expect(cli.code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ literatures: 1 });
    expect(await find("论文")).toBe(1);
  } finally {
    await e.close();
  }
}, 0);
