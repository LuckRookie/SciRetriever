import { readFile } from "node:fs/promises";
import type { Browser } from "playwright-core";
import type { PageRegion } from "@sciretriever/contracts";
import type { AgentImagePart } from "../agents/protocol.js";

export interface PdfPageInspection {
  readonly page: number;
  readonly kind: "text-layer" | "image-only" | "blank";
  readonly text: string;
  readonly visible_glyphs: number;
  readonly unmapped_glyphs: number;
  readonly hidden_glyphs: number;
  readonly has_graphics: boolean;
  /** Visible, horizontal text runs in viewport points; absent for hidden OCR or oversized pages. */
  readonly layout?: {
    readonly width: number;
    readonly height: number;
    readonly items: readonly {
      readonly bbox: readonly [number, number, number, number];
      readonly font_size: number;
      readonly font: string;
      readonly length: number;
    }[];
  };
}

/** Stable text-only input used by pre-layout page cache identities. */
export function pdfPageText(
  page: PdfPageInspection,
): Omit<PdfPageInspection, "layout"> {
  return {
    page: page.page,
    kind: page.kind,
    text: page.text,
    visible_glyphs: page.visible_glyphs,
    unmapped_glyphs: page.unmapped_glyphs,
    hidden_glyphs: page.hidden_glyphs,
    has_graphics: page.has_graphics,
  };
}

