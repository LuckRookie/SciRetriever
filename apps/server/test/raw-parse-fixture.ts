/** Synthetic ZIP bytes only; this helper cannot make network requests. */
import type { RawParseProfile } from "@sciretriever/contracts";
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function rawParseZip(
  entries: readonly { name: string; bytes: Uint8Array }[],
): Buffer {
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

export function rawParseArchive(
  profile: RawParseProfile,
  options: {
    blocks?: unknown;
    markdown?: string;
    backend?: string;
    omitV2?: boolean;
    pageSizes?: unknown;
    resources?: readonly { name: string; bytes: Uint8Array }[];
  } = {},
) {
  const prefix = "synthetic/" + (profile === "pipeline" ? "auto" : "vlm") + "/";
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));
  return rawParseZip([
    {
      name: prefix + "synthetic.md",
      bytes: Buffer.from(
        options.markdown ?? "# Synthetic source\n\nThe yield was 67%.\n",
      ),
    },
    {
      name: prefix + "synthetic_middle.json",
      bytes: json({
        _backend:
          options.backend ?? (profile === "pipeline" ? "pipeline" : "vlm"),
        pdf_info: [{ page_idx: 0, page_size: options.pageSizes ?? [595, 842] }],
      }),
    },
    ...(options.omitV2
      ? []
      : [
          {
            name: prefix + "synthetic_content_list_v2.json",
            bytes: json(
              options.blocks ?? [
                [
                  {
                    type: "title",
                    bbox: [10, 20, 900, 80],
                    content: {
                      level: 1,
                      title_content: [
                        { type: "text", content: "Synthetic source" },
                      ],
                    },
                  },
                  {
                    type: "paragraph",
                    bbox: [10, 100, 900, 150],
                    content: {
                      paragraph_content: [
                        { type: "text", content: "The yield was 67%." },
                      ],
                    },
                  },
                ],
              ],
            ),
          },
        ]),
    ...(options.resources ?? []).map((r) => ({
      name: prefix + r.name,
      bytes: r.bytes,
    })),
    {
      name: prefix + "synthetic_model.json",
      bytes: Buffer.from("unused private output"),
    },
    {
      name: prefix + "synthetic_origin.pdf",
      bytes: Buffer.from("unused original copy"),
    },
  ]);
}
