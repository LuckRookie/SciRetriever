import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import { appendFile, readFile, readdir, stat } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  EMPTY_METADATA,
  parseMetadataObservation,
  type MetadataObservation,
} from "@sciretriever/contracts";

export const SCALE_SEED = 0x251120;
export type ScaleOutcome = "pdf" | "miss" | "retry-pdf" | "temporary";
export interface ScalePaper {
  key: string;
  paper: number;
  title: string;
  doi: string | null;
  outcome: ScaleOutcome;
  bytes: number;
  version: "published" | "preprint";
  metadata: MetadataObservation["metadata"];
}
export interface ScaleDataset {
  scenario: "standard" | "retry-boundary";
  seed: number;
  papers: number;
  versions: ScalePaper[];
  bibliography: string;
  discovery: MetadataObservation[];
  sentinel: MetadataObservation;
  expected: {
    meta: number;
    literature: number;
    second_source: number;
    without_doi: number;
    obtained: number;
    exhausted: number;
    temporary: number;
    with_primary_pdf: number;
    exhausted_versions: number;
    temporary_versions: number;
  };
}

/** Throughput counts papers once even when two versions share a task scope. */
export function scalePaperCount(
  dataset: ScaleDataset,
  keys: readonly string[],
): number {
  const papers = new Map(
    dataset.versions.map((version) => [version.key, version.paper]),
  );
  papers.set("sentinel", -1);
  return new Set(
    keys.map((key) => {
      const paper = papers.get(key);
      if (paper === undefined)
        throw new Error(`scale paper key is unavailable: ${key}`);
      return paper;
    }),
  ).size;
}