/** Disposable, network-denied renderer. It has no user profile, cookies or acquisition session. */
export class PdfRegionRenderer {
  private browser: Promise<Browser> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(
    private readonly executablePath?: string,
    private readonly assets = new URL("../web/reader/", import.meta.url),
  ) {}
  async close() {
    this.closed = true;
    await this.tail.catch(() => {});
    if (this.browser) await (await this.browser).close();
  }
  inspect(
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<readonly PdfPageInspection[]> {
    return this.enqueue(() =>
      this.perform(bytes, 1, null, true, signal),
    ) as Promise<readonly PdfPageInspection[]>;
  }
  render(
    bytes: Uint8Array,
    page: number,
    region: PageRegion | null,
    signal?: AbortSignal,
  ): Promise<AgentImagePart> {
    return this.enqueue(() =>
      this.perform(bytes, page, region, false, signal),
    ) as Promise<AgentImagePart>;
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.catch(() => {}).then(work);
    this.tail = run;
    return run;
  }
  private async perform(
    bytes: Uint8Array,
    pageNumber: number,
    region: PageRegion | null,
    inspect: boolean,
    signal?: AbortSignal,
  ): Promise<AgentImagePart | readonly PdfPageInspection[]> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("proofread-renderer-closed");
    if (
      bytes.length > 256 * 1024 * 1024 ||
      !Number.isSafeInteger(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > 10000
    )
      throw new Error("proofread-render-limit");
    // Playwright loads lazily so commands that never render skip it.
    this.browser ??= import("playwright-core")
      .then(({ chromium }) =>
        chromium.launch({
          headless: true,
          ...(this.executablePath
            ? { executablePath: this.executablePath }
            : {}),
          env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
        }),
      )
      .catch((error) => {
        this.browser = null;
        throw error;
      });
    const browser = await this.browser,
      context = await browser.newContext({
        serviceWorkers: "block",
        acceptDownloads: false,
      });
    const abort = () => {
      void context.close().catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      await context.route("**/*", async (route) => {
        const u = new URL(route.request().url());
        if (u.origin !== "https://pdf.sciretriever.invalid" || u.search) {
          await route.abort();
          return;
        }
        if (u.pathname === "/") {
          await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: "<!doctype html><title>Isolated PDF renderer</title>",
          });
          return;
        }
        const name = u.pathname.slice(1);
        // PDF.js reads the document in ranges, so no single protocol message
        // carries the whole file (one message is capped near 100 MB).
        const range = /^document\/(\d{1,10})-(\d{1,10})$/u.exec(name);
        if (range) {
          const start = Number(range[1]),
            end = Number(range[2]);
          if (start >= end || end > bytes.length || end - start > 16 << 20) {
            await route.abort();
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: "application/octet-stream",
            body: Buffer.from(
              bytes.buffer,
              bytes.byteOffset + start,
              end - start,
            ),
          });
          return;
        }
        if (
          !/^(?:pdf(?:\.worker)?\.mjs|(?:cmaps|standard_fonts|wasm)\/[A-Za-z0-9_.-]+)$/u.test(
            name,
          )
        ) {
          await route.abort();
          return;
        }
        try {
          await route.fulfill({
            status: 200,
            contentType: name.endsWith(".mjs")
              ? "text/javascript"
              : "application/octet-stream",
            body: await readFile(new URL(name, this.assets)),
          });
        } catch {
          await route.fulfill({ status: 404, body: "" });
        }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      await page.goto("https://pdf.sciretriever.invalid/");
      const result = await page.evaluate<
        | { png: string; width: number; height: number }
        | readonly PdfPageInspection[]
      >(`(async ({length,pageNumber,region,inspect})=>{
    const {getDocument,GlobalWorkerOptions,OPS,PDFDataRangeTransport}=await import('/pdf.mjs');GlobalWorkerOptions.workerSrc='/pdf.worker.mjs';
    const chunk=1<<20,read=async(start,end)=>{const r=await fetch('/document/'+start+'-'+end);if(!r.ok)throw new Error('proofread-render-input');return new Uint8Array(await r.arrayBuffer());};
    const transport=new PDFDataRangeTransport(length,await read(0,Math.min(length,chunk)));
    let loading;
    transport.requestDataRange=(start,end)=>{read(start,end).then(data=>transport.onDataRange(start,data),()=>loading.destroy());};
    loading=getDocument({range:transport,length,rangeChunkSize:chunk,disableAutoFetch:true,disableStream:true,isEvalSupported:false,enableXfa:false,cMapUrl:'/cmaps/',cMapPacked:true,standardFontDataUrl:'/standard_fonts/',wasmUrl:'/wasm/'});
    try{const doc=await loading.promise;
    if(inspect){
      if(doc.numPages>10000)throw new Error('proofread-page-limit');
      const pages=[];let chars=0;
      for(let n=1;n<=doc.numPages;n++){
        const p=await doc.getPage(n),ops=await p.getOperatorList(),stack=[],text=[];
        let mode=0,visible=0,hidden=0,unmapped=0,graphics=false;
        for(let i=0;i<ops.fnArray.length;i++){
          const op=ops.fnArray[i],args=ops.argsArray[i];
          if(op===OPS.save||op===OPS.paintFormXObjectBegin){stack.push(mode);continue;}
          if(op===OPS.restore||op===OPS.paintFormXObjectEnd){mode=stack.pop()??0;continue;}
          if(op===OPS.setTextRenderingMode){mode=args[0];continue;}
          if([OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject,OPS.paintImageXObjectRepeat,OPS.paintImageMaskXObjectRepeat,OPS.paintImageMaskXObjectGroup,OPS.paintInlineImageXObjectGroup,OPS.shadingFill,OPS.constructPath].includes(op))graphics=true;
          if(op!==OPS.showText)continue;
          let run='';
          for(const glyph of args[0]){
            if(typeof glyph==='number'){if(glyph<0)run+=' ';continue;}
            if((mode&3)===3){hidden++;continue;}
            visible++;
            const unicode=typeof glyph.unicode==='string'?glyph.unicode:'';
            const safe=unicode.replace(/[\\uFFFD\\p{Co}\\p{Cc}\\p{Cs}]/gu,'');
            if(!safe.trim()&&!glyph.isSpace){unmapped++;continue;}
            run+=safe;
          }
          if(run.trim())text.push(run);
        }
        let value=text.join(' '),layout;
        // TJ numeric adjustments are kerning, not word separators. PDF.js already
        // reconstructs text layout and explicit spaces for pages without hidden
        // glyphs. Keep visibility-filtered operator text for mixed OCR pages so
        // hidden text never leaks into the comparison reference.
        if(hidden===0 && visible>unmapped){
          const content=await p.getTextContent();
          const viewport=p.getViewport({scale:1}), items=[];
          if(content.items.length<=20000 && viewport.rotation % 180 === 0)for(const item of content.items){
            if(typeof item.str!=='string'||!item.str.trim()||item.dir==='ttb')continue;
            const t=item.transform, size=Math.hypot(t[2],t[3]), width=item.width;
            if(!t.every(Number.isFinite)||!Number.isFinite(width)||width<=0||size<=0||Math.abs(t[1])>0.01||Math.abs(t[2])>0.01)continue;
            const points=[[t[4],t[5]],[t[4]+width,t[5]],[t[4],t[5]+size],[t[4]+width,t[5]+size]].map(([x,y])=>viewport.convertToViewportPoint(x,y));
            const xs=points.map(q=>q[0]),ys=points.map(q=>q[1]);
            items.push({bbox:[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)],font_size:size,font:String(item.fontName??'').slice(0,128),length:item.str.length});
          }
          if(items.length)layout={width:viewport.width,height:viewport.height,items};
          value=content.items.filter(item=>typeof item.str==='string').map(item=>item.str+(item.hasEOL?'\\n':'')).join('').replace(/[\\uFFFD\\p{Co}\\p{Cc}\\p{Cs}]/gu,c=>c==='\\n'||c==='\\t'?c:'').trim();
        }
        chars+=value.length;
        if(chars>32*1024*1024)throw new Error('proofread-text-layer-limit');
        pages.push({page:n-1,kind:value.trim()?'text-layer':visible||hidden||graphics?'image-only':'blank',text:value,visible_glyphs:visible,unmapped_glyphs:unmapped,hidden_glyphs:hidden,has_graphics:graphics,...(layout?{layout}:{} )});
        p.cleanup();
      }
      return pages;
    }
    const p=await doc.getPage(pageNumber),base=p.getViewport({scale:1}),r=region??[0,0,1000,1000],margin=8;
     const bounds=[Math.max(0,r[0]-margin),Math.max(0,r[1]-margin),Math.min(1000,r[2]+margin),Math.min(1000,r[3]+margin)];
     const rawWidth=base.width*(bounds[2]-bounds[0])/1000,rawHeight=base.height*(bounds[3]-bounds[1])/1000,scale=Math.min(2,Math.sqrt(2000000/(rawWidth*rawHeight))),v=p.getViewport({scale});
     const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.ceil(rawWidth*scale));canvas.height=Math.max(1,Math.ceil(rawHeight*scale));const ctx=canvas.getContext('2d');
     await p.render({canvas,canvasContext:ctx,viewport:v,transform:[1,0,0,1,-v.width*bounds[0]/1000,-v.height*bounds[1]/1000]}).promise;
     return {png:canvas.toDataURL('image/png').split(',')[1],width:canvas.width,height:canvas.height};
    }finally{await loading.destroy();}
   })(${JSON.stringify({ length: bytes.length, pageNumber, region, inspect })})`);
      signal?.throwIfAborted();
      if (Array.isArray(result)) return result;
      if (!("png" in result)) throw new Error("proofread-render-invalid");
      return {
        media_type: "image/png",
        data: Buffer.from(result.png, "base64"),
        width: result.width,
        height: result.height,
      };
    } finally {
      signal?.removeEventListener("abort", abort);
      await context.close();
    }
  }
}
