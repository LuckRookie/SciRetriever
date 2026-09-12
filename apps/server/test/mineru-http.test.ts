import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parserResultSha256 } from "@sciretriever/contracts";
import { MinerUParser } from "../src/parsing/backends/mineru/http.js";
import { convertMinerUArchive } from "../src/parsing/backends/mineru/archive.js";

const source = new Uint8Array([1, 2, 3]);
const hash = createHash("sha256").update(source).digest("hex");
const markdown = new TextEncoder().encode("# parsed\n");
const markdownHash = createHash("sha256").update(markdown).digest("hex");
const provenance = {
  provenance: {
    provenance_id: "00000000-0000-0000-0000-000000000991",
    source_kind: "parser",
    source_name: "mineru-ts",
    source_record_id: null,
    observed_at: "2026-09-11T00:00:00Z",
    input_sha256: hash,
    parameters_sha256: "1".repeat(64),
  },
  parser_version: "ts-mineru-1",
  mode: null,
  model_identity: "fixture-model",
};

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries: readonly { name: string; bytes: Uint8Array }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const header = Buffer.alloc(30 + name.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(crc32(entry.bytes), 14);
    header.writeUInt32LE(entry.bytes.length, 18);
    header.writeUInt32LE(entry.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    name.copy(header, 30);
    local.push(header, Buffer.from(entry.bytes));
    const directory = Buffer.alloc(46 + name.length);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc32(entry.bytes), 16);
    directory.writeUInt32LE(entry.bytes.length, 20);
    directory.writeUInt32LE(entry.bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    name.copy(directory, 46);
    central.push(directory);
    offset += header.length + entry.bytes.length;
  }
  const body = Buffer.concat([...local, ...central]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([body, end]);
}

describe("TypeScript MinerU HTTP client", () => {
  it("sends PDF bytes to the operator service and validates the canonical output", async () => {
    const parser = new MinerUParser(
      {
        async request(url, options) {
          expect(url).toBe("http://127.0.0.1:19001/parse");
          expect(options.headers["content-type"]).toBe("application/pdf");
          expect([...options.body]).toEqual([...source]);
          const core = {
            source_asset_id: "00000000-0000-0000-0000-000000000990",
            source_sha256: hash,
            page_count: 1,
            markdown: {
              sha256: markdownHash,
              media_type: "text/markdown",
              byte_size: markdown.byteLength,
            },
            resources: [],
            provenance,
          };
          const output = {
            ...core,
            result_sha256: await parserResultSha256(core as never),
            markdown: {
              artifact: {
                sha256: markdownHash,
                media_type: "text/markdown",
                byte_size: markdown.byteLength,
              },
              base64: Buffer.from(markdown).toString("base64"),
            },
          };
          return {
            status: 200,
            headers: [["content-type", "application/json"]],
            body: new TextEncoder().encode(JSON.stringify(output)),
          };
        },
      },
      { baseUrl: "http://127.0.0.1:19001", modelIdentity: "fixture-model" },
    );
    await expect(
      parser.parse({
        source_asset_id: "00000000-0000-0000-0000-000000000990" as never,
        source_sha256: hash as never,
        media_type: "application/pdf",
        withContent: async (consume) =>
          consume(
            (async function* () {
              yield source;
            })(),
          ),
      }),
    ).resolves.toMatchObject({
      source_asset_id: "00000000-0000-0000-0000-000000000990",
      page_count: 1,
    });
  });

  it("converts a bounded MinerU ZIP archive in TypeScript and rejects unsafe entries", async () => {
    const archive = zip([
      {
        name: "document.md",
        bytes: new TextEncoder().encode(
          "# parsed\n\n![figure](images/figure.png)\n",
        ),
      },
      {
        name: "document_middle.json",
        bytes: new TextEncoder().encode(
          JSON.stringify({ _backend: "vlm", pdf_info: [{ page_idx: 0 }] }),
        ),
      },
      {
        name: "document_model.json",
        bytes: new TextEncoder().encode(JSON.stringify({ model: "fixture" })),
      },
      {
        name: "document_content_list.json",
        bytes: new TextEncoder().encode(JSON.stringify([{ page_idx: 0 }])),
      },
      {
        name: "images/figure.png",
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      },
      {
        name: "private/debug.json",
        bytes: new TextEncoder().encode("ignored"),
      },
    ]);
    const converted = await convertMinerUArchive(archive, {
      source_asset_id: "00000000-0000-0000-0000-000000000990",
      source_sha256: hash,
      model_identity: "fixture-model",
      provenance_id: "00000000-0000-0000-0000-000000000992",
    });
    expect(converted.result).toMatchObject({
      page_count: 1,
      resources: [
        {
          reference: "images/figure.png",
          artifact: { media_type: "image/png" },
        },
      ],
    });
    expect(Buffer.from(converted.markdown.bytes)).toEqual(
      Buffer.from("# parsed\n\n![figure](images/figure.png)\n"),
    );
    const unsafe = zip([
      { name: "../document.md", bytes: new TextEncoder().encode("# bad") },
    ]);
    await expect(
      convertMinerUArchive(unsafe, {
        source_asset_id: "00000000-0000-0000-0000-000000000990",
        source_sha256: hash,
        model_identity: "fixture-model",
      }),
    ).rejects.toBeDefined();

    for (const rejected of [
      zip([
        ...[
          ["document.md", "# parsed\n"],
          [
            "document_middle.json",
            '{"_backend":"vlm","pdf_info":[{"page_idx":0}]}',
          ],
          ["document_model.json", "{}"],
          ["document_content_list.json", '[{"page_idx":0}]'],
        ].map(([name, value]) => ({
          name: name!,
          bytes: new TextEncoder().encode(value),
        })),
        { name: "Images/Figure.png", bytes: new Uint8Array([1]) },
        { name: "images/figure.png", bytes: new Uint8Array([2]) },
      ]),
      zip([
        {
          name: "bundle/%252e%252e/private.txt",
          bytes: new TextEncoder().encode("private"),
        },
      ]),
      zip([
        { name: "document.md", bytes: markdown },
        {
          name: "document_middle.json",
          bytes: new TextEncoder().encode(
            JSON.stringify({ _backend: "other", pdf_info: [{ page_idx: 0 }] }),
          ),
        },
        { name: "document_model.json", bytes: new TextEncoder().encode("{}") },
        {
          name: "document_content_list.json",
          bytes: new TextEncoder().encode('[{"page_idx":0}]'),
        },
      ]),
    ])
      await expect(
        convertMinerUArchive(rejected, {
          source_asset_id: "00000000-0000-0000-0000-000000000990",
          source_sha256: hash,
          model_identity: "fixture-model",
        }),
      ).rejects.toMatchObject({ code: "parser-structure" });

    const corrupt = Buffer.from(archive);
    const payloadOffset = 30 + Buffer.byteLength("document.md");
    corrupt[payloadOffset] = corrupt[payloadOffset]! ^ 0xff;
    await expect(
      convertMinerUArchive(corrupt, {
        source_asset_id: "00000000-0000-0000-0000-000000000990",
        source_sha256: hash,
        model_identity: "fixture-model",
      }),
    ).rejects.toMatchObject({ code: "parser-structure" });
  });
});
