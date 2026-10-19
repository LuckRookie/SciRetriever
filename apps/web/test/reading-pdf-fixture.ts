import { createHash } from "node:crypto";
import type { Page } from "playwright";

export function syntheticReadingPdf(
  pages = 100,
  text = true,
  password = false,
) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /Outlines " + (pages * 2 + 4) + " 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const kids: number[] = [];
  for (let n = 1; n <= pages; n++) {
    const p = objects.length + 1,
      c = p + 1;
    kids.push(p);
    const content = text
      ? `BT /F1 20 Tf 60 740 Td (Synthetic research paper - page ${n}) Tj 0 -40 Td /F1 12 Tf (Page ${n}: reported findings and evidence.) Tj ET`
      : "";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${c} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${pages} >>`;
  const outline = objects.length + 1;
  objects.push(
    `<< /Type /Outlines /First ${outline + 1} 0 R /Last ${outline + 1} 0 R /Count 1 >>`,
    `<< /Title (Results) /Parent ${outline} 0 R /Dest [4 0 R /Fit] >>`,
  );
  let encryption = "";
  if (password) {
    const padding = Buffer.from(
      "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a",
      "hex",
    );
    const pad = (text: string) =>
      Buffer.concat([Buffer.from(text), padding]).subarray(0, 32);
    const md5 = (bytes: Uint8Array) => createHash("md5").update(bytes).digest();
    const rc4 = (key: Uint8Array, bytes: Uint8Array) => {
      const state = Array.from({ length: 256 }, (_, i) => i);
      let j = 0;
      for (let i = 0; i < 256; i++) {
        j = (j + state[i]! + key[i % key.length]!) % 256;
        [state[i], state[j]] = [state[j]!, state[i]!];
      }
      let i = 0;
      j = 0;
      return Buffer.from(
        bytes.map((value) => {
          i = (i + 1) % 256;
          j = (j + state[i]!) % 256;
          [state[i], state[j]] = [state[j]!, state[i]!];
          return value ^ state[(state[i]! + state[j]!) % 256]!;
        }),
      );
    };
    const owner = rc4(md5(pad("owner")).subarray(0, 5), pad("reader")),
      file = md5(Buffer.from("synthetic-locked-pdf")),
      permissions = Buffer.alloc(4);
    permissions.writeInt32LE(-4);
    const key = md5(
        Buffer.concat([pad("reader"), owner, permissions, file]),
      ).subarray(0, 5),
      user = rc4(key, padding);
    objects.push(
      `<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString("hex")}> /U <${user.toString("hex")}> /P -4 >>`,
    );
    encryption = ` /Encrypt ${objects.length} 0 R /ID [<${file.toString("hex")}> <${file.toString("hex")}>]`;
  }
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryption} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

export async function readingResourceCounts(page: Page) {
  return page.evaluate(() => {
    const counts = (
      window as unknown as { readingCounts: { workers: number; urls: number } }
    ).readingCounts;
    return {
      ...counts,
      canvases: document.querySelectorAll(".reading-pdf-page canvas").length,
    };
  });
}
export async function trackReadingResources(page: Page) {
  await page.addInitScript(() => {
    const counts = { workers: 0, urls: 0 };
    Object.assign(window, { readingCounts: counts });
    const Native = window.Worker;
    window.Worker = class extends Native {
      closed = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        counts.workers++;
      }
      override terminate() {
        if (!this.closed) counts.workers--;
        this.closed = true;
        super.terminate();
      }
    };
    const create = URL.createObjectURL,
      revoke = URL.revokeObjectURL,
      urls = new Set<string>();
    URL.createObjectURL = (data) => {
      const url = create(data);
      urls.add(url);
      counts.urls = urls.size;
      return url;
    };
    URL.revokeObjectURL = (url) => {
      urls.delete(url);
      counts.urls = urls.size;
      revoke(url);
    };
  });
}
