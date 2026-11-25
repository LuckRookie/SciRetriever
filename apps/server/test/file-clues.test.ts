import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileStore } from "../src/storage/files/store.js";
import {
  cluesUnreadReason,
  FileClueReader,
} from "../src/literature/file-clues.js";
import {
  resolveMupdfRuntime,
  mupdfBundleCandidates,
} from "../src/proofread/mupdf.js";
import { normalizeRecognitionTitle } from "../src/literature/import-clues.js";
import { recognitionPdf } from "./intake-recognition-fixture.js";

const bundled = resolveMupdfRuntime(mupdfBundleCandidates(undefined));
const runtime = async () => {
  const found = await bundled;
  if (!found)
    throw new Error("Synthetic clue tests require the bundled MuPDF runtime");
  return found;
};
async function read(
  bytes: Uint8Array,
  name = "Synthetic.pdf",
  reader = new FileClueReader(runtime),
) {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-file-adapter-")),
    store = new FileStore(root),
    stage = await store.stage();
  try {
    await stage.write(bytes);
    return await stage.withFile((file) => reader.read(file, name));
  } finally {
    await stage.discard();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}
it("reads DOI clues in document information and XMP before filename or first-page identifiers", async () => {
  const info = await read(
    recognitionPdf({
      info: {
        title: "Synthetic information title",
        subject: "doi:10.5555/INFO",
        keywords: "intake",
      },
      pages: [[{ text: "Other DOI 10.5555/other" }]],
    }),
  );
  expect(info).toMatchObject({
    status: "read",
    reason: null,
    unread: null,
    info: { title: "Synthetic information title" },
    identifiers: [{ namespace: "doi", value: "10.5555/info" }],
  });
  const xmp = await read(
    recognitionPdf({
      xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/" xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Synthetic &amp; XMP title</rdf:li></rdf:Alt></dc:title><dc:identifier>doi:10.5555/XMP</dc:identifier><prism:doi>10.5555/XMP</prism:doi><pdfx:doi>10.5555/XMP</pdfx:doi></rdf:Description></rdf:RDF></x:xmpmeta>',
    }),
  );
  expect(xmp).toMatchObject({
    status: "read",
    xmp: { title: "Synthetic & XMP title" },
    identifiers: [{ namespace: "doi", value: "10.5555/xmp" }],
  });
  expect(
    await read(
      recognitionPdf({
        xmp: '<dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">合成 &amp; 标题</dc:title>',
      }),
    ),
  ).toMatchObject({ xmp: { title: "合成 & 标题" } });
});
it("takes one first-page DOI, drops ambiguous identifiers and canonicalizes arXiv clues", async () => {
  expect(
    (await read(recognitionPdf({ pages: [[{ text: "DOI: 10.5555/HOME." }]] })))
      .identifiers,
  ).toEqual([{ namespace: "doi", value: "10.5555/home" }]);
  expect(
    (
      await read(
        recognitionPdf({
          pages: [[{ text: "DOI: 10.5555/one DOI: 10.5555/two" }]],
        }),
      )
    ).identifiers,
  ).toEqual([]);
  expect(
    (await read(recognitionPdf({ pages: [[{ text: "arXiv:2401.01234v2" }]] })))
      .identifiers,
  ).toEqual([{ namespace: "arxiv", value: "2401.01234" }]);
  expect(
    (await read(recognitionPdf({ pages: [[{ text: "hep-th/9901001v3" }]] })))
      .identifiers,
  ).toEqual([{ namespace: "arxiv", value: "hep-th/9901001" }]);
  const filename = await read(
    recognitionPdf(),
    "Synthetic directory/Paper_10.5555%2FNAME.pdf",
  );
  expect(filename.file_name).toBe("Paper_10.5555%2FNAME");
  expect(filename.identifiers).toEqual([
    { namespace: "doi", value: "10.5555/name" },
  ]);
});
it("reads a second page only for a short first page and bounds each page to 20000 characters", async () => {
  const small = await read(
    recognitionPdf({
      pages: [
        [{ text: "Short title without an identifier" }],
        [{ text: "doi:10.5555/second" }],
      ],
    }),
  );
  expect(small.pages).toHaveLength(2);
  expect(small.identifiers).toEqual([
    { namespace: "doi", value: "10.5555/second" },
  ]);
  const large = await read(
    recognitionPdf({
      pages: [
        [{ text: "x".repeat(30000), size: 0.01 }],
        [{ text: "doi:10.5555/ignored" }],
      ],
    }),
  );
  expect(large.pages).toHaveLength(1);
  expect([...large.pages[0]!.text].length).toBe(20000);
  expect(large.identifiers).toEqual([]);
  for (const count of [199, 200]) {
    const boundary = await read(
      recognitionPdf({
        pages: [
          [{ text: "X".repeat(count), size: 1 }],
          [{ text: "Second page DOI:10.5555/threshold" }],
        ],
      }),
    );
    expect([...boundary.pages[0]!.text].length).toBe(count);
    expect(boundary.pages).toHaveLength(count < 200 ? 2 : 1);
  }
});
it("selects the three largest upper-page title blocks and keeps a title without identifiers", async () => {
  const result = await read(
    recognitionPdf({
      pages: [
        [
          { text: "A synthetic prominent title", size: 26, y: 750 },
          { text: "A smaller synthetic title", size: 20, y: 690 },
          { text: "Third synthetic candidate", size: 18, y: 640 },
          { text: "A lower-page large distractor", size: 40, y: 200 },
        ],
      ],
    }),
  );
  expect(result.prominent_titles).toEqual([
    "A synthetic prominent title",
    "A smaller synthetic title",
    "Third synthetic candidate",
  ]);
  expect(result.identifiers).toEqual([]);
  expect(
    (
      await read(
        recognitionPdf({
          pages: [
            [
              { text: "A synthetic title on", size: 22, y: 750 },
              { text: "two adjacent matching lines", size: 22, y: 724 },
            ],
          ],
        }),
      )
    ).prominent_titles,
  ).toEqual(["A synthetic title on two adjacent matching lines"]);
  expect(
    normalizeRecognitionTitle("  <b>Ａ</b> \\textit{Synthetic}: Finding! "),
  ).toBe("a synthetic finding");
});
it("reports scan-only, encrypted, non-PDF and malformed inputs explicitly", async () => {
  expect(await read(recognitionPdf({ pages: [[]] }))).toMatchObject({
    status: "image-only",
    reason: null,
    unread: "image-only",
    prominent_titles: [],
    identifiers: [],
  });
  expect(
    await read(
      Buffer.from(
        Buffer.from(recognitionPdf())
          .toString()
          .replace("%%EOF", "/Encrypt 90 0 R\n%%EOF"),
      ),
    ),
  ).toMatchObject({
    status: "rejected",
    reason: "encrypted-pdf",
    unread: "encrypted-pdf",
  });
  expect(await read(Buffer.from("<html>synthetic</html>"))).toMatchObject({
    status: "rejected",
    reason: "non-pdf-file",
    unread: "invalid-pdf",
  });
  expect(await read(Buffer.from("%PDF-1.4\ninvalid"))).toMatchObject({
    status: "rejected",
    reason: "pdf-invalid",
    unread: "invalid-pdf",
  });
});
it("bounds the complete clue read by ten seconds and keeps a missing reader distinct", async () => {
  expect(
    await read(
      recognitionPdf(),
      "No reader.pdf",
      new FileClueReader(async () => undefined),
    ),
  ).toMatchObject({
    status: "unavailable",
    reason: "clues-unavailable",
    unread: "reader-unavailable",
  });
  const broken = await read(
    recognitionPdf(),
    "Broken reader.pdf",
    new FileClueReader(async () => ({
      executable: "/nonexistent/sciretriever/mutool",
      version: "1.28.6",
    })),
  );
  expect(broken).toMatchObject({
    status: "unavailable",
    reason: "clues-unavailable",
    unread: "reader-failed",
  });
  expect(
    cluesUnreadReason({ status: "unavailable", reason: "clues-unavailable" }),
  ).toBe("reader-failed");
  const start = performance.now(),
    result = await read(
      recognitionPdf(),
      "Slow.pdf",
      new FileClueReader(() => new Promise(() => {})),
    );
  expect(result).toMatchObject({
    status: "unavailable",
    reason: "clues-timeout",
    unread: "reader-timeout",
    identifiers: [],
    pages: [],
  });
  expect(performance.now() - start).toBeGreaterThanOrEqual(9900);
  expect(performance.now() - start).toBeLessThan(15_000);
}, 20_000);
