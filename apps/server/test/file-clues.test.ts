import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileStore } from "../src/storage/files/store.js";
import {
  cluesUnreadReason,
  FILE_CLUE_SCRIPT,
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

/** Runs the clue script itself under the reader's limits, for what FileClues does not expose. */
async function runClueScript(bytes: Uint8Array) {
  const found = await runtime(),
    directory = await mkdtemp(join(tmpdir(), "sciretriever-clue-script-"));
  try {
    await writeFile(join(directory, "read.js"), FILE_CLUE_SCRIPT);
    await writeFile(join(directory, "input.pdf"), bytes);
    const result = spawnSync(
      "prlimit",
      [
        "--as=536870912",
        "--cpu=10",
        "--",
        found.executable,
        "run",
        join(directory, "read.js"),
        join(directory, "input.pdf"),
      ],
      { encoding: "latin1", timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
    );
    expect(result.status, result.stderr).toBe(0);
    const json = Buffer.from(
      result.stdout.trim().split("\n").at(-1)!,
      "latin1",
    ).toString("utf8");
    return JSON.parse(json) as {
      xmp: string;
      pages: { text: string }[];
      restore_passes: number;
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A first page whose simple font has a custom encoding, no ToUnicode map and
 * glyph names of a letter and the decimal character code (C84 for "T"), as
 * some typesetting systems wrote them. Codes start at 1, so tab, line feed and
 * carriage return codes occur too; words are placed apart, so MuPDF inserts
 * the spaces between them.
 */
function glyphNamePdf(
  lines: readonly { text: string; size: number; y: number }[],
) {
  const codes = new Map<string, number>();
  for (const { text } of lines)
    for (const c of text.replace(/ /gu, ""))
      if (!codes.has(c)) codes.set(c, codes.size + 1);
  const hex = (word: string) =>
    [...word].map((c) => codes.get(c)!.toString(16).padStart(2, "0")).join("");
  const content = lines
    .flatMap(({ text, size, y }) => {
      let x = 40;
      return text.split(" ").map((word) => {
        const op = `BT /F1 ${size} Tf ${x} ${y} Td <${hex(word)}> Tj ET`;
        x += (word.length * 0.5 + 0.6) * size;
        return op;
      });
    })
    .join("\n");
  const differences = [...codes.keys()]
    .map((c) => `/C${c.charCodeAt(0)}`)
    .join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    `<< /Type /Font /Subtype /Type1 /BaseFont /SYNTHE+GlyphNameSerif /FirstChar 1 /LastChar ${codes.size} /Widths [${Array(codes.size).fill(500).join(" ")}] /Encoding << /Type /Encoding /Differences [1 ${differences}] >> >>`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((v) => `${String(v).padStart(10, "0")} 00000 n `)
    .join(
      "\n",
    )}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

it("restores first-page characters from glyph names of a letter and the character code, and only then reads the page again", async () => {
  const title = "Synthetic Restored Glyph Title";
  const bytes = glyphNamePdf([
    { text: title, size: 20, y: 720 },
    { text: "Journal of Synthetic Encodings 12 (2001) 34-56", size: 9, y: 690 },
    { text: "doi 10.5555/restored.1", size: 9, y: 670 },
  ]);
  const found = await runtime(),
    directory = await mkdtemp(join(tmpdir(), "sciretriever-glyph-plain-"));
  try {
    await writeFile(
      join(directory, "plain.js"),
      "print(Document.openDocument(scriptArgs[0]).loadPage(0).toStructuredText().asText());",
    );
    await writeFile(join(directory, "input.pdf"), bytes);
    const plain = spawnSync(
      found.executable,
      ["run", join(directory, "plain.js"), join(directory, "input.pdf")],
      { encoding: "utf8", timeout: 20_000 },
    ).stdout.replace(/\s+/gu, "");
    // Without the restoration MuPDF names none of these characters.
    expect(plain.length).toBeGreaterThan(40);
    expect([...plain].every((c) => c === "�")).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const clues = await read(bytes);
  expect(clues).toMatchObject({
    status: "read",
    identifiers: [{ namespace: "doi", value: "10.5555/restored.1" }],
  });
  expect(clues.prominent_titles[0]).toBe(title);
  expect(clues.pages[0]!.text).toContain(title);
  expect(clues.pages[0]!.text).toContain("(2001) 34-56");
  expect(clues.pages[0]!.text).not.toContain("�");
  expect((await runClueScript(bytes)).restore_passes).toBe(2);
  // An ordinary first page is read once.
  const ordinary = await runClueScript(
    recognitionPdf({
      pages: [[{ text: "An ordinary synthetic title", size: 20 }]],
    }),
  );
  expect(ordinary.restore_passes).toBe(0);
  expect(ordinary.pages[0]!.text).toContain("An ordinary synthetic title");
});

it("reads a 300 KB XMP packet within 512 MiB and returns its first 262144 bytes unchanged", async () => {
  const head =
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Large XMP título</rdf:li></rdf:Alt></dc:title><prism:doi>10.5555/LARGE</prism:doi>';
  const filler = Array.from(
    { length: 6000 },
    (_, i) =>
      `<!-- padding ${String(i).padStart(5, "0")} çé ${"x".repeat(30)} -->\n`,
  ).join("");
  const xmp = `${head}${filler}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  expect(Buffer.byteLength(xmp)).toBeGreaterThan(300_000);
  const bytes = recognitionPdf({ xmp });
  const output = await runClueScript(bytes);
  expect(output.xmp).toBe(
    Buffer.from(xmp, "utf8").subarray(0, 262144).toString("latin1"),
  );
  expect(await read(bytes)).toMatchObject({
    status: "read",
    xmp: { title: "Large XMP título", dois: ["10.5555/LARGE"] },
    identifiers: [{ namespace: "doi", value: "10.5555/large" }],
  });
});
