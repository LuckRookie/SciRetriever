import { canonicalJsonBytes, sha256 } from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { FileStore } from "../storage/files/store.js";
import type { PdfRegionRenderer } from "../browser/pdf-region.js";
import { PAGE_IMAGE_METHOD, type MupdfPageRenderer } from "./mupdf.js";
import type { PdfPages, ProofreadCache } from "./contract.js";
// Archived work records this identity, so it names the page classification and
// image geometry, not the image engine (which only keys the image cache).
export const PDF_PAGES_METHOD =
  "pdfjs-6.4.299:visible-layout-v2:margin8:scale2:pixels2000000";
export function pdfPages(
  database: SqliteWorker,
  files: FileStore,
  cache: ProofreadCache,
  renderer: () => Promise<PdfRegionRenderer>,
  images: () => Promise<MupdfPageRenderer>,
): PdfPages {
  const read = async (id: string, hash: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const asset = await database.getAsset(id);
    if (
      !asset ||
      asset.sha256 !== hash ||
      asset.media_type !== "application/pdf"
    )
      throw new Error("proofread-image-input-stale");
    return files.withVerified(
      asset.path,
      {
        sha256: asset.sha256,
        byte_size: asset.size_bytes,
        media_type: asset.media_type,
      },
      async (chunks) => {
        const parts: Uint8Array[] = [];
        for await (const p of chunks) {
          signal?.throwIfAborted();
          parts.push(p);
        }
        return Buffer.concat(parts);
      },
      { maxBytes: 256 * 1024 * 1024, ...(signal ? { signal } : {}) },
    );
  };
  return {
    method: PDF_PAGES_METHOD,
    async inspect(id, hash, signal) {
      return (await renderer()).inspect(await read(id, hash, signal), signal);
    },
    async image(id, hash, page, region, signal) {
      // Verify the asset identity and bytes even for a cache hit.
      const bytes = await read(id, hash, signal),
        key = await sha256(
          canonicalJsonBytes({ method: PAGE_IMAGE_METHOD, hash, page, region }),
        );
      const old = await cache.read(key, signal);
      if (old) {
        const data = Buffer.from(old.bytes);
        if (
          old.media_type !== "image/png" ||
          data.length < 24 ||
          data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
        )
          throw new Error("proofread-image-integrity");
        return {
          media_type: "image/png",
          data,
          width: data.readUInt32BE(16),
          height: data.readUInt32BE(20),
        };
      }
      const image = await (
        await images()
      ).render(bytes, hash, page, region, signal);
      await cache.save(key, image.data, image.media_type, signal);
      return image;
    },
  };
}
