import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ReadingMark } from "@sciretriever/contracts";
import type {
  PdfControls,
  ReaderOutlineEntry,
} from "../../../reading/contract.js";
import { readingArea } from "../../../reading/anchor.js";
import { readDocument } from "../../../reading/transport.js";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "../../data/query.js";
import {
  SPINE,
  pageParts,
  pdfParts,
  spineSegments,
  spineTicks,
  spineWindow,
  textParts,
  tipSide,
  type SpinePart,
} from "./spine.js";

const VIEW = ".reader-engine:not([hidden]) .reader-view:not([hidden])";
/** Spec 1.5: 8 px from the sheet, 16 px wide. */
const GAP = 8,
  WIDTH = 16,
  TIP_DELAY = 500;
let tipShownAt = -Infinity;

/**
 * The spine (reading-experience 1.5): beside the sheet's right edge, as tall
 * as the sheet's visible part. Its parts are the paper's top-level sections
 * by their bytes (the PDF: its pages); a window frames what shows; ticks mark
 * the marks and, while the find bar is open, its matches. Hovering a part
 * names it; pressing one goes there (a jump); dragging the window scrolls.
 * It takes no keyboard focus: the outline (O) is the keyboard's way.
 */
export function ReaderSpine({
  body,
  header,
  view,
  outline,
  pdf,
  marks,
  version,
  sha256,
  finds,
  onHover,
  onOpenMark,
  beforeJump,
  outlinePanel,
}: {
  body: HTMLElement | null;
  header: HTMLElement | null;
  view: "doc" | "pdf" | null;
  outline: readonly ReaderOutlineEntry[];
  pdf: PdfControls | null;
  marks: readonly ReadingMark[];
  /** The full text's version read, and the PDF's: the marks drawn are theirs. */
  version: string | null;
  sha256: string | null;
  /** Matches of the open find bar: byte starts, or PDF pages. */
  finds: readonly number[];
  onHover: (markId: string | null) => void;
  onOpenMark: (markId: string) => void;
  beforeJump: () => void;
  /** The outline (spec 1.6): it opens beside the spine, as the hover does. */
  outlinePanel?: ReactNode;
}) {
  const api = useApi();
  /**
   * Spec 1.5: in the PDF, each top-level section's page, from the parsed
   * text — the page of the section's first block — never the PDF's own
   * bookmarks.
   */
  const sectionPages = useQuery({
    queryKey: ["document", "spine-pages", version],
    enabled: view === "pdf" && !!version,
    staleTime: Infinity,
    retry: false,
    queryFn: async ({ signal }) => {
      const ctx = { api, signal, root: document.body, refresh: () => {} };
      const sections: {
        section_id: string;
        title: string | null;
        role?: string | null;
        level: number;
      }[] = [];
      let cursor: string | null = null;
      do {
        const page: {
          sections: readonly (typeof sections)[number][];
          next_cursor: string | null;
        } = await readDocument(ctx, "outline", {
          document_version_id: version!,
          limit: 200,
          cursor,
        });
        sections.push(...page.sections);
        cursor = page.next_cursor;
      } while (cursor);
      const top = Math.min(...sections.map((s) => s.level));
      const heads = sections.filter(
        (s) => s.level === top || s.role === "abstract",
      );
      return Promise.all(
        heads.map(async (head) => {
          const first = await readDocument(ctx, "segments", {
            document_version_id: version!,
            section_id: head.section_id,
            limit: 1,
            cursor: null,
          });
          return {
            title: head.title,
            role: head.role ?? null,
            level: head.level,
            page: first.segments[0]?.page ?? null,
          };
        }),
      );
    },
  });
  const [box, setBox] = useState<{
    left: number;
    top: number;
    height: number;
    room: number;
  } | null>(null);
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [extent, setExtent] = useState(0);
  const [tip, setTip] = useState<{ index: number; shown: boolean } | null>(
    null,
  );
  const tipTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const spine = useRef<HTMLDivElement>(null);

  // Where the sheet is on screen and what of the paper shows, once a frame.
  useLayoutEffect(() => {
    if (!body || !view) {
      setBox(null);
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const surface = body.parentElement;
      const sheet =
        view === "doc"
          ? body.querySelector<HTMLElement>(`${VIEW}[data-view="doc"]`)
          : body.querySelector<HTMLElement>(`${VIEW} .reading-pdf-pages`);
      if (!surface || !sheet) return setBox(null);
      const desk = body.getBoundingClientRect(),
        place = surface.getBoundingClientRect(),
        rect = sheet.getBoundingClientRect();
      const page =
        view === "pdf"
          ? sheet.querySelector<HTMLElement>(".reading-pdf-page")
          : null;
      const right = page ? page.getBoundingClientRect().right : rect.right;
      const top = Math.max(rect.top, desk.top),
        bottom = Math.min(rect.bottom, desk.bottom);
      const left = right + GAP - place.left;
      setBox(
        bottom - top > 2 * SPINE.pad
          ? {
              left,
              top: top - place.top,
              height: bottom - top,
              room: desk.right - (right + GAP + WIDTH),
            }
          : null,
      );
      // What shows: below the page header's rule, down to the desk's bottom.
      const area = readingArea(body, header ?? undefined),
        low = area.top,
        high = area.top + area.height;
      if (view === "doc") {
        const blocks = body.querySelectorAll<HTMLElement>(
          `${VIEW} article [data-byte-start]`,
        );
        let from: number | null = null,
          to = 0,
          last = 0;
        for (const block of blocks) {
          const end = Number(block.dataset.byteEnd);
          if (end > last) last = end;
          const r = block.getBoundingClientRect();
          if (r.bottom <= low || r.top >= high || !r.height) continue;
          from ??= Number(block.dataset.byteStart);
          to = end;
        }
        setExtent(last);
        setRange(from === null ? null : { from, to });
      } else {
        const pages = body.querySelectorAll<HTMLElement>(
          `${VIEW} .reading-pdf-page`,
        );
        let from: number | null = null,
          to = 0;
        pages.forEach((p, index) => {
          const r = p.getBoundingClientRect();
          if (r.bottom <= low || r.top >= high || !r.height) return;
          const a = Math.max(0, (low - r.top) / r.height),
            b = Math.min(1, (high - r.top) / r.height);
          from ??= index + a;
          to = index + b;
        });
        setRange(from === null ? null : { from, to });
      }
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // A size change slides the sheet (spec 6.1): follow it every frame for
    // the slide's time, so the spine moves with the sheet.
    let follow = 0;
    const resized = () => {
      const until = performance.now() + 400;
      cancelAnimationFrame(follow);
      const step = () => {
        measure();
        if (performance.now() < until) follow = requestAnimationFrame(step);
      };
      follow = requestAnimationFrame(step);
    };
    measure();
    body.addEventListener("scroll", later, { passive: true });
    const resize = new ResizeObserver(resized);
    resize.observe(body);
    const sheet = body.parentElement;
    if (sheet) resize.observe(sheet);
    const changes = new MutationObserver(later);
    changes.observe(body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(follow);
      body.removeEventListener("scroll", later);
      resize.disconnect();
      changes.disconnect();
    };
  }, [body, header, view]);
  useEffect(() => () => clearTimeout(tipTimer.current), []);

  if (!box || !view)
    return outlinePanel ? (
      <div className="reader-outline-place" style={{ left: 8, top: 8 }}>
        {outlinePanel}
      </div>
    ) : null;
  const parts: SpinePart[] =
    view === "doc"
      ? textParts(outline, extent)
      : sectionPages.data
        ? pdfParts(sectionPages.data, pdf?.total ?? 1)
        : pageParts(pdf?.total ?? 1);
  const segments = spineSegments(parts, box.height);
  const tickItems = [
    ...marks.flatMap((m) => {
      if (view === "doc")
        return m.document && m.document.document_version_id === version
          ? [
              {
                unit: m.document.start_utf8,
                kind: "mark" as const,
                id: m.mark_id,
              },
            ]
          : [];
      if (!m.pdf || m.pdf.sha256 !== sha256) return [];
      // Within its page, by the page's own height in PDF units.
      const page = body?.querySelector<HTMLElement>(
        `${VIEW} [data-pdf-page="${m.pdf.page}"]`,
      );
      const scale = Number(
        page?.style.getPropertyValue("--total-scale-factor"),
      );
      const height = page && scale > 0 ? page.offsetHeight / scale : 0;
      const ratio = height ? (m.pdf.rects[0]?.[1] ?? 0) / height : 0;
      return [
        {
          unit: m.pdf.page - 1 + Math.max(0, Math.min(1, ratio)),
          kind: "mark" as const,
          id: m.mark_id,
        },
      ];
    }),
    ...finds.map((unit) => ({
      unit: view === "pdf" ? unit - 1 + 0.5 : unit,
      kind: "find" as const,
    })),
  ];
  const ticks = spineTicks(segments, tickItems);
  const window_ = range ? spineWindow(segments, range.from, range.to) : null;
  const go = (index: number) => {
    const segment = segments[index]!;
    if (view === "pdf") {
      beforeJump();
      pdf?.go(Math.floor(segment.start) + 1);
      return;
    }
    const entry = outline.find((e) => e.start === segment.start);
    if (entry) void entry.activate();
    else if (body) {
      beforeJump();
      body.scrollTop = 0;
    }
  };
  const hover = (index: number | null) => {
    clearTimeout(tipTimer.current);
    if (index === null) return setTip(null);
    // Spec 1.5: the hint's timing of the design core — 500 ms the first time,
    // at once while another hint was just showing.
    const soon = performance.now() - tipShownAt < 1000;
    setTip({ index, shown: soon });
    if (!soon)
      tipTimer.current = setTimeout(() => {
        tipShownAt = performance.now();
        setTip({ index, shown: true });
      }, TIP_DELAY);
    else tipShownAt = performance.now();
  };
  const tipSegment = tip ? segments[tip.index] : null;
  const tipLabel = tipSegment?.label;
  const side = tipSide(box.room, 220);
  const outlineSide = tipSide(box.room, 300);
  return (
    <>
      {outlinePanel ? (
        <div
          className="reader-outline-place"
          style={{
            left:
              outlineSide === "right"
                ? box.left + WIDTH + GAP
                : Math.max(8, box.left - 300 - GAP),
            top: box.top,
            height: Math.min(box.height, 640),
          }}
        >
          {outlinePanel}
        </div>
      ) : null}
      <div
        ref={spine}
        className="reader-spine"
        aria-hidden="true"
        style={{ left: box.left, top: box.top, height: box.height }}
      >
        {segments.map((segment) => (
          <div
            key={segment.index}
            className="reader-spine-part"
            data-alt={segment.index % 2 ? true : undefined}
            data-hover={tip?.index === segment.index || undefined}
            style={{ top: segment.top, height: segment.height }}
            onPointerEnter={() => hover(segment.index)}
            onPointerLeave={() => hover(null)}
            onClick={() => go(segment.index)}
          />
        ))}
        {window_ ? (
          <div
            className="reader-spine-window"
            style={{ top: window_.top, height: window_.height }}
            onPointerDown={(event) => {
              if (event.button !== 0 || !body) return;
              event.preventDefault();
              const handle = event.currentTarget;
              handle.setPointerCapture(event.pointerId);
              const startY = event.clientY,
                startScroll = body.scrollTop,
                // The spine stands for the whole scroll height.
                ratio =
                  body.scrollHeight / Math.max(1, box.height - 2 * SPINE.pad);
              const move = (e: PointerEvent) => {
                body.scrollTop = startScroll + (e.clientY - startY) * ratio;
              };
              const up = () => {
                handle.removeEventListener("pointermove", move);
                handle.removeEventListener("pointerup", up);
                handle.removeEventListener("pointercancel", up);
              };
              handle.addEventListener("pointermove", move);
              handle.addEventListener("pointerup", up);
              handle.addEventListener("pointercancel", up);
            }}
          />
        ) : null}
        {ticks.map((tick, index) => (
          <div
            key={index}
            className="reader-spine-tick"
            data-kind={tick.kind}
            style={{ top: tick.y - 1.5 }}
            onPointerEnter={() => onHover(tick.ids[0] ?? null)}
            onPointerLeave={() => onHover(null)}
            onClick={() => {
              if (tick.ids[0]) onOpenMark(tick.ids[0]);
            }}
          />
        ))}
        {tipSegment && tip?.shown && tipLabel ? (
          <div
            className="reader-spine-tip"
            data-side={side}
            role="tooltip"
            style={{ top: tipSegment.top + tipSegment.height / 2 }}
          >
            {tipLabel}
          </div>
        ) : null}
      </div>
    </>
  );
}
