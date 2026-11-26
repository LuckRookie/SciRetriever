/**
 * EndNote tagged, NoteExpress and EndNote XML exports (literature materials
 * 6.4.14). Every sample below is synthetic, written from the published format
 * descriptions in the shape CNKI-style exports take; no real export was used.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeBibliographyBytes,
  detectBibliographyFormat,
  type ImportAdapterResult,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { importAdapters } from "../src/literature/import-adapters.js";
import { readXml, xmlText, XML_LIMITS } from "../src/literature/small-xml.js";

const TAGGED = `%0 Journal Article
%A 王小明
%A 李华;张三
%+ 合成大学化学学院
%T 合成四唑类含能盐的研究
%J 含能材料
%D 2023
%8 2023-04-15
%V 31
%N 4
%P 301-310
%@ 1006-9941
%K 四唑;含能盐;合成
%X 本文报道一种合成方法。
续行的摘要第二行。
%R 10.11943/CJEM2023.0001
%W CNKI

%0 Thesis
%A 赵六
%Y 钱导师
%T 高氮化合物的合成与表征
%I 合成理工大学
%D 2022
%9 博士
%K 高氮化合物；表征
续行关键词
%W CNKI

%0 Journal Article
%A Lin, Yue
%A Okafor, Ada
%T Synthetic tetrazole salt A
%J Synthetic Journal of Energetic Materials
%D 2024
%U https://doi.org/10.5555/synth.0001
%> internal-pdf://1234567890/Lin 2024.pdf

%0 Journal Article
%J A record with neither title nor identifier
`;
const NOTEEXPRESS = `{Reference Type}: Journal Article
{Title}: 硝基三唑的合成
{Author}: 王小明;李华;
{Author Address}: 合成大学
{Journal}: 火炸药学报
{Year}: 2021
{Volume}: 44
{Issue}: 2
{Pages}: 150-156
{Keywords}: 三唑;硝化
{Abstract}: 第一行摘要
第二行摘要
{ISBN/ISSN}: 1007-7812
{DOI}: 10.14077/j.issn.1007-7812.2021.02.003
{Database Provider}: CNKI

{Reference Type}: Thesis
{Title}: 叠氮化合物研究
{Author}: 孙七
{Tertiary Author}: 周导师
{Publisher}: 合成大学
{Year}: 2020
`;
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<xml><records><record><database name="Synthetic.enl" path="/x/Synthetic.enl">Synthetic.enl</database>
<ref-type name="Journal Article">17</ref-type>
<contributors><authors><author><style face="normal" font="default" size="100%">Lin, Yue</style></author><author><style face="normal">Okafor, </style><style face="italic">Ada</style></author></authors></contributors>
<titles><title><style face="normal">Synthetic &amp; tetrazole salt</style></title><secondary-title><style>Secondary</style></secondary-title></titles>
<periodical><full-title>Synthetic Journal of Energetic Materials</full-title></periodical>
<pages>1-10</pages><volume>5</volume><number>2</number>
<keywords><keyword>tetrazole</keyword><keyword>salt; energetic</keyword></keywords>
<dates><year>2024</year><pub-dates><date>2024-03</date></pub-dates></dates>
<isbn>1234-5679</isbn><electronic-resource-num><style>https://doi.org/10.5555/synth.xml1</style></electronic-resource-num>
<urls><pdf-urls><url>internal-pdf://0987654321/Lin_2024.pdf</url></pdf-urls></urls>
<language>eng</language></record>
<record><ref-type name="Thesis">32</ref-type><titles><title>学位论文的 XML 记录</title></titles>
<contributors><authors><author>钱八</author></authors></contributors><publisher>合成大学</publisher><dates><year>2019</year></dates></record>
</records></xml>`;

const decode = (format: string, text: string): ImportAdapterResult =>
  importAdapters().get(format)!.decode(text, 0);
const records = (result: ImportAdapterResult) =>
  result.items.map((i) => i.record);

describe("EndNote tagged", () => {
  it("reads CNKI-style records, a thesis, continued fields and an internal PDF", () => {
    const result = decode("endnote-tagged", TAGGED);
    expect(result.items).toHaveLength(4);
    const [article, thesis, english, empty] = records(result);
    expect(article!.metadata).toMatchObject({
      title: "合成四唑类含能盐的研究",
      venue: "含能材料",
      publication_year: 2023,
      publication_date: "2023-04-15",
      volume: "31",
      issue: "4",
      pages: "301-310",
      publication_form: "journal-article",
      abstract: "本文报道一种合成方法。 续行的摘要第二行。",
      keywords: ["四唑", "含能盐", "合成"],
    });
    // One author per line, a line with semicolons is several; Chinese names stay whole.
    expect(
      article!.metadata.authors.map((a) => [a.display_name, a.family_name]),
    ).toEqual([
      ["王小明", null],
      ["李华", null],
      ["张三", null],
    ]);
    expect(article!.metadata.identifiers).toEqual(
      expect.arrayContaining([
        { namespace: "doi", value: "10.11943/cjem2023.0001" },
        { namespace: "issn", value: "1006-9941" },
      ]),
    );
    expect(thesis!.metadata).toMatchObject({
      title: "高氮化合物的合成与表征",
      publisher: "合成理工大学",
      publication_year: 2022,
      publication_form: "thesis",
      keywords: ["高氮化合物", "表征", "续行关键词"],
    });
    // The supervisor (%Y) is not an author.
    expect(thesis!.metadata.authors.map((a) => a.display_name)).toEqual([
      "赵六",
    ]);
    expect(
      english!.metadata.authors.map((a) => [a.family_name, a.given_name]),
    ).toEqual([
      ["Lin", "Yue"],
      ["Okafor", "Ada"],
    ]);
    // A DOI read from the URL; the attachment only as “folder ID/file name”.
    expect(english!.metadata.identifiers).toEqual([
      { namespace: "doi", value: "10.5555/synth.0001" },
    ]);
    expect(english!.files).toEqual([
      expect.objectContaining({
        external_id: "1234567890",
        file_name: "Lin 2024.pdf",
        media_type: "application/pdf",
      }),
    ]);
    expect(empty!.metadata).toMatchObject({ title: null, identifiers: [] });
  });
});

describe("NoteExpress", () => {
  it("reads records, semicolon authors, continued abstract and skips the supervisor", () => {
    const [article, thesis] = records(decode("noteexpress", NOTEEXPRESS));
    expect(article!.metadata).toMatchObject({
      title: "硝基三唑的合成",
      venue: "火炸药学报",
      publication_year: 2021,
      volume: "44",
      issue: "2",
      pages: "150-156",
      abstract: "第一行摘要 第二行摘要",
      keywords: ["三唑", "硝化"],
    });
    expect(article!.metadata.authors.map((a) => a.display_name)).toEqual([
      "王小明",
      "李华",
    ]);
    expect(article!.metadata.identifiers).toEqual(
      expect.arrayContaining([
        { namespace: "doi", value: "10.14077/j.issn.1007-7812.2021.02.003" },
        { namespace: "issn", value: "1007-7812" },
      ]),
    );
    expect(article!.files).toEqual([]);
    expect(thesis!.metadata).toMatchObject({
      title: "叠氮化合物研究",
      publisher: "合成大学",
      publication_year: 2020,
      publication_form: "thesis",
    });
    expect(thesis!.metadata.authors.map((a) => a.display_name)).toEqual([
      "孙七",
    ]);
  });
});

describe("EndNote XML", () => {
  it("reads text wrapped in style elements, in order, and the internal PDF", () => {
    const result = decode("endnote-xml", XML);
    expect(result.items).toHaveLength(2);
    const [article, thesis] = records(result);
    expect(article!.metadata).toMatchObject({
      title: "Synthetic & tetrazole salt",
      venue: "Synthetic Journal of Energetic Materials",
      publication_year: 2024,
      publication_date: "2024-03",
      volume: "5",
      issue: "2",
      pages: "1-10",
      language: "eng",
      publication_form: "journal-article",
      keywords: ["tetrazole", "salt", "energetic"],
    });
    expect(
      article!.metadata.authors.map((a) => [a.family_name, a.given_name]),
    ).toEqual([
      ["Lin", "Yue"],
      ["Okafor", "Ada"],
    ]);
    expect(article!.metadata.identifiers).toEqual(
      expect.arrayContaining([
        { namespace: "doi", value: "10.5555/synth.xml1" },
        { namespace: "issn", value: "1234-5679" },
      ]),
    );
    expect(article!.files).toEqual([
      expect.objectContaining({
        external_id: "0987654321",
        file_name: "Lin_2024.pdf",
      }),
    ]);
    expect(thesis!.metadata).toMatchObject({
      title: "学位论文的 XML 记录",
      publisher: "合成大学",
      publication_year: 2019,
      publication_form: "thesis",
    });
  });

  it("is read by a bounded reader that refuses declarations and limits depth", () => {
    expect(
      xmlText(readXml("<a>x<b><c>y</c>&#x4E2D;&lt;</b><![CDATA[<z>]]></a>")),
    ).toBe("xy中<<z>");
    expect(() =>
      readXml('<!DOCTYPE a [<!ENTITY e "boom">]><a>&e;</a>'),
    ).toThrow(/declaration/u);
    expect(() => readXml("<a>&e;</a>")).toThrow(/entity/u);
    expect(() => readXml("<a><b></a></b>")).toThrow(/mismatch/u);
    expect(() =>
      readXml(
        "<a>".repeat(XML_LIMITS.depth + 1) +
          "</a>".repeat(XML_LIMITS.depth + 1),
      ),
    ).toThrow(/too-deep/u);
    expect(() => readXml("<a/><b/>")).toThrow(/second-root/u);
    expect(decode("endnote-xml", "<xml><other/></xml>").items).toMatchObject([
      { record: null, reason: "malformed-document" },
    ]);
  });
});

describe("recognizing a file", () => {
  it("goes by the extension, and for .txt, .xml or none by the first line", () => {
    expect(detectBibliographyFormat("a.enw", "")).toBe("endnote-tagged");
    expect(detectBibliographyFormat("a.net", "")).toBe("noteexpress");
    expect(detectBibliographyFormat("cnki.txt", "\n\n" + TAGGED)).toBe(
      "endnote-tagged",
    );
    expect(detectBibliographyFormat("cnki.txt", NOTEEXPRESS)).toBe(
      "noteexpress",
    );
    expect(detectBibliographyFormat("library.xml", XML)).toBe("endnote-xml");
    expect(detectBibliographyFormat(null, "\uFEFF" + TAGGED)).toBe("endnote-tagged");
    expect(detectBibliographyFormat("a.ris", "")).toBe("ris");
    expect(detectBibliographyFormat("notes.txt", "just a note")).toBeNull();
    expect(
      detectBibliographyFormat("a.xml", "<html><body/></html>"),
    ).toBeNull();
  });
  it("reads UTF-8 without its BOM, else GB18030", () => {
    expect(
      decodeBibliographyBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x25, 0x30])),
    ).toEqual({ text: "%0", encoding: "utf-8" });
    expect(decodeBibliographyBytes(Buffer.from("cdf5d0a1c3f7", "hex"))).toEqual(
      { text: "王小明", encoding: "gb18030" },
    );
  });
});

describe("import_bibliography", () => {
  it("recognizes a GB18030 CNKI .txt export and imports it; an unknown file is refused", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-endnote-"));
    const app = await createApplication(home, {
      indexRefreshIntervalMs: null,
      metadata: { lookup_ports: [], topic_search_ports: [] },
    });
    try {
      const bytes = Buffer.concat([
        Buffer.from("%0 Journal Article\r\n%A "),
        Buffer.from("cdf5d0a1c3f7", "hex"),
        Buffer.from("\r\n%T "),
        Buffer.from("b8dfb5aabaacc4dcd1ceb5c4bacfb3c9", "hex"),
        Buffer.from("\r\n%J "),
        Buffer.from("baacc4dcb2c4c1cf", "hex"),
        Buffer.from("\r\n%D 2023\r\n%R 10.5555/synth.gb18030\r\n"),
      ]);
      const result = await app.importSessions.importBibliography(
        bytes,
        null,
        "CNKI-export.txt",
        "cli",
      );
      expect(result).toMatchObject({
        format: "endnote-tagged",
        items: [{ disposition: "created" }],
      });
      const found = (await app.library.search({ query: {} })).items;
      expect(found.map((i) => i.literature.metadata.title)).toEqual([
        "高氮含能盐的合成",
      ]);
      // The other formats keep their strict decoding.
      expect(
        await app.importSessions.importBibliography(
          Buffer.from("TY  - JOUR\r\nTI  - \xb8\xdf\r\nER  - \r\n", "latin1"),
          "ris",
          null,
          "cli",
        ),
      ).toMatchObject({ items: [{ reason: "malformed-document" }] });
      await expect(
        app.importSessions.importBibliography(
          Buffer.from("not a bibliography"),
          null,
          "notes.txt",
          "cli",
        ),
      ).rejects.toMatchObject({ code: "intake-format-unsupported" });
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 60000);
});
