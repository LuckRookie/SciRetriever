import type { Page } from "playwright";

/**
 * A paper with reading layers (technical 04 §10.7, ADR 0070) on served
 * replies, the way `stored-translation.ts` serves a stored translation:
 * `describe` says the layers' state, `document-layers` gives the overview and
 * the points with their evidence, and `document-translation` the paper's
 * translation. Evidence is found in the version's own text (which the reader
 * reads through `document-slice`), so its UTF-8 ranges are the version's.
 * The paper is synthetic: no real paper's text is in the repository.
 */
const P = (s: string) => s.replace(/\s+/gu, " ").trim();
const PARAGRAPHS = {
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
const HEADINGS = [
  "1. Salts and their structures",
  "2. Thermal behaviour",
  "3. Conclusions",
] as const;
/** The paper's text, as the test workspace is given it. */
export const LAYERS_TEXT = [
  `# ${HEADINGS[0]}`,
  PARAGRAPHS.a1,
  PARAGRAPHS.a2,
  `# ${HEADINGS[1]}`,
  PARAGRAPHS.b1,
  PARAGRAPHS.b2,
  PARAGRAPHS.b3,
  `# ${HEADINGS[2]}`,
  PARAGRAPHS.c1,
].join("\n\n");
const ZH: Record<string, string> = {
  [PARAGRAPHS.a1]:
    "富氮盐在大量 N–N 与 C–N 键中储存能量，它们的热行为决定了能否安全操作。此前的报道只测定了起始温度。本工作记录了六种三唑盐的完整分解曲线，并把放热量与计算值作了比较。这些盐由市售原料分两步制得。",
  [PARAGRAPHS.a2]:
    "六种盐的阴离子相同、阳离子不同，因此可以直接比较阳离子的氢键作用。晶体密度在 1.71 到 1.86 g·cm⁻³ 之间。密度较大的盐单位体积放出的能量预计更多，但对撞击也更敏感。密度与稳定性能否同时提高，正是本研究要回答的问题。",
  [PARAGRAPHS.b1]:
    "热重分析显示，四种盐只有一个陡峭的失重台阶，另外两种有两个相互重叠的台阶。在 5 K·min⁻¹ 的升温速率下，起始温度在 196 到 248 °C 之间。有重叠台阶的两种盐先失去水分，说明它们的晶格中含有溶剂。在 80 °C 下真空干燥后，第一个台阶消失。",
  [PARAGRAPHS.b2]:
    "差示扫描量热给出的分解焓在 1.9 到 2.6 kJ·g⁻¹ 之间。实测值平均比计算值低 12 %，且差距随阳离子增大而增大。因此阳离子越大，实际放出的能量越少于计算值。用四种升温速率作 Kissinger 分析，得到的活化能在 138 到 171 kJ·mol⁻¹ 之间。",
  [PARAGRAPHS.b3]:
    "用落锤测定的撞击感度在 8 J 到 40 J 以上。最稳定的两种盐都形成三维氢键网络。在这些盐中，每个阳离子向相邻阴离子提供四个氢键。具有层状网络的盐明显更敏感，尽管它们的密度相近。",
  [PARAGRAPHS.c1]:
    "决定这些盐稳定性的是氢键网络，而不仅是密度。三维网络使起始温度升高约 40 °C，并使撞击感度降低为五分之一。计算焓高估了实际放出的能量，后续设计应采用实测值。长期老化没有研究，仍是未决问题。",
  [HEADINGS[0]]: "1. 盐及其结构",
  [HEADINGS[1]]: "2. 热行为",
  [HEADINGS[2]]: "3. 结论",
};
type Kind =
  | "context"
  | "question"
  | "method"
  | "result"
  | "analysis"
  | "claim"
  | "limit";
interface FixturePoint {
  section: (typeof HEADINGS)[number];
  statement: string;
  zh: string;
  label: string;
  labelZh: string;
  kind: Kind;
  primary?: boolean;
  terms: readonly (readonly [string, string])[];
  evidence: readonly { text: string; zh: string }[];
  /** A part of the first evidence the overview shows (primary points). */
  basis?: string;
  relations?: readonly { word: string; points: readonly number[] }[];
}
export const LAYERS_POINTS: readonly FixturePoint[] = [
  {
    section: HEADINGS[0],
    statement:
      "Six triazole salts are compared over their whole decomposition curve, not only the onset temperature.",
    zh: "六种三唑盐按完整分解曲线比较，而不只看起始温度。",
    label: "Whole decomposition curves",
    labelZh: "完整分解曲线",
    kind: "method",
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
    section: HEADINGS[0],
    statement:
      "The study asks whether density and stability can be raised together.",
    zh: "本研究要回答：密度与稳定性能否同时提高。",
    label: "Density versus stability",
    labelZh: "密度与稳定性",
    kind: "question",
    primary: true,
    terms: [
      ["density", "密度"],
      ["stability", "稳定性"],
    ],
    evidence: [
      {
        text: "Whether density and stability can be raised together is the question this study asks.",
        zh: "密度与稳定性能否同时提高，正是本研究要回答的问题。",
      },
    ],
    basis: "density and stability can be raised together",
  },
  {
    section: HEADINGS[1],
    statement:
      "Two salts hold solvent in their lattice and lose water before they decompose.",
    zh: "有两种盐的晶格含溶剂，分解之前先失水。",
    label: "Solvent in the lattice",
    labelZh: "晶格含溶剂",
    kind: "result",
    terms: [["solvent", "溶剂"]],
    evidence: [
      {
        text: "The two salts with overlapping steps lose water first, which shows that their lattice holds solvent.",
        zh: "有重叠台阶的两种盐先失去水分，说明它们的晶格中含有溶剂。",
      },
    ],
  },
  {
    section: HEADINGS[1],
    statement:
      "Measured enthalpies fall 12 % below the computed ones, more so for larger cations.",
    zh: "实测焓比计算值低 12 %，阳离子越大差得越多。",
    label: "Enthalpy below computed",
    labelZh: "实测焓低于计算",
    kind: "result",
    primary: true,
    terms: [
      ["computed", "计算值"],
      ["cation", "阳离子"],
    ],
    evidence: [
      {
        text: "The measured values are on average 12 % below the computed ones, and the gap grows with the cation's size.",
        zh: "实测值平均比计算值低 12 %，且差距随阳离子增大而增大。",
      },
    ],
    basis: "on average 12 % below the computed ones",
    relations: [{ word: "based_on", points: [1] }],
  },
  {
    section: HEADINGS[1],
    statement:
      "The two most stable salts both have a three-dimensional hydrogen-bond network.",
    zh: "最稳定的两种盐都有三维氢键网络。",
    label: "3D hydrogen-bond network",
    labelZh: "三维氢键网络",
    kind: "result",
    primary: true,
    terms: [["hydrogen-bond network", "氢键网络"]],
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
    basis: "both form a three-dimensional hydrogen-bond network",
    relations: [{ word: "follows", points: [3] }],
  },
  {
    section: HEADINGS[2],
    statement:
      "Hydrogen-bond networks, not density alone, decide the stability of these salts.",
    zh: "决定这些盐稳定性的是氢键网络，而不仅是密度。",
    label: "Networks decide stability",
    labelZh: "氢键网络决定稳定性",
    kind: "claim",
    primary: true,
    terms: [
      ["Hydrogen-bond network", "氢键网络"],
      ["stability", "稳定性"],
    ],
    evidence: [
      {
        text: "Hydrogen-bond networks, not density alone, decide the stability of these salts.",
        zh: "决定这些盐稳定性的是氢键网络，而不仅是密度。",
      },
    ],
    relations: [
      { word: "sums_up", points: [4, 5] },
      { word: "explains", points: [2] },
    ],
  },
  {
    section: HEADINGS[2],
    statement: "Long-term ageing was not studied.",
    zh: "长期老化没有研究。",
    label: "Ageing not studied",
    labelZh: "未研究长期老化",
    kind: "limit",
    terms: [["ageing", "老化"]],
    evidence: [
      {
        text: "Long-term ageing was not studied and remains open.",
        zh: "长期老化没有研究，仍是未决问题。",
      },
    ],
  },
];
const SUMMARY = {
  text: "Six triazole salts with one anion are compared by thermal analysis and impact tests. Stability follows the hydrogen-bond network rather than density, and the computed enthalpies overestimate the heat released.",
  zh: "用热分析与撞击试验比较了阴离子相同的六种三唑盐。稳定性取决于氢键网络而不是密度，计算焓高估了实际放热。",
  terms: [["hydrogen-bond network", "氢键网络"]] as const,
  units: [PARAGRAPHS.a1, PARAGRAPHS.c1],
};
const LIMITS = [
  {
    text: "Only six salts with one anion were studied.",
    zh: "只研究了阴离子相同的六种盐。",
    units: [PARAGRAPHS.a2],
  },
  {
    text: "Long-term ageing was not measured.",
    zh: "没有测长期老化。",
    units: [PARAGRAPHS.c1],
  },
];
const ADVICE = {
  text: "Start with 2. Thermal behaviour for the measurements, then read 3. Conclusions.",
  zh: "先读 2. 热行为 里的测量结果，再读 3. 结论。",
  places: [
    { text: HEADINGS[1], zh: "2. 热行为", heading: HEADINGS[1] },
    { text: HEADINGS[2], zh: "3. 结论", heading: HEADINGS[2] },
  ],
};
const DATA = [
  {
    quantity: "Onset temperature",
    zh: "起始温度",
    value: "196–248 °C",
    unit: PARAGRAPHS.b1,
  },
  {
    quantity: "Decomposition enthalpy",
    zh: "分解焓",
    value: "1.9–2.6 kJ·g⁻¹",
    unit: PARAGRAPHS.b2,
  },
  {
    quantity: "Impact sensitivity",
    zh: "撞击感度",
    value: "8 to >40 J",
    unit: PARAGRAPHS.b3,
  },
];

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
  /** The layers have their translation part, and the text a translation. */
  translated?: boolean;
}
export async function storedLayers(page: Page, options: LayersOptions = {}) {
  const fake = {
    state: options.state ?? "complete",
    reason: options.reason ?? null,
    translated: options.translated ?? true,
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
    take: (result: Record<string, unknown>) => void,
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
        if (value.result) take(value.result);
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
  const facts = async () => {
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
  await page.route(
    (url) => url.pathname === "/api/v1/query/document-describe",
    async (route) => {
      const response = await route.fetch();
      const value = await response.json();
      reading = value.result.document;
      if (fake.translated)
        value.result.translation = {
          target_language: "zh-Hans",
          state: "complete",
          units: 1,
          translated: 1,
        };
      value.result.layers = {
        state: fake.state,
        points: fake.state === "complete" ? LAYERS_POINTS.length : 0,
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
      // Asked before the text is read: the units follow the paper's order.
      for (let i = 0; i < 200 && !seen.segments.size; i++)
        await new Promise((done) => setTimeout(done, 50));
      const paragraphs = Object.values(PARAGRAPHS);
      let heading = 0,
        text = 0;
      const list = [...seen.segments.values()]
        .sort((a, b) => a.start_utf8 - b.start_utf8)
        .filter((s) => TRANSLATABLE.has(s.kind))
        .map((s) => {
          const source =
            s.kind === "heading"
              ? HEADINGS[heading++]
              : s.kind === "text"
                ? paragraphs[text++]
                : undefined;
          return {
            unit_id: s.segment_id,
            segment_ids: [s.segment_id],
            translation:
              fake.translated && source ? (ZH[source] ?? null) : null,
          };
        });
      await route.fulfill({
        json: {
          protocol_version: 1,
          result: {
            document: reading,
            machine_translation: true,
            target_language: "zh-Hans",
            state: fake.translated ? "complete" : "none",
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
      const request = (
        route.request().postDataJSON() as {
          request: {
            part: string;
            text: "original" | "translation" | "bilingual";
            limit?: number;
            cursor?: string | null;
          };
        }
      ).request;
      fake.asked.push(request.text);
      if (fake.state !== "complete")
        return route.fulfill({
          status: 409,
          json: {
            error: {
              code: "layers-unavailable",
              details: { state: fake.state, reason: fake.reason },
            },
          },
        });
      if (request.text !== "original" && !fake.translated)
        return route.fulfill({
          status: 409,
          json: { error: { code: "translation-unavailable" } },
        });
      const f = await facts();
      const mode = request.text;
      const both = mode === "bilingual",
        tr = mode === "translation";
      const where = (text: string) => {
        const index = f.full.indexOf(text);
        if (index < 0) throw new Error(`not in the text: ${text.slice(0, 40)}`);
        const start = utf8(f.full.slice(0, index));
        return { start, end: start + utf8(text) };
      };
      const segmentAt = (offset: number) =>
        f.segments.filter((s) => s.start_utf8 <= offset).pop()!;
      const paragraph = (s: Segment) => f.segments.indexOf(s) + 1;
      const unit = (words: string) => {
        const s = segmentAt(where(words).start);
        return { unit_id: s.segment_id, paragraph: paragraph(s) };
      };
      const sectionOf = (title: string) =>
        f.sections.find(
          (s) => P(s.title ?? "").replace(/[.。]$/u, "") === P(title),
        ) ?? null;
      const terms = (
        pairs: readonly (readonly [string, string])[],
        zh: boolean,
      ) => pairs.map(([en, z]) => (zh ? z : en));
      /** The fields a translated reading adds to an item. */
      const inReading = <T>(translation: T) =>
        tr ? { translated: true } : both ? { translation } : {};
      const sentence = (e: { text: string; zh: string }) => {
        const at = where(e.text);
        const s = segmentAt(at.start);
        return {
          kind: "sentence",
          unit_id: s.segment_id,
          segment_ids: [s.segment_id],
          start_utf8: at.start,
          end_utf8: at.end,
          paragraph: paragraph(s),
          sentences: [1],
          text: e.text,
        };
      };
      const head = (p: FixturePoint, i: number) => {
        const section = sectionOf(p.section);
        return {
          number: i + 1,
          statement: tr ? p.zh : p.statement,
          key_terms: terms(p.terms, tr),
          section_id: section?.section_id ?? null,
          section_title: section?.title ?? null,
          primary: !!p.primary,
          label: tr ? p.labelZh : p.label,
          kind: p.kind,
          relations: (p.relations ?? []).map((r) => ({
            word: r.word,
            targets: r.points.map((number) => ({ kind: "point", number })),
          })),
          ...inReading({
            statement: p.zh,
            key_terms: terms(p.terms, true),
            label: p.labelZh,
          }),
        };
      };
      const common = {
        document: reading,
        part: request.part,
        text: mode,
        state: "complete",
        machine_written: true,
        model: "fixture-model",
        prompt_version: "reading-layers-v2",
        format: "json",
        ...(mode === "original"
          ? {}
          : {
              machine_translation: true,
              target_language: "zh-Hans",
              untranslated: 0,
            }),
      };
      if (request.part === "overview") {
        const sections: {
          section_id: string | null;
          title: string | null;
          points: unknown[];
        }[] = [];
        LAYERS_POINTS.forEach((p, i) => {
          const h = head(p, i);
          const last = sections.at(-1);
          if (last && last.section_id === h.section_id) last.points.push(h);
          else
            sections.push({
              section_id: h.section_id,
              title: h.section_title,
              points: [h],
            });
        });
        return route.fulfill({
          json: {
            protocol_version: 1,
            result: {
              ...common,
              title: "Thermal stability of six triazole salts",
              summary: {
                text: tr ? SUMMARY.zh : SUMMARY.text,
                key_terms: terms(SUMMARY.terms, tr),
                units: SUMMARY.units.map(unit),
                ...inReading({
                  text: SUMMARY.zh,
                  key_terms: terms(SUMMARY.terms, true),
                }),
              },
              primary: LAYERS_POINTS.flatMap((p, i) => {
                if (!p.primary) return [];
                const first = sentence(p.evidence[0]!);
                const at = p.basis ? where(p.basis) : null;
                return [
                  {
                    ...head(p, i),
                    basis: {
                      ...first,
                      ...(at
                        ? {
                            start_utf8: at.start,
                            end_utf8: at.end,
                            text: p.basis!,
                          }
                        : {}),
                      fallback: !at,
                    },
                  },
                ];
              }),
              data: DATA.map((row) => ({
                quantity: tr ? row.zh : row.quantity,
                value: row.value,
                source: { kind: "unit", ...unit(row.unit) },
                ...inReading({ quantity: row.zh }),
              })),
              limits: LIMITS.map((l) => ({
                text: tr ? l.zh : l.text,
                units: l.units.map(unit),
                ...inReading({ text: l.zh }),
              })),
              advice: {
                text: tr ? ADVICE.zh : ADVICE.text,
                not_given: null,
                key_terms: [],
                units: [],
                places: ADVICE.places.map((place) => {
                  const section = sectionOf(place.heading)!;
                  const s = segmentAt(section.start_utf8);
                  return {
                    text: tr ? place.zh : place.text,
                    target: {
                      kind: "section",
                      segment_id: s.segment_id,
                      section_id: section.section_id,
                      title: section.title,
                      paragraph: paragraph(s),
                    },
                  };
                }),
                ...inReading({
                  text: ADVICE.zh,
                  key_terms: [],
                  places: ADVICE.places.map((place) => place.zh),
                }),
              },
              sections,
            },
          },
        });
      }
      const limit = request.limit ?? 20;
      const from = request.cursor ? Number(request.cursor) : 0;
      const points = LAYERS_POINTS.map((p, i) => ({
        ...head(p, i),
        evidence: p.evidence.map((e) => ({
          ...sentence(e),
          ...(tr
            ? { text: e.zh, translated: true, aligned: true }
            : both
              ? { translation: { text: e.zh, aligned: true } }
              : {}),
        })),
      }));
      return route.fulfill({
        json: {
          protocol_version: 1,
          result: {
            ...common,
            points: points.slice(from, from + limit),
            evidence: [],
            total: points.length,
            next_cursor:
              from + limit < points.length ? String(from + limit) : null,
          },
        },
      });
    },
  );
  return fake;
}
