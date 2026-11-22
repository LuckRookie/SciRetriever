import { useEffect, useRef, useState } from "react";
import {
  getDocument,
  PDFWorker,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { parsePageRegion, type PageRegion } from "@sciretriever/contracts";
import { Button } from "../../components/index.js";
import { useApi } from "../../data/query.js";
import { readPdfBytes } from "../../../reading/pdf-bytes.js";
import { readDocument } from "../../../reading/transport.js";
import { errorMessage } from "../../strings.js";
/** Disposable PDF.js crop from the verified original PDF; never server screenshots or model calls. */
export function RegionPreview({
  literature,
  asset,
  hash,
  page,
  region,
}: {
  literature: string;
  asset: string;
  hash: string;
  page: number;
  region: PageRegion | null;
}) {
  const regionKey = JSON.stringify(region);
  const api = useApi(),
    canvas = useRef<HTMLCanvasElement>(null),
    [error, setError] = useState("");
  useEffect(() => {
    setError("");
    const abort = new AbortController();
    let worker: PDFWorker | undefined,
      port: Worker | undefined,
      loading: ReturnType<typeof getDocument> | undefined,
      task: RenderTask | undefined;
    const target = canvas.current!;
    void (async () => {
      const context = {
        api,
        signal: abort.signal,
        root: target,
        refresh: () => {},
      };
      const receipt = await readDocument(context, "material", {
        literature_id: literature,
        asset_id: asset,
      });
      if (
        receipt.evidence.target_kind !== "material" ||
        receipt.evidence.material.asset_sha256 !== hash
      )
        throw new Error("PDF 区域与固定材料不匹配");
      const bytes = await readPdfBytes(context, receipt.evidence.material);
      abort.signal.throwIfAborted();
      port = new Worker("/reader/pdf.worker.mjs", { type: "module" });
      worker = PDFWorker.create({ port });
      loading = getDocument({
        data: bytes,
        worker,
        enableXfa: false,
        cMapUrl: "/reader/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/reader/standard_fonts/",
        wasmUrl: "/reader/wasm/",
      });
      const pdf = await loading.promise,
        source = await pdf.getPage(page);
      abort.signal.throwIfAborted();
      const bounds =
          regionKey !== "null"
            ? parsePageRegion(JSON.parse(regionKey))
            : [0, 0, 1000, 1000],
        viewport = source.getViewport({ scale: 1.5 });
      const x = (viewport.width * bounds[0]!) / 1000,
        y = (viewport.height * bounds[1]!) / 1000,
        width = Math.max(
          1,
          (viewport.width * (bounds[2]! - bounds[0]!)) / 1000,
        ),
        height = Math.max(
          1,
          (viewport.height * (bounds[3]! - bounds[1]!)) / 1000,
        );
      target.width = Math.ceil(width);
      target.height = Math.ceil(height);
      const drawing = target.getContext("2d");
      if (!drawing) throw new Error("无法绘制 PDF 区域");
      task = source.render({
        canvas: target,
        canvasContext: drawing,
        viewport,
        transform: [1, 0, 0, 1, -x, -y],
      });
      await task.promise;
      source.cleanup();
    })().catch((e) => {
      if (!abort.signal.aborted) setError(errorMessage(e));
    });
    return () => {
      abort.abort();
      task?.cancel();
      void loading?.destroy().catch(() => {});
      worker?.destroy();
      port?.terminate();
      target.width = target.height = 0;
    };
  }, [api, literature, asset, hash, page, regionKey]);
  return (
    <figure className="archive-region">
      <figcaption>
        原始 PDF · 第 {page} 页{region ? " · 对应区域" : " · 仅页级定位"}
      </figcaption>
      {error ? <p role="alert">{error}</p> : null}
      <canvas
        ref={canvas}
        aria-label="对应原始 PDF 区域"
        style={{ maxWidth: "100%", height: "auto" }}
      />
    </figure>
  );
}

export function RegionToggle(props: Parameters<typeof RegionPreview>[0]) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button aria-expanded={open} onPress={() => setOpen((v) => !v)}>
        {open ? "收起 PDF 区域" : "查看原始 PDF 区域"}
      </Button>
      {open ? <RegionPreview {...props} /> : null}
    </div>
  );
}