/** A seeded shuffle chooses overlapping DOI, duplicate, version and source cohorts. */
export function scaleDataset(
  count: number,
  seed = SCALE_SEED,
  scenario: ScaleDataset["scenario"] = "standard",
): ScaleDataset {
  if (!Number.isSafeInteger(count) || count < 20)
    throw new Error("SCIRETRIEVER_SCALE_RECORDS must be an integer >= 20");
  let state = seed >>> 0;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const shuffle = (items: number[]) => {
    for (let n = items.length - 1; n > 0; n--) {
      const m = Math.floor(random() * (n + 1));
      [items[n], items[m]] = [items[m]!, items[n]!];
    }
    return items;
  };
  const indexes = () => Array.from({ length: count }, (_, n) => n);
  const noDoi = new Set(shuffle(indexes()).slice(0, Math.floor(count * 0.15)));
  const duplicates = new Set(
    shuffle(indexes()).slice(0, Math.floor(count / 5)),
  );
  // Alternate versions have explicit DOI version evidence; DOI-free repeats use
  // precisely the title/ordered-authors/year/publication-form fallback identity.
  const double = new Set(
    shuffle(indexes().filter((n) => !noDoi.has(n))).slice(
      0,
      Math.floor(count / 10),
    ),
  );
  const outcomes = shuffle(indexes());
  const pdfCount = Math.floor(count * 0.6),
    missCount = Math.floor(count * 0.3);
  const retryCount = Math.floor((count - pdfCount - missCount) / 2);
  const byOutcome = new Map<number, ScaleOutcome>(
    outcomes.map((n, i) => [
      n,
      i < pdfCount
        ? "pdf"
        : i < pdfCount + missCount
          ? "miss"
          : i < pdfCount + missCount + retryCount
            ? "retry-pdf"
            : "temporary",
    ]),
  );
  const large = new Set(
    shuffle(
      indexes().filter(
        (n) =>
          scenario === "retry-boundary" ||
          ["pdf", "retry-pdf"].includes(byOutcome.get(n)!),
      ),
    ).slice(
      0,
      Math.max(
        1,
        Math.round(
          (scenario === "retry-boundary" ? count : pdfCount + retryCount) *
            0.01,
        ),
      ),
    ),
  );
  const versions: ScalePaper[] = [];
  for (const paper of indexes()) {
    const key = `p${String(paper).padStart(6, "0")}`;
    const title = `Scale paper ${key} seeded ${Math.floor(random() * 1e8)}`;
    const doi = noDoi.has(paper) ? null : `10.5555/scale.${seed}.${key}`;
    const metadata: ScalePaper["metadata"] = {
      ...EMPTY_METADATA,
      title,
      authors: [
        {
          kind: "person",
          display_name: `Writer ${key}`,
          given_name: "Writer",
          family_name: key,
          orcid: null,
          affiliations: [],
        },
      ],
      publication_year: 2020 + (paper % 6),
      publication_form: "journal-article" as const,
      venue: "Synthetic Scale Journal",
      language: "en",
      identifiers: doi ? [{ namespace: "doi", value: doi }] : [],
    };
    const common = {
      key,
      paper,
      title,
      doi,
      metadata,
      outcome:
        scenario === "retry-boundary"
          ? ("retry-pdf" as const)
          : byOutcome.get(paper)!,
      bytes: large.has(paper)
        ? 20 * 1024 * 1024
        : 50 * 1024 + Math.floor(random() * 450 * 1024),
    };
    versions.push({ ...common, version: "published" });
    if (double.has(paper)) {
      const altDoi = `${doi}.preprint`,
        altTitle = `${title} preprint`;
      versions.push({
        ...common,
        key: `${key}-v2`,
        doi: altDoi,
        title: altTitle,
        metadata: {
          ...metadata,
          title: altTitle,
          identifiers: [{ namespace: "doi", value: altDoi }],
        },
        version: "preprint",
      });
    }
  }
  const uuid = (text: string) => {
    const hex = createHash("sha256").update(`${seed}:${text}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4000-9000-${hex.slice(20, 32)}`;
  };
  const observation = (v: ScalePaper): MetadataObservation =>
    parseMetadataObservation({
      observation_id: uuid(`observation:${v.key}`),
      source_type: null,
      source_type_mapping_version: null,
      provenance: {
        provenance_id: uuid(`provenance:${v.key}`),
        source_kind: "metadata-provider",
        source_name: "scale-replay",
        source_record_id: v.key,
        observed_at: "2026-11-17T00:00:00Z",
        input_sha256: createHash("sha256")
          .update(JSON.stringify(v))
          .digest("hex"),
        parameters_sha256: null,
      },
      metadata: v.metadata,
      version_role: v.version,
      version_links:
        v.version === "preprint"
          ? [
              {
                record_id: null,
                identifiers: [
                  {
                    namespace: "doi",
                    value: v.doi!.replace(/\.preprint$/u, ""),
                  },
                ],
              },
            ]
          : [],
      declared_keywords: [],
      reference_texts: [],
      reference_count: null,
      cited_by_count: null,
      asset_hints: [],
    });
  const originals = versions.filter((v) => v.version === "published");
  const bibliography = originals
    .map(
      (v) =>
        `@article{${v.key},\n title={${v.title}},\n author={Writer ${v.key}},\n year={${v.metadata.publication_year}},\n journal={Synthetic Scale Journal}${v.doi ? `,\n doi={${v.doi}}` : ""}\n}`,
    )
    .join("\n\n");
  const sentinelPaper: ScalePaper = {
    ...versions[0]!,
    key: "sentinel",
    paper: -1,
    title: "Scale scope sentinel",
    doi: `10.5555/scale.${seed}.sentinel`,
    outcome: "miss",
    metadata: {
      ...versions[0]!.metadata,
      title: "Scale scope sentinel",
      identifiers: [
        { namespace: "doi", value: `10.5555/scale.${seed}.sentinel` },
      ],
    },
    version: "published",
  };
  return {
    scenario,
    seed,
    papers: count,
    versions,
    bibliography,
    discovery: versions
      .filter((v) => v.version === "preprint" || duplicates.has(v.paper))
      .map(observation),
    sentinel: observation(sentinelPaper),
    expected: {
      meta: count,
      literature: versions.length,
      second_source: duplicates.size,
      without_doi: noDoi.size,
      obtained: scenario === "retry-boundary" ? count : pdfCount + retryCount,
      exhausted: scenario === "retry-boundary" ? 0 : missCount,
      temporary:
        scenario === "retry-boundary"
          ? 0
          : count - pdfCount - missCount - retryCount,
      with_primary_pdf: versions.filter((v) =>
        ["pdf", "retry-pdf"].includes(v.outcome),
      ).length,
      exhausted_versions: versions.filter((v) => v.outcome === "miss").length,
      temporary_versions: versions.filter((v) => v.outcome === "temporary")
        .length,
    },
  };
}

export interface ScalePauseInterval {
  start_ms: number;
  end_ms: number | null;
}

/** Clip and union pauses so stage measurements never subtract a pause twice. */
export function scalePausedMs(
  pauses: readonly ScalePauseInterval[],
  start: number,
  end: number,
): number {
  if (
    !Array.isArray(pauses) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end < start
  )
    throw new Error("scale pause timing is invalid");
  const intervals = pauses
    .map((pause) => {
      if (
        !pause ||
        !Number.isFinite(pause.start_ms) ||
        (pause.end_ms !== null &&
          (!Number.isFinite(pause.end_ms) || pause.end_ms < pause.start_ms))
      )
        throw new Error("scale pause interval is invalid");
      return [
        Math.max(start, pause.start_ms),
        Math.min(end, pause.end_ms ?? end),
      ] as const;
    })
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0]);
  let duration = 0,
    edge = start;
  for (const [from, to] of intervals) {
    if (to > edge) duration += to - Math.max(edge, from);
    edge = Math.max(edge, to);
  }
  return duration;
}

