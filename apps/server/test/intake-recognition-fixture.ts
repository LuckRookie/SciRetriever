/** Synthetic PDFs for intake clue and staging tests; no user document bytes. */
export function recognitionPdf(
  options: {
    info?: { title?: string; subject?: string; keywords?: string };
    xmp?: string;
    pages?: readonly (readonly {
      text: string;
      size?: number;
      x?: number;
      y?: number;
    }[])[];
  } = {},
): Uint8Array {
  const escaped = (s: string) => s.replace(/[\\()]/gu, (c) => `\\${c}`),
    pages = options.pages ?? [
      [{ text: "A synthetic file for intake", size: 20 }],
    ],
    objects: string[] = [
      "",
      "",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ],
    pageIds: number[] = [];
  for (const lines of pages) {
    const content = lines.length
      ? lines
          .map(
            (line, i) =>
              `BT /F1 ${line.size ?? 12} Tf ${line.x ?? 40} ${line.y ?? 750 - i * 30} Td (${escaped(line.text)}) Tj ET`,
          )
          .join("\n")
      : "0 0 100 100 re f";
    const streamId = objects.push(
        `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
      ),
      pageId = objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`,
      );
    pageIds.push(pageId);
  }
  const xmpId =
      options.xmp === undefined
        ? null
        : objects.push(
            `<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(options.xmp)} >>\nstream\n${options.xmp}\nendstream`,
          ),
    infoId = options.info
      ? objects.push(
          `<< ${Object.entries(options.info)
            .map(
              ([key, value]) =>
                `/${key[0]!.toUpperCase() + key.slice(1)} (${escaped(value)})`,
            )
            .join(" ")} >>`,
        )
      : null;
  objects[0] = `<< /Type /Catalog /Pages 2 0 R ${xmpId ? `/Metadata ${xmpId} 0 R` : ""} >>`;
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((v) => `${String(v).padStart(10, "0")} 00000 n `)
    .join(
      "\n",
    )}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${infoId ? `/Info ${infoId} 0 R` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
