import type { ReadingLayer } from "./model.js";

/**
 * Going from one layer to another (reading-experience 3.3.1): the new leaf
 * is set as it will stand, and what is on both leaves goes from its old
 * place to its new one. A thing is the same thing on both leaves when it
 * carries the same `data-f`.
 *
 * 全文 → 脉络: the text no note stands on pales and is gone; the sentences a
 * note stands on draw together under their note; the note comes in from the
 * margin, out of the commentator's red into ink, and takes the head of them.
 * Back again, each goes the other way. 概览 ↔ 脉络: the main notes keep their
 * order and go together, the rest come in around them.
 *
 * The whole change is a function of one number t (0 → 1). Time drives it
 * after a press; the wheel with Alt held moves it by hand, and it settles to
 * the nearer end when the hand stops.
 */
export interface LayerChange {
  /** By hand: `toward` 1 is nearer (全文), -1 farther; `px` of wheel travel. */
  push(toward: number, px: number): void;
  /** The hand stopped: on to the new leaf past a third of the way, else back. */
  settle(): void;
  /** Ends at once on the new leaf. */
  finish(): void;
}
export interface LayerChangeRequest {
  sheet: HTMLElement;
  /** A fixed layer over the page for the moving copies. */
  stage: HTMLElement;
  body: HTMLElement;
  from: ReadingLayer;
  to: ReadingLayer;
  /** The note being read; it stays at its height. */
  point: number | null;
  primary: readonly number[];
  third(): number;
  /** Set when the wheel drives the change: the direction that began it. */
  manual?: number;
  /** Shows a layer: renders it and places its margin. */
  show(layer: ReadingLayer): void;
  /** The element to arrive at on the new leaf when the note has no shared piece. */
  target(): Element | null;
  /** The element carrying a piece's key on the leaf now shown. */
  anchor(key: string): HTMLElement | null;
  done(arrived: boolean): void;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, t: number) => {
  const x = clamp((t - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
};
const ease = (x: number) => 1 - Math.pow(1 - x, 3);
const COPY = [
  "color",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  "mixBlendMode",
  "filter",
] as const;
/** What shows a layer: the column, the margin, the strokes. */
const SHOWN = ".reading-article, .rl-leaf, .rl-side, .rl-strokes";
const BLOCK = "p, li, h1, h2, h3, h4, h5, h6, td, figcaption, dd";

interface Ghost {
  key: string;
  el: HTMLElement;
  /** Every element of the piece (a sentence may be several spans). */
  all: HTMLElement[];
  r: DOMRect;
  g: HTMLElement;
  inline: boolean;
  fs: number;
  text: string;
  color: string;
}
/**
 * A copy of a piece, set where the piece is on the screen. A piece that runs
 * in a paragraph's lines (a sentence) is copied as its whole paragraph with
 * everything but itself unseen, so its words keep their lines.
 */
function ghostOf(el: HTMLElement, key: string): Ghost {
  const cs = getComputedStyle(el),
    inline = cs.display === "inline";
  const r = el.getBoundingClientRect();
  let g: HTMLElement,
    box: DOMRect = r,
    all = [el],
    text = el.textContent ?? "";
  if (inline) {
    const p = el.closest<HTMLElement>(BLOCK) ?? el.parentElement!;
    box = p.getBoundingClientRect();
    if (el.dataset.ev)
      all = [
        ...p.querySelectorAll<HTMLElement>(
          `.rl-ev[data-ev="${el.dataset.ev}"]`,
        ),
      ];
    text = all.map((x) => x.textContent ?? "").join("");
    for (const x of all) x.setAttribute("data-keep", "1");
    g = p.cloneNode(true) as HTMLElement;
    for (const x of all) x.removeAttribute("data-keep");
    g.classList.add("rl-ghost-p");
    const pcs = getComputedStyle(p);
    for (const k of COPY) g.style[k] = pcs[k];
  } else {
    g = el.cloneNode(true) as HTMLElement;
    for (const k of COPY) g.style[k] = cs[k];
  }
  g.removeAttribute("data-f");
  g.removeAttribute("id");
  for (const x of g.querySelectorAll("[data-f], [id]")) {
    x.removeAttribute("data-f");
    x.removeAttribute("id");
  }
  g.classList.add("rl-ghost");
  Object.assign(g.style, {
    position: "fixed",
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: el.tagName === "IMG" ? `${box.height}px` : "",
    margin: "0",
    right: "auto",
    bottom: "auto",
    transformOrigin: `${r.left - box.left}px ${r.top - box.top}px`,
  });
  return {
    key,
    el,
    all,
    r,
    g,
    inline,
    fs: parseFloat(cs.fontSize) || 16,
    text,
    color: cs.color,
  };
}

export function changeLayer(q: LayerChangeRequest): LayerChange {
  const { sheet, stage, body } = q;
  const area = body.getBoundingClientRect();
  const y0 = body.scrollTop;
  const shown = () =>
    [...sheet.querySelectorAll<HTMLElement>(`:scope > :is(${SHOWN})`)].filter(
      (n) => !n.hidden && n.getClientRects().length,
    );
  const pieces = () => {
    const out = new Map<string, HTMLElement>();
    for (const root of shown())
      for (const el of root.querySelectorAll<HTMLElement>("[data-f]")) {
        const r = el.getBoundingClientRect();
        if (!r.width || r.bottom < area.top - 400 || r.top > area.bottom + 400)
          continue;
        if (!out.has(el.dataset.f!)) out.set(el.dataset.f!, el);
      }
    return out;
  };
  // The old leaf, as it stands: copies of what is near the window, kept where
  // they are while the new leaf is set under them.
  const sheetBox = sheet.getBoundingClientRect();
  const before = pieces(),
    src = new Map<string, Ghost>();
  for (const [key, el] of before) src.set(key, ghostOf(el, key));
  const old = document.createElement("div");
  old.className = "rl-old";
  const inlineKeys = new Set(
    [...src.values()].filter((s) => s.inline).map((s) => s.key),
  );
  for (const root of shown()) {
    const box = root.getBoundingClientRect();
    const copy = root.cloneNode(false) as HTMLElement;
    copy.removeAttribute("id");
    const kids = [...root.children].filter((child) => {
      const r = child.getBoundingClientRect();
      return (
        r.height > 0 && r.bottom > area.top - 600 && r.top < area.bottom + 600
      );
    });
    for (const child of kids) copy.append(child.cloneNode(true));
    const firstTop = kids[0]?.getBoundingClientRect().top ?? box.top;
    // The strokes are placed from the sheet, through a container without a box.
    if (root.classList.contains("rl-strokes")) {
      Object.assign(copy.style, { position: "absolute", left: "0", top: "0" });
      old.append(copy);
      continue;
    }
    const flow = getComputedStyle(root).position !== "absolute";
    Object.assign(copy.style, {
      position: "absolute",
      left: `${box.left - sheetBox.left}px`,
      top: `${(flow ? firstTop : box.top) - sheetBox.top}px`,
      width: `${box.width}px`,
      height: flow ? "" : `${box.height}px`,
      margin: "0",
      padding: "0",
      minHeight: "0",
    });
    // What stands in the margin keeps its own tops; they were measured from the sheet.
    old.append(copy);
    if (flow && kids[0] && copy.firstElementChild) {
      // Margins collapse differently in the copy: put its first child where the original is.
      sheet.append(old);
      const delta =
        firstTop - copy.firstElementChild.getBoundingClientRect().top;
      copy.style.top = `${parseFloat(copy.style.top) + delta}px`;
    }
  }
  for (const x of old.querySelectorAll("[id]")) x.removeAttribute("id");
  old.remove();

  // The new leaf; the note being read (or the place asked for) stays at its height.
  const crossing = q.from === "full" || q.to === "full";
  let point = q.point;
  if (
    q.from === "overview" &&
    point === null &&
    src.has(`note:${q.primary[0]}`)
  )
    point = q.primary[0] ?? null;
  if (q.to === "overview" && point !== null && !q.primary.includes(point)) {
    const n = point;
    point = q.primary.reduce(
      (best, p) => (Math.abs(p - n) < Math.abs(best - n) ? p : best),
      q.primary[0] ?? n,
    );
  }
  const anchorKey =
    point === null
      ? undefined
      : [`note:${point}`, `no:${point}`].find((k) => src.has(k));
  q.show(q.to);
  let yTo = 0;
  const anchorEl = anchorKey ? q.anchor(anchorKey) : null;
  const target = q.target();
  if (anchorKey && anchorEl)
    yTo =
      anchorEl.getBoundingClientRect().top +
      body.scrollTop -
      src.get(anchorKey)!.r.top;
  else if (target)
    yTo = target.getBoundingClientRect().top + body.scrollTop - q.third();
  body.scrollTop = Math.max(0, yTo);
  const moved = body.scrollTop - y0;
  old.style.transform = `translateY(${moved}px)`;

  const after = pieces();
  interface Pair {
    a: Ghost;
    b: Ghost;
    dx: number;
    dy: number;
    s: number;
    same: boolean;
    wy: [number, number];
    wx: [number, number];
    dyN: number;
  }
  const pairs: Pair[] = [];
  for (const [key, a] of src) {
    const el = after.get(key);
    if (
      !el ||
      key.startsWith("fig:") ||
      (crossing && /^(kind|rel):/u.test(key))
    )
      continue;
    const b = ghostOf(el, key),
      dx = b.r.left - a.r.left,
      dy = b.r.top - a.r.top;
    const same =
      a.text === b.text &&
      Math.abs(a.r.width - b.r.width) < 1.5 &&
      Math.abs(a.r.height - b.r.height) < 1.5 &&
      a.color === b.color;
    const s = el.tagName === "IMG" ? b.r.width / a.r.width : b.fs / a.fs;
    pairs.push({ a, b, dx, dy, s, same, wy: [0, 1], wx: [0, 1], dyN: dy });
  }
  // In what order things go, so that nothing passes over anything else.
  // Between 全文 and the others the notes cross from the margin into the
  // column: leaving 全文, the sentences draw together first and leave each
  // note its place, then the notes come in; going to 全文, the notes go out
  // to the margin first, then the sentences take their places. Between 概览
  // and 脉络 everything keeps its order down the page and goes together.
  // What is only on the old leaf pales first; what is only on the new leaf
  // comes in last, around the things that have arrived.
  type Span = [number, number];
  const W: { out: Span; move: Span; across: Span; in: Span } = !crossing
    ? { out: [0, 0.45], move: [0.08, 0.9], across: [0.08, 0.9], in: [0.5, 1] }
    : q.from === "full"
      ? {
          out: [0, 0.34],
          move: [0.14, 0.62],
          across: [0.56, 0.97],
          in: [0.62, 1],
        }
      : {
          out: [0, 0.36],
          across: [0.03, 0.44],
          move: [0.34, 0.8],
          in: [0.74, 1],
        };
  for (const p of pairs) {
    const marginal = crossing && /^(note|no|kind|rel):/u.test(p.a.key);
    p.wy = W.move;
    p.wx = marginal ? W.across : W.move;
    // A note's number rides with its note.
    const note =
      crossing && p.a.key.startsWith("no:")
        ? pairs.find((x) => x.a.key === `note:${p.a.key.slice(3)}`)
        : undefined;
    p.dyN = note ? note.dy : p.dy;
  }
  const shared = new Set(pairs.map((p) => p.a.key));
  for (const x of old.querySelectorAll<HTMLElement>("[data-f]")) {
    const key = x.dataset.f!;
    if (!shared.has(key)) continue;
    if (inlineKeys.has(key)) {
      const ev = x.dataset.ev;
      const all = ev
        ? old.querySelectorAll<HTMLElement>(`.rl-ev[data-ev="${ev}"]`)
        : [x];
      for (const y of all) y.classList.add("rl-away");
    } else x.classList.add("rl-gone");
  }
  for (const p of pairs) {
    for (const x of p.b.all)
      x.classList.add(p.b.inline ? "rl-away" : "rl-gone");
    stage.append(p.a.g);
    if (!p.same) stage.append(p.b.g);
  }
  // The copies stay inside the desk, under the page header.
  stage.style.clipPath = `inset(${area.top}px ${innerWidth - area.right}px ${innerHeight - area.bottom}px ${area.left}px)`;
  sheet.append(old);
  const incoming = shown().filter((n) => !old.contains(n));
  const apply = (t: number) => {
    old.style.opacity = String(1 - smooth(W.out[0], W.out[1], t));
    const coming = String(smooth(W.in[0], W.in[1], t));
    for (const n of incoming) n.style.opacity = coming;
    for (const p of pairs) {
      const x = ease(clamp((t - p.wx[0]) / (p.wx[1] - p.wx[0]), 0, 1)),
        y = ease(clamp((t - p.wy[0]) / (p.wy[1] - p.wy[0]), 0, 1));
      const ty = p.dyN * y + (p.dy - p.dyN) * x;
      if (p.same) {
        p.a.g.style.transform = `translate(${p.dx * x}px, ${ty}px)`;
        continue;
      }
      p.a.g.style.transform = `translate(${p.dx * x}px, ${ty}px) scale(${1 + (p.s - 1) * x})`;
      p.a.g.style.opacity = String(1 - smooth(0.05, 0.45, x));
      p.b.g.style.transform = `translate(${-p.dx * (1 - x)}px, ${ty - p.dy}px) scale(${1 / p.s + (1 - 1 / p.s) * x})`;
      p.b.g.style.opacity = String(smooth(0.4, 0.95, x));
    }
  };
  const clear = () => {
    stage.replaceChildren();
    stage.style.clipPath = "";
    old.remove();
    for (const n of incoming) n.style.opacity = "";
    for (const x of sheet.querySelectorAll(".rl-gone, .rl-away"))
      x.classList.remove("rl-gone", "rl-away");
  };
  let t = 0,
    raf = 0,
    ended = false;
  const direction = q.manual ?? 1;
  const end = (arrived: boolean) => {
    if (ended) return;
    ended = true;
    cancelAnimationFrame(raf);
    clear();
    if (!arrived) {
      // The hand let go before a third of the way: the old leaf again, where it was.
      q.show(q.from);
      body.scrollTop = y0;
    }
    q.done(arrived);
  };
  const run = (goal: number, ms: number) => {
    cancelAnimationFrame(raf);
    const t0 = t,
      c0 = performance.now();
    const step = (now: number) => {
      if (ended) return;
      const u = clamp((now - c0) / ms, 0, 1);
      t = t0 + (goal - t0) * u;
      apply(t);
      if (u < 1) raf = requestAnimationFrame(step);
      else end(goal === 1);
    };
    raf = requestAnimationFrame(step);
  };
  apply(0);
  if (q.manual === undefined) run(1, crossing ? 760 : 620);
  return {
    push(toward, px) {
      if (ended) return;
      cancelAnimationFrame(raf);
      t = clamp(t + ((toward === direction ? 1 : -1) * px) / 520, 0, 1);
      apply(t);
    },
    settle() {
      if (!ended) run(t > 0.3 ? 1 : 0, 260);
    },
    finish() {
      if (ended) return;
      apply(1);
      end(true);
    },
  };
}
