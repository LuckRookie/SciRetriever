import { readFileSync } from "node:fs";
import type { Page, Route } from "playwright";

/**
 * A paper with reading layers (technical 04 §10.7, ADR 0069) on served
 * replies, the way `stored-translation.ts` serves a stored translation:
 * `describe` says the layers' state, `document-layers` gives the 提要 and
 * the points with their evidence, and `document-translation` the paper's
 * translation. Evidence is found in the version's own text (read through
 * `document-slice`), so its UTF-8 ranges are the version's.
 */
export interface FixtureEvidence {
  /** Words of one paragraph, as written there. */
  text: string;
  /** The same words in the paragraph's translation. */
  zh?: string;
}
export interface FixturePoint {
  /** The heading of its section, as in the text (without “#”). */
  section: string | null;
  statement: string;
  zh: string;
  terms: readonly (readonly [string, string])[];
  evidence: readonly FixtureEvidence[];
}
export interface FixtureDigest {
  text: string | null;
  zh: string | null;
  notGiven?: string;
  terms: readonly (readonly [string, string])[];
  /** Paragraphs it rests on: a few words of each. */
  units: readonly string[];
}
export interface FixturePaper {
  text: string;
  /** Translation by paragraph (and heading) text. */
  zh: Readonly<Record<string, string>>;
  points: readonly FixturePoint[];
  digest: readonly [FixtureDigest, FixtureDigest, FixtureDigest];
}

const P = (s: string) => s.replace(/\s+/gu, " ").trim();
/**
 * A synthetic paper (no real paper's text in the repository): three
 * sections, paragraphs long enough to wrap, evidence that starts and ends
 * mid-line, a sentence two points cite, and a translation of all of it.
 */