export function scaleClock() {
  return { monotonic_ms: performance.now(), epoch_ms: Date.now() };
}

export function scaleElapsed(
  start: ReturnType<typeof scaleClock>,
  pauseFile: string,
  end = performance.now(),
) {
  const raw = end - start.monotonic_ms;
  let pauses: ScalePauseInterval[];
  try {
    pauses = JSON.parse(
      readFileSync(pauseFile, "utf8"),
    ) as ScalePauseInterval[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    pauses = [];
  }
  const paused = Math.min(
    raw,
    scalePausedMs(pauses, start.epoch_ms, start.epoch_ms + raw),
  );
  return { wall_ms: raw - paused, raw_wall_ms: raw, paused_ms: paused };
}

export interface ScaleMessage {
  id?: number;
  event?: string;
  result?: unknown;
  error?: string;
  rss?: number;
}
/** IPC drives public operations in a separate process; it adds no product route. */
export class ScaleProcess {
  readonly child: ChildProcess;
  readonly events: ScaleMessage[] = [];
  rss = 0;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private output = "";
  private exited: Promise<unknown>;
  constructor(
    script: string,
    args: string[],
    home: string,
    private readonly log: string,
  ) {
    this.child = fork(script, args, {
      execArgv: ["--experimental-strip-types"],
      env: { HOME: home, LANG: "C.UTF-8", TZ: "UTC" },
      silent: true,
    });
    this.exited = once(this.child, "exit");
    this.child.on("message", (raw) => {
      const message = raw as ScaleMessage;
      this.rss = Math.max(this.rss, message.rss ?? 0);
      if (message.id !== undefined) {
        const operation = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) operation?.reject(new Error(message.error));
        else operation?.resolve(message.result);
      } else this.events.push(message);
    });
    const output = (bytes: Buffer) => {
      this.output = (this.output + bytes.toString()).slice(-32000);
    };
    this.child.stdout!.on("data", output);
    this.child.stderr!.on("data", output);
    this.child.on("exit", (code, signal) => {
      for (const op of this.pending.values())
        op.reject(
          new Error(`scale child exited (${code ?? signal}): ${this.output}`),
        );
      this.pending.clear();
    });
  }
  async event(name: string, timeout = 60_000): Promise<ScaleMessage> {
    const start = performance.now();
    for (;;) {
      const found = this.events.find((e) => e.event === name);
      if (found) return found;
      if (this.child.exitCode !== null || this.child.signalCode !== null)
        throw new Error(`scale child exited before ${name}: ${this.output}`);
      if (performance.now() - start > timeout)
        throw new Error(`scale checkpoint timed out: ${name}: ${this.output}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  call<T>(operation: string, input: unknown = {}): Promise<T> {
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.child.send({ id, operation, input });
    });
  }
  async stop(signal: NodeJS.Signals = "SIGTERM") {
    if (this.child.exitCode === null && this.child.signalCode === null)
      this.child.kill(signal);
    await this.exited;
    await appendFile(this.log, this.output);
  }
}

export function catalogSnapshot(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("BEGIN");
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
      )
      .all();
    return Object.fromEntries(
      tables.map((row) => {
        const table = String(row.name).replaceAll('"', '""');
        const contents = db
          .prepare(`SELECT * FROM "${table}"`)
          .all()
          .map((v) => JSON.stringify(v))
          .sort();
        return [
          String(row.name),
          {
            rows: contents.length,
            sha256: createHash("sha256")
              .update(contents.join("\n"))
              .digest("hex"),
          },
        ];
      }),
    );
  } finally {
    db.close();
  }
}
export function catalogRows<T>(path: string, sql: string): T[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return JSON.parse(JSON.stringify(db.prepare(sql).all())) as T[];
  } finally {
    db.close();
  }
}
export async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory()
      ? await directoryBytes(child)
      : (await stat(child)).size;
  }
  return total;
}
export async function sourceLog(
  path: string,
): Promise<{ key: string; kind: string; outcome: string }[]> {
  const bytes = await readFile(path, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  return bytes.trim()
    ? bytes
        .trim()
        .split("\n")
        .map((row) => JSON.parse(row))
    : [];
}