export function syntheticPaper(): FixturePaper {
  const paragraphs = {
    a1: P(
      `Nitrogen-rich salts store energy in many N–N and C–N bonds, and their thermal behaviour decides whether they can be handled at all. Earlier reports measured only the onset temperature. In this work we record the whole decomposition curve of six triazole salts and compare the heat released with the computed values. The salts were prepared in two steps from commercial precursors.`,
    ),
    a2: P(
      `The six salts share one anion and differ in the cation, which lets the cation's hydrogen bonding be compared directly. Crystal densities range from 1.71 to 1.86 g·cm⁻³. Denser salts are expected to release more energy per volume, but they are also more sensitive to impact. Whether density and stability can be raised together is the question this study asks.`,
    ),
    b1: P(
      `Thermogravimetric analysis showed a single sharp mass loss for four salts and two overlapping steps for the other two. The onset temperatures lie between 196 and 248 °C at a heating rate of 5 K·min⁻¹. The two salts with overlapping steps lose water first, which shows that their lattice holds solvent. After drying at 80 °C under vacuum the first step disappears.`,
    ),
    b2: P(
      `Differential scanning calorimetry gave decomposition enthalpies from 1.9 to 2.6 kJ·g⁻¹. The measured values are on average 12 % below the computed ones, and the gap grows with the cation's size. A larger cation therefore stores less of its computed energy in practice. Kissinger analysis at four heating rates gave activation energies between 138 and 171 kJ·mol⁻¹.`,
    ),
    b3: P(
      `Impact sensitivities were measured with a drop hammer and range from 8 to more than 40 J. The two most stable salts both form a three-dimensional hydrogen-bond network. In these salts each cation donates four hydrogen bonds to neighbouring anions. Salts with layered networks are markedly more sensitive, although their densities are similar.`,
    ),
    c1: P(
      `Hydrogen-bond networks, not density alone, decide the stability of these salts. A three-dimensional network raises the onset temperature by about 40 °C and lowers the impact sensitivity fivefold. The computed enthalpies overestimate the energy released, so the measured values should be used in further design. Long-term ageing was not studied and remains open.`,
    ),
  };
  const zh: Record<string, string> = {
    [paragraphs.a1]:
      "富氮盐在大量 N–N 与 C–N 键中储存能量，它们的热行为决定了能否安全操作。此前的报道只测定了起始温度。本工作记录了六种三唑盐的完整分解曲线，并把放热量与计算值作了比较。这些盐由市售原料分两步制得。",
    [paragraphs.a2]:
      "六种盐的阴离子相同、阳离子不同，因此可以直接比较阳离子的氢键作用。晶体密度在 1.71 到 1.86 g·cm⁻³ 之间。密度较大的盐单位体积放出的能量预计更多，但对撞击也更敏感。密度与稳定性能否同时提高，正是本研究要回答的问题。",
    [paragraphs.b1]:
      "热重分析显示，四种盐只有一个陡峭的失重台阶，另外两种有两个相互重叠的台阶。在 5 K·min⁻¹ 的升温速率下，起始温度在 196 到 248 °C 之间。有重叠台阶的两种盐先失去水分，说明它们的晶格中含有溶剂。在 80 °C 下真空干燥后，第一个台阶消失。",
    [paragraphs.b2]:
      "差示扫描量热给出的分解焓在 1.9 到 2.6 kJ·g⁻¹ 之间。实测值平均比计算值低 12 %，且差距随阳离子增大而增大。因此阳离子越大，实际放出的能量越少于计算值。用四种升温速率作 Kissinger 分析，得到的活化能在 138 到 171 kJ·mol⁻¹ 之间。",
    [paragraphs.b3]:
      "用落锤测定的撞击感度在 8 J 到 40 J 以上。最稳定的两种盐都形成三维氢键网络。在这些盐中，每个阳离子向相邻阴离子提供四个氢键。具有层状网络的盐明显更敏感，尽管它们的密度相近。",
    [paragraphs.c1]:
      "决定这些盐稳定性的是氢键网络，而不仅是密度。三维网络使起始温度升高约 40 °C，并使撞击感度降低为五分之一。计算焓高估了实际放出的能量，后续设计应采用实测值。长期老化没有研究，仍是未决问题。",
    "1. Salts and their structures": "1. 盐及其结构",
    "2. Thermal behaviour": "2. 热行为",
    "3. Conclusions": "3. 结论",
  };
  const text = [
    "# 1. Salts and their structures",
    paragraphs.a1,
    paragraphs.a2,
    "# 2. Thermal behaviour",
    paragraphs.b1,
    paragraphs.b2,
    paragraphs.b3,
    "# 3. Conclusions",
    paragraphs.c1,
  ].join("\n\n");
  return {
    text,
    zh,
    points: [
      {
        section: "1. Salts and their structures",
        statement:
          "Six triazole salts are compared over their whole decomposition curve, not only the onset temperature.",
        zh: "六种三唑盐按完整分解曲线比较，而不只看起始温度。",
        terms: [
          ["decomposition curve", "完整分解曲线"],
          ["onset temperature", "起始温度"],
        ],
        evidence: [
          {
            text: "Earlier reports measured only the onset temperature.",
            zh: "此前的报道只测定了起始温度。",
          },
          {
            text: "In this work we record the whole decomposition curve of six triazole salts and compare the heat released with the computed values.",
            zh: "本工作记录了六种三唑盐的完整分解曲线，并把放热量与计算值作了比较。",
          },
        ],
      },
      {
        section: "1. Salts and their structures",
        statement:
          "One anion and six cations let hydrogen bonding be compared directly.",
        zh: "同一阴离子配六种阳离子，可以直接比较氢键作用。",
        terms: [
          ["hydrogen bonding", "氢键"],
          ["cation", "阳离子"],
        ],
        evidence: [
          {
            text: "The six salts share one anion and differ in the cation, which lets the cation's hydrogen bonding be compared directly.",
            zh: "六种盐的阴离子相同、阳离子不同，因此可以直接比较阳离子的氢键作用。",
          },
        ],
      },
      {
        section: "2. Thermal behaviour",
        statement:
          "Two salts hold solvent in their lattice and lose water before they decompose.",
        zh: "两种盐的晶格含溶剂，分解前先失水。",
        terms: [
          ["solvent", "溶剂"],
          ["water", "水分"],
        ],
        evidence: [
          {
            text: "The two salts with overlapping steps lose water first, which shows that their lattice holds solvent.",
            zh: "有重叠台阶的两种盐先失去水分，说明它们的晶格中含有溶剂。",
          },
        ],
      },
      {
        section: "2. Thermal behaviour",
        statement:
          "Measured enthalpies are 12 % below the computed ones, more so for larger cations.",
        zh: "实测焓比计算值低 12 %，阳离子越大差距越大。",
        terms: [
          ["enthalpies", "焓"],
          ["computed", "计算值"],
        ],
        evidence: [
          {
            text: "The measured values are on average 12 % below the computed ones, and the gap grows with the cation's size.",
            zh: "实测值平均比计算值低 12 %，且差距随阳离子增大而增大。",
          },
        ],
      },
      {
        section: "2. Thermal behaviour",
        statement:
          "The most stable salts form a three-dimensional hydrogen-bond network.",
        zh: "最稳定的盐形成三维氢键网络。",
        terms: [
          ["three-dimensional", "三维"],
          ["network", "氢键网络"],
        ],
        evidence: [
          {
            text: "The two most stable salts both form a three-dimensional hydrogen-bond network.",
            zh: "最稳定的两种盐都形成三维氢键网络。",
          },
          {
            text: "Salts with layered networks are markedly more sensitive, although their densities are similar.",
            zh: "具有层状网络的盐明显更敏感，尽管它们的密度相近。",
          },
        ],
      },
      {
        section: "3. Conclusions",
        statement:
          "Hydrogen-bond networks, not density, decide stability; computed enthalpies overestimate the energy.",
        zh: "决定稳定性的是氢键网络而非密度；计算焓高估了能量。",
        terms: [
          ["networks", "氢键网络"],
          ["overestimate", "高估"],
        ],
        evidence: [
          {
            text: "Hydrogen-bond networks, not density alone, decide the stability of these salts.",
            zh: "决定这些盐稳定性的是氢键网络，而不仅是密度。",
          },
          {
            text: "The computed enthalpies overestimate the energy released, so the measured values should be used in further design.",
            zh: "计算焓高估了实际放出的能量，后续设计应采用实测值。",
          },
        ],
      },
    ],
    digest: [
      {
        text: "A research article on six nitrogen-rich triazole salts: their decomposition by TGA and DSC, their impact sensitivity, and how hydrogen-bond networks explain the differences.",
        zh: "一篇研究六种富氮三唑盐的论文：用热重与差示扫描量热研究分解，测定撞击感度，并用氢键网络解释差异。",
        terms: [
          ["hydrogen-bond networks", "氢键网络"],
          ["impact sensitivity", "撞击感度"],
        ],
        units: [paragraphs.a1.slice(0, 40), paragraphs.c1.slice(0, 40)],
      },
      {
        text: "The computed enthalpies overestimate the measured ones; long-term ageing was not studied.",
        zh: "计算焓高估了实测值；长期老化没有研究。",
        terms: [
          ["overestimate", "高估"],
          ["ageing", "老化"],
        ],
        units: [paragraphs.b2.slice(0, 40), paragraphs.c1.slice(0, 40)],
      },
      {
        text: null,
        zh: null,
        notGiven: "原文没有说明应先读哪一节。",
        terms: [],
        units: [],
      },
    ],
  };
}
/** The fourth sample's paper (sandbox data.json), for the screenshots only. */
export function samplePaper(path: string): FixturePaper {
  type Item = {
    type: string;
    id?: string;
    pid?: string;
    text?: string;
    zh?: string;
  };
  const d = JSON.parse(readFileSync(path, "utf8")) as {
    items: Item[];
    paras: {
      id: string;
      text: string;
      zh: string;
      runin: { s: number; e: number } | null;
      zhrunin: { s: number; e: number } | null;
    }[];
    figures: { id: string; caption: string; zh: string }[];
    evidence: { id: string; text: string; zh: string; para: string }[];
    groups: { pid: string; text: string; zh: string }[];
    kps: {
      id: string;
      en: string;
      zh: string;
      group: string;
      ev: string[];
      keys: { en: string; zh: string }[];
    }[];
    overview: {
      digest: {
        en: string;
        zh: string;
        src?: string[];
        keys: { en: string; zh: string }[];
      }[];
    };
  };
  const paras = new Map(d.paras.map((p) => [p.id, p]));
  const zh: Record<string, string> = {};
  const lines: string[] = [];
  const title = new Map<string, string>();
  for (const g of d.groups) title.set(g.pid, g.text.replace(/[.。]$/u, ""));
  const byN = new Map<string, string>();
  let n = 0;
  for (const x of d.items) {
    if (x.type === "heading") {
      const t = x.text!.replace(/[.。]$/u, "");
      lines.push(`# ${t}`);
      zh[t] = x.zh!.replace(/[.。]$/u, "");
    } else if (x.type === "para") {
      const p = paras.get(x.id!)!;
      n++;
      let text = p.text,
        z = p.zh;
      // A run-in heading becomes the subsection's own heading.
      if (p.runin) {
        const head = text
          .slice(p.runin.s, p.runin.e)
          .trim()
          .replace(/[.。]$/u, "");
        lines.push(`## ${head}`);
        if (p.zhrunin)
          zh[head] = z
            .slice(p.zhrunin.s, p.zhrunin.e)
            .trim()
            .replace(/[.。]$/u, "");
        text = text.slice(p.runin.e).trim();
        if (p.zhrunin) z = z.slice(p.zhrunin.e).trim();
        for (const g of d.groups)
          if (g.text.replace(/[.。]$/u, "") === head) title.set(g.pid, head);
      }
      lines.push(text);
      zh[P(text)] = z;
      byN.set(`¶${n}`, text.slice(0, 40));
    } else if (x.type === "figure" || x.type === "table") {
      const f = d.figures.find((y) => y.id === x.id)!;
      lines.push(f.caption);
      zh[P(f.caption)] = f.zh;
    }
  }
  const ev = new Map(d.evidence.map((e) => [e.id, e]));
  const digest = d.overview.digest.map((x) => ({
    text: x.en,
    zh: x.zh,
    terms: x.keys.map((k) => [k.en, k.zh] as const),
    units: (x.src ?? []).map((s) => byN.get(s)).filter((s): s is string => !!s),
  }));
  return {
    text: lines.join("\n\n"),
    zh,
    points: d.kps.map((k) => ({
      section: title.get(k.group) ?? null,
      statement: k.en,
      zh: k.zh,
      terms: k.keys.map((t) => [t.en, t.zh] as const),
      evidence: k.ev.map((id) => ({
        text: ev.get(id)!.text,
        zh: ev.get(id)!.zh,
      })),
    })),
    digest: [digest[0]!, digest[1]!, digest[2]!],
  };
}

const utf8 = (s: string) => new TextEncoder().encode(s).length;
interface Segment {
  segment_id: string;
  kind: string;
  start_utf8: number;
  end_utf8: number;
}
interface Section {
  section_id: string;
  title: string | null;
  start_utf8: number;
}
const TRANSLATABLE = new Set([
  "heading",
  "text",
  "caption",
  "list",
  "footnote",
  "title",
]);
export interface LayersOptions {
  state?: "none" | "complete" | "stale" | "not-applicable";
  reason?: "long-document" | "too-short" | null;
  /** The layers have their translation part (and the text a translation). */
  translated?: boolean;
  /** The full text has its stored translation (default: as `translated`). */
  textTranslated?: boolean;
}
export async function storedLayers(
  page: Page,
  paper: FixturePaper,
  options: LayersOptions = {},
) {
  const fake = {
    state: options.state ?? "complete",
    reason: options.reason ?? null,
    translated: options.translated ?? true,
    textTranslated: options.textTranslated ?? options.translated ?? true,
    /** The `text` of every `document-layers` request. */
    asked: [] as string[],
  };
  let reading: unknown = null;
  // What the reader itself reads: the version's segments, outline and text.
  const seen = {
    segments: new Map<string, Segment>(),
    sections: new Map<string, Section>(),
    slices: new Map<number, string>(),
  };
  const capture = (
    name: string,
    take: (
      result: Record<string, unknown>,
      request: Record<string, unknown>,
    ) => void,
  ) =>
    page.route(
      (url) => url.pathname === `/api/v1/query/${name}`,
      async (route) => {
        const body = route.request().postDataJSON() as {
          request: Record<string, unknown>;
        };
        if (body.request.text && body.request.text !== "original")
          return route.fallback();
        const response = await route.fetch();
        const value = await response.json();
        if (value.result) take(value.result, body.request);
        await route.fulfill({ response, json: value });
      },
    );
  await capture("document-segments", (r) => {
    for (const s of r.segments as Segment[]) seen.segments.set(s.segment_id, s);
  });
  await capture("document-outline", (r) => {
    for (const s of r.sections as Section[]) seen.sections.set(s.section_id, s);
  });
  await capture("document-slice", (r) => {
    const range = r.actual_range as { start_utf8: number } | null;
    if (range) seen.slices.set(range.start_utf8, r.text as string);
  });
  /** The version's text, segments and sections, once the reader has read them all. */
  const facts = async (_route: Route) => {
    void _route;
    for (let i = 0; i < 200; i++) {
      const segments = [...seen.segments.values()].sort(
        (a, b) => a.start_utf8 - b.start_utf8,
      );
      const total = segments.length
        ? Math.max(...segments.map((s) => s.end_utf8))
        : 0;
      let full = "",
        at = 0;
      for (;;) {
        const part = seen.slices.get(at);
        if (part === undefined) break;
        full += part;
        at += utf8(part);
      }
      if (total && at >= total && seen.sections.size)
        return { full, segments, sections: [...seen.sections.values()] };
      await new Promise((done) => setTimeout(done, 50));
    }
    throw new Error("the reader did not read the whole text");
  };
  const bytes = (full: string) => {
    const encoded = new TextEncoder().encode(full);
    return (start: number, end: number) =>
      new TextDecoder().decode(encoded.slice(start, end));
  };
  const units = (f: Awaited<ReturnType<typeof facts>>) => {
    const at = bytes(f.full);
    return f.segments
      .filter((s) => TRANSLATABLE.has(s.kind))
      .map((s) => {
        const source = P(at(s.start_utf8, s.end_utf8).replace(/^#+\s*/u, ""));
        return {
          unit_id: s.segment_id,
          segment_ids: [s.segment_id],
          translation: fake.textTranslated ? (paper.zh[source] ?? null) : null,
        };
      });
  };
  await page.route(
    (url) => url.pathname === "/api/v1/query/document-describe",
    async (route) => {
      const response = await route.fetch();
      const value = await response.json();
      reading = value.result.document;
      if (fake.textTranslated)
        value.result.translation = {
          target_language: "zh-Hans",
          state: "complete",
          units: 1,
          translated: 1,
        };
      value.result.layers = {
        state: fake.state,
        points: paper.points.length,
        target_language:
          fake.translated && fake.state === "complete" ? "zh-Hans" : null,
        reason: fake.state === "not-applicable" ? fake.reason : null,
      };
      await route.fulfill({ response, json: value });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/v1/query/document-translation",
    async (route) => {
      const f = await facts(route);
      const list = units(f);
      await route.fulfill({
        json: {
          protocol_version: 1,
          result: {
            document: reading,
            machine_translation: true,
            target_language: "zh-Hans",
            state: fake.textTranslated ? "complete" : "none",
            units: list,
            total: list.length,
            next_cursor: null,
          },
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname === "/api/v1/query/document-layers",
    async (route) => {
      const body = route.request().postDataJSON() as {
        request: {
          part: string;
          text: string;
          limit: number;
          cursor: string | null;
        };
      };
      const request = body.request;
      fake.asked.push(request.text);
      if (fake.state !== "complete")
        return route.fulfill({
          status: 409,
          json: { code: "layers-unavailable", reason: "layers-unavailable" },
        });
      if (request.text !== "original" && !fake.translated)
        return route.fulfill({
          status: 409,
          json: {
            code: "translation-unavailable",
            reason: "translation-unavailable",
          },
        });
      const f = await facts(route);
      const both = request.text === "bilingual",
        tr = request.text === "translation";
      const where = (text: string) => {
        const index = f.full.indexOf(text);
        if (index < 0)
          throw new Error(`evidence not in the text: ${text.slice(0, 40)}`);
        const start = utf8(f.full.slice(0, index));
        return { start, end: start + utf8(text) };
      };
      const segmentAt = (offset: number) =>
        f.segments.filter((s) => s.start_utf8 <= offset).pop()!;
      const sectionOf = (title: string | null) =>
        title
          ? (f.sections.find(
              (s) => P(s.title ?? "").replace(/[.。]$/u, "") === P(title),
            ) ?? null)
          : null;
      const term = (
        pair: readonly (readonly [string, string])[],
        zh: boolean,
      ) => pair.map(([en, z]) => (zh ? z : en));
      const points = paper.points.map((p, i) => {
        const section = sectionOf(p.section);
        const statement = tr ? p.zh : p.statement;
        return {
          number: i + 1,
          statement,
          key_terms: term(p.terms, tr),
          section_id: section?.section_id ?? null,
          ...(both
            ? { translation: { text: p.zh, key_terms: term(p.terms, true) } }
            : {}),
          evidence: p.evidence.map((e) => {
            const at = where(e.text);
            const s = segmentAt(at.start);
            return {
              kind: "sentence",
              unit_id: s.segment_id,
              segment_ids: [s.segment_id],
              start_utf8: at.start,
              end_utf8: at.end,
              text: e.text,
              ...(both || tr
                ? { translation: e.zh ? { text: e.zh, aligned: true } : null }
                : {}),
            };
          }),
        };
      });
      if (request.part === "overview") {
        const sections: {
          section_id: string | null;
          title: string | null;
          points: unknown[];
        }[] = [];
        for (const p of points) {
          const { evidence: _e, ...head } = p;
          void _e;
          const last = sections[sections.length - 1];
          if (last && last.section_id === p.section_id) last.points.push(head);
          else
            sections.push({
              section_id: p.section_id,
              title:
                f.sections.find((s) => s.section_id === p.section_id)?.title ??
                null,
              points: [head],
            });
        }
        const unitOf = (words: string) => {
          const index = f.full.indexOf(words);
          return index < 0
            ? null
            : segmentAt(utf8(f.full.slice(0, index))).segment_id;
        };
        return route.fulfill({
          json: {
            protocol_version: 1,
            result: {
              document: reading,
              part: "overview",
              text: request.text,
              machine_translation: request.text !== "original",
              target_language: request.text === "original" ? null : "zh-Hans",
              untranslated: 0,
              digest: paper.digest.map((d, i) => ({
                name: ["nature", "limits", "advice"][i],
                text: tr ? d.zh : d.text,
                not_given: d.text === null ? (d.notGiven ?? "") : null,
                units: d.units
                  .map(unitOf)
                  .filter(Boolean)
                  .map((unit_id) => ({ unit_id, paragraph: 1 })),
                key_terms: term(d.terms, tr),
                ...(both
                  ? {
                      translation: {
                        text: d.zh,
                        key_terms: term(d.terms, true),
                      },
                    }
                  : {}),
              })),
              sections,
            },
          },
        });
      }
      const from = request.cursor ? Number(request.cursor) : 0;
      const pageOf = points.slice(from, from + request.limit);
      const next =
        from + request.limit < points.length
          ? String(from + request.limit)
          : null;
      return route.fulfill({
        json: {
          protocol_version: 1,
          result: {
            document: reading,
            part: "outline",
            text: request.text,
            points: pageOf,
            evidence: [],
            total: points.length,
            next_cursor: next,
          },
        },
      });
    },
  );
  return fake;
}
