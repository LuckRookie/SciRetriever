import { createHash } from "node:crypto";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  EMPTY_METADATA,
  canonicalJsonBytes,
  normalizedTagName,
  parseLibrarySearchRequest,
  parseMetadataTaskRequest,
  parseProcessingTaskRequest,
  parseTag,
  parseTagAssignment,
  type LiteratureMetadata,
} from "@sciretriever/contracts";
import { processingJobId } from "../src/application/jobs/processing.js";
import {
  fallbackIdentityKey,
  fallbackIdentitySha256,
} from "../src/literature/identity-rules.js";
import { ftsIndexText } from "../src/literature/unicode-casefold.js";
import { normalizeExecutionPolicy } from "../src/storage/execution/repository.js";
import {
  SCALE_LIBRARY_DATE as date,
  addScaleDraft,
  addScalePdf,
  addScaleRawParse,
  seedScaleLibraryCatalog,
  type ScalePdf,
} from "./scale-library-materials.js";

export const SCALE_LIBRARY_SEED = 20261121;
export const SCALE_LIBRARY_SIZES = {
  "10k": 10_000,
  "1m": 1_000_000,
  "10m": 10_000_000,
};
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
const id = (seed: number, kind: number, row: number) =>
  `${seed.toString(16).padStart(8, "0")}-${kind.toString(16).padStart(4, "0")}-4000-8000-${row.toString(16).padStart(12, "0")}`;
const topics = [
  ["optical spectroscopy", "Journal of Analytical Measurements"],
  ["river restoration", "Watershed Research"],
  ["organic photovoltaics", "Materials and Interfaces"],
  ["alpine biodiversity", "Journal of Field Ecology"],
  ["surface microscopy", "Experimental Methods"],
  ["coastal sediment", "Estuarine Systems"],
  ["microclimate mapping", "Environmental Observations"],
  ["scholarly collaboration", "Research Studies"],
] as const;
const settings = [
  "temperate sites",
  "a reference laboratory",
  "seasonal field surveys",
  "coastal catchments",
  "multi-year experiments",
  "an instrument archive",
];
const methods = [
  "Comparative",
  "Quantitative",
  "Longitudinal",
  "Spatial",
  "Bayesian",
];
const given = [
  "Ada",
  "Ravi",
  "María",
  "Lin",
  "Jordan",
  "Amina",
  "Yuki",
  "Elias",
  "Lucía",
];
const families = [
  "Martin",
  "Wang",
  "Singh",
  "Nakamura",
  "Okafor",
  "Costa",
  "Müller",
  "Park",
  "Rivera",
  "Afzal",
  "Wu",
  "Santos",
];
const predicates = [
  "We compared replicated samples using a common measurement protocol and recorded deviations before analysis.",
  "We estimated variation within each group and evaluated the stability of the result across repeated measurements.",
  "We report uncertainty alongside the primary measurements and provide a summary of the available comparison data.",
  "Differences among sampling sites were larger than the variation between successive measurements at a single site.",
  "A second analysis stratified the observations by time and compared the outcome against the reference measurements.",
  "The results describe the limits of the measurements and indicate where longer sampling would improve the estimate.",
  "The study demonstrates how published and newly collected evidence can be combined with a reproducible protocol.",
];

function seededMetadata(
  seed: number,
  paper: number,
  alternate: boolean,
  doi: boolean,
): LiteratureMetadata {
  let state = seed ^ Math.imul(paper + 1, 0x9e3779b9) || 1;
  const sample = (limit: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % limit;
  };
  const [topic, venue] = topics[sample(topics.length)]!;
  const method = methods[sample(methods.length)]!;
  const setting = settings[sample(settings.length)]!;
  const year = 2026 - Math.floor(44 * (sample(1000) / 1000) ** 2);
  const authorCount = 1 + Math.floor(8 * (sample(1000) / 1000) ** 2);
  const people = Array.from({ length: authorCount }, () => {
    const first = given[sample(given.length)]!,
      last = families[sample(families.length)]!;
    return {
      kind: "person" as const,
      display_name: `${first} ${last}`,
      given_name: first,
      family_name: last,
      orcid: null,
      affiliations: [],
    };
  });
  const suffix = paper.toString(36).toUpperCase();
  const title = `${method} studies of ${topic} in ${setting} (${suffix})`;
  return {
    ...EMPTY_METADATA,
    title: alternate ? `${title}: preprint` : title,
    abstract:
      sample(100) < 15
        ? null
        : [
            `This study examines ${topic} in ${setting}.`,
            ...Array.from(
              { length: 4 + sample(7) },
              () => predicates[sample(predicates.length)]!,
            ),
          ].join(" "),
    authors: people,
    publication_year: year,
    publication_form: "journal-article",
    article_kind:
      paper === 7
        ? "correction-or-editorial"
        : sample(10) === 0
          ? "review"
          : "research-article",
    language: "en",
    venue: alternate ? "Preprint repository" : venue,
    publisher: [
      "Synthetic Academic Press",
      "Synthetic University Journals",
      "Synthetic Open Research",
    ][sample(3)]!,
    identifiers: doi
      ? [
          {
            namespace: "doi",
            value: `10.5555/library.${seed}.${paper}${alternate ? ".preprint" : ""}`,
          },
        ]
      : [],
    keywords: [topic, method.toLowerCase()],
  };
}

async function batch(db: DatabaseSync, write: () => void | Promise<void>) {
  db.exec("BEGIN IMMEDIATE");
  try {
    await write();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function bibliographies(db: DatabaseSync) {
  const meta = db.prepare("INSERT INTO meta_literatures VALUES(?,?)");
  const literature = db.prepare("INSERT INTO literatures VALUES(?,?,?)");
  const metadata = db.prepare(
    "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title,abstract,publication_year,publication_form,article_kind,language,venue,publisher) VALUES(?,1,?,?,?,?,?,?,?,?,?)",
  );
  const author = db.prepare(
    "INSERT INTO literature_metadata_authors VALUES(?,?,'person',?,?,?,NULL)",
  );
  const identifier = db.prepare(
    "INSERT INTO literature_metadata_identifiers VALUES(?,?,?,?)",
  );
  const keyword = db.prepare(
    "INSERT INTO literature_metadata_keywords VALUES(?,?,?)",
  );
  const fallback = db.prepare(
    "INSERT INTO literature_fallback_identity_indexes VALUES(?,?)",
  );
  const provenance = db.prepare(
    "INSERT INTO provenances VALUES(?,'metadata-provider','synthetic-scale',?,?,?,NULL)",
  );
  const observation = db.prepare(
    "INSERT INTO metadata_observations(observation_id,provenance_id,version_role,title,abstract,publication_year,publication_form,article_kind,language,venue,publisher) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  );
  const source = db.prepare(
    "INSERT INTO literature_metadata_observations VALUES(?,?)",
  );
  const fts = db.prepare(
    "INSERT INTO literature_search_fts(literature_id,title,abstract,authors,affiliations,identifiers,keywords,venue,publisher,volume,issue,pages,content_body) VALUES(?,?,?,?,'',?,?,?,?,'','','','')",
  );
  return {
    meta,
    async write(
      lit: string,
      paper: string,
      role: "published" | "preprint",
      m: LiteratureMetadata,
      at: string,
    ) {
      literature.run(lit, paper, role);
      const sha = hash(m);
      const values = [
        m.title,
        m.abstract,
        m.publication_year,
        m.publication_form,
        m.article_kind,
        m.language,
        m.venue,
        m.publisher,
      ] as const;
      metadata.run(lit, sha, ...values);
      m.authors.forEach((a, i) =>
        author.run(lit, i, a.display_name, a.given_name, a.family_name),
      );
      m.identifiers.forEach((a, i) =>
        identifier.run(lit, i, a.namespace, a.value),
      );
      m.keywords.forEach((value, i) => keyword.run(lit, i, value));
      if (!m.identifiers.length) {
        const key = fallbackIdentityKey(m);
        if (key) fallback.run(lit, await fallbackIdentitySha256(key));
      }
      provenance.run(lit, lit, at, sha);
      observation.run(lit, lit, role, ...values);
      source.run(lit, lit);
      const index = (value: string | null) => ftsIndexText(value ?? "");
      fts.run(
        lit,
        index(m.title),
        index(m.abstract),
        index(
          m.authors
            .flatMap((a) => [a.display_name, a.given_name, a.family_name])
            .join(" "),
        ),
        index(m.identifiers.map((a) => `${a.namespace} ${a.value}`).join(" ")),
        index(m.keywords.join(" ")),
        index(m.venue),
        index(m.publisher),
      );
    },
  };
}

function libraryOrganization(db: DatabaseSync, seed: number) {
  const folder = id(seed, 8, 1);
  db.prepare(
    "INSERT INTO folders VALUES(?,NULL,'Synthetic reading list',0,?,?)",
  ).run(folder, date, date);
  db.prepare("INSERT INTO saved_filters VALUES(?,? ,?,'intake-desc',?,?)").run(
    id(seed, 8, 2),
    "PDFs awaiting work",
    JSON.stringify(
      parseLibrarySearchRequest({ query: { statuses: ["ASSET_READY"] } }).query,
    ),
    date,
    date,
  );
  const version =
    Number(db.prepare("SELECT version FROM vocabulary_state").get()!.version) +
    1;
  const tags = topics.map(([topic], i) =>
    parseTag({
      tag_id: id(seed, 9, i),
      name_zh: `合成主题 ${i + 1}`,
      name_en: topic,
      aliases: [],
      definition: { includes: topic, excludes: "Unrelated material" },
      parent_id: null,
      category: null,
      kind: "topic",
      status: "active",
      merged_into: null,
      locked: false,
      created_vocab_version: version,
      backfilled_vocab_version: version,
      examples: [],
    }),
  );
  for (const tag of tags) {
    db.prepare("INSERT INTO tags VALUES(?,NULL,'active',NULL,0,?,?,?)").run(
      tag.tag_id,
      version,
      version,
      JSON.stringify(tag),
    );
    const alias = db.prepare("INSERT INTO tag_aliases VALUES(?,?)");
    for (const name of [tag.name_en, tag.name_zh])
      alias.run(normalizedTagName(name), tag.tag_id);
    db.prepare("INSERT INTO tag_search VALUES(?,?,?)").run(
      tag.tag_id,
      `${tag.name_en} ${tag.name_zh}`,
      `${tag.definition.includes} ${tag.definition.excludes}`,
    );
  }
  db.prepare(
    "UPDATE vocabulary_state SET version=?,consolidated_version=?",
  ).run(version, version);
  const item = db.prepare("INSERT INTO literature_tag_items VALUES(?,?,1,0)");
  const assignment = db.prepare(
    "INSERT INTO literature_tag_assignments VALUES(?,1,?,?,?)",
  );
  const member = db.prepare(
    "INSERT INTO folder_members VALUES(?,?,?,'synthetic-scale')",
  );
  const opened = db.prepare("INSERT INTO reading_history VALUES(?,?,?)");
  return {
    tag(lit: string, row: number, draft: { version: string; segment: string }) {
      const tag = tags[Math.floor(row / 100) % tags.length]!;
      const items = [
        {
          tag_id: tag.tag_id,
          rank: 1,
          reason: "Synthetic topic grouping",
          origin: "manual",
          locked: false,
          evidence: [
            {
              document_version_id: draft.version,
              segment_ids: [draft.segment],
            },
          ],
        },
      ];
      const sha = hash({ literature_id: lit, items });
      const value = parseTagAssignment({
        literature_id: lit,
        items,
        assignment_sha256: sha,
        revision: 1,
        vocab_version: version,
        model: null,
      });
      assignment.run(lit, version, sha, JSON.stringify(value));
      item.run(lit, tag.tag_id);
    },
    reading(lit: string, row: number) {
      if (row % 29 === 0) member.run(folder, lit, date);
      if (row % 23 === 0)
        opened.run(
          lit,
          new Date(Date.parse(date) - (row % 1000) * 60_000).toISOString(),
          1 + (row % 5),
        );
    },
  };
}

async function citationTasks(db: DatabaseSync, seed: number, records: number) {
  const policy = normalizeExecutionPolicy({
    mode: "never",
    max_retries: 0,
    max_attempts: 100_000,
    max_network_bytes: 1099511627776,
    max_model_calls: 0,
  });
  const request = parseMetadataTaskRequest({
    kind: "citation",
    direction: "cited-by",
    max_depth: 2,
    result_limit: null,
    providers: [
      { source: "crossref", scan_limit: null },
      { source: "openalex", scan_limit: null },
    ],
    seed_literature_ids: [id(seed, 2, 1), id(seed, 2, 2)],
  });
  const policyVersion = `scale-citation-${seed}`;
  db.prepare("INSERT INTO execution_policy_snapshots VALUES(?,?,?,?)").run(
    policyVersion,
    hash(policy),
    JSON.stringify(policy),
    date,
  );
  const job = db.prepare(
    "INSERT INTO execution_jobs VALUES(?,'selector',?,?,?,?,?,?)",
  );
  const target = db.prepare(
    "INSERT INTO execution_targets VALUES(?,?,0,NULL,NULL,?,?,NULL)",
  );
  const budget = db.prepare(
    "INSERT INTO execution_budgets VALUES(?,?,?,?,1,0,0,?)",
  );
  const event = db.prepare("INSERT INTO execution_events VALUES(?,?,?,?,?,?)");
  const attempt = db.prepare(
    "INSERT INTO execution_attempts VALUES(?,?,'literature',?,?,?,NULL,NULL,NULL,NULL,NULL)",
  );
  const sourceRows = db.prepare(`
    WITH RECURSIVE records(n) AS (VALUES(CAST(? AS INTEGER)) UNION ALL SELECT n+1 FROM records WHERE n+1<?),
         phases(phase) AS (VALUES(0),(1))
    INSERT INTO execution_events(event_id,job_id,sequence,kind,payload_json,created_at)
    SELECT ? || ':' || (2*n+phase+1), ?, 2*n+phase+1, 'metadata-source',
      json_object('target_id',?,'progress',
        json(CASE phase WHEN 0 THEN info ELSE json_set(info,'$.result','miss','$.problem',NULL) END)),
      ?
    FROM (SELECT n,phase,json_object('schema_version',1,'record_id','call-'||n,
          'source',CASE n%2 WHEN 0 THEN 'crossref' ELSE 'openalex' END,
          'purpose','reference-query','role','primary','unit_id','unit-'||n,'at',:at,
          'phase',CASE phase WHEN 0 THEN 'started' ELSE 'finished' END) AS info
          FROM records CROSS JOIN phases) ORDER BY n,phase
  `);
  const tasks: { completed: string; running: string } = {
    completed: "",
    running: "",
  };
  for (const state of ["completed", "running"] as const) {
    const key = `scale-library-${seed}-citation-${state}`;
    const jobId = await processingJobId(key);
    const targetId = jobId + ":0";
    tasks[state] = jobId;
    const jobRequest = await parseProcessingTaskRequest({
      schema_version: 1,
      idempotency_key: key,
      operations: [{ operation: "acquire-metadata", request }],
    });
    const selector = { schema_version: 3, request: jobRequest };
    const finished = state === "completed" ? date : null;
    job.run(
      jobId,
      JSON.stringify(selector),
      policyVersion,
      state,
      key,
      date,
      finished,
    );
    target.run(
      targetId,
      jobId,
      state === "completed" ? "completed" : "literature",
      state === "completed" ? "completed" : "pending",
    );
    budget.run(
      jobId,
      policy.max_attempts,
      policy.max_network_bytes,
      policy.max_model_calls,
      date,
    );
    attempt.run(jobId + ":attempt", targetId, state, date, finished);
    event.run(
      jobId + ":start",
      jobId,
      0,
      "task-start-requested",
      '{"actor":"synthetic-scale"}',
      date,
    );
    const total = state === "completed" ? 20 : records;
    for (let start = 0; start < total; start += 10_000)
      await batch(db, () => {
        sourceRows.run(
          { at: date },
          start,
          Math.min(start + 10_000, total),
          jobId,
          jobId,
          targetId,
          date,
        );
      });
  }
  return tasks;
}

export interface ScaleLibraryOptions {
  directory: string;
  papers: number;
  seed: number;
  sourceRecords: number;
}

/** Direct batched SQL, with a disposable corrected-archive sample and no network services. */
export async function generateScaleLibrary(options: ScaleLibraryOptions) {
  const { directory, papers, seed, sourceRecords } = options;
  if (
    !isAbsolute(directory) ||
    !Number.isSafeInteger(papers) ||
    papers < 200 ||
    papers > 10_000_000 ||
    papers % 100 !== 0 ||
    !Number.isInteger(seed) ||
    seed < 1 ||
    seed > 0xffffffff ||
    !Number.isSafeInteger(sourceRecords) ||
    sourceRecords < 1 ||
    sourceRecords > 1_000_000
  )
    throw new Error("Invalid scale library fixture options");
  const start = performance.now();
  const phases: Record<string, number> = {};
  const measure = async <T>(name: string, work: () => T | Promise<T>) => {
    const start = performance.now();
    const value = await work();
    phases[name] = Math.round(performance.now() - start);
    return value;
  };
  const home = join(directory, "home"),
    catalog = join(directory, "catalog.sqlite"),
    artifacts = join(directory, "artifacts");
  await mkdir(directory, { mode: 0o700 });
  await mkdir(join(home, ".sciretriever"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(home, ".sciretriever", "config.toml"),
    [
      "[paths]",
      `catalog_path=${JSON.stringify(catalog)}`,
      `artifact_root=${JSON.stringify(artifacts)}`,
      "[sources.acquisition]",
      'mode="custom"',
      "providers=[]",
      "",
    ].join("\n"),
    { mode: 0o600, flag: "wx" },
  );
  await measure("corrected_example", async () => {
    await seedScaleLibraryCatalog(catalog, artifacts, seed);
    await chmod(catalog, 0o600);
  });
  const db = new DatabaseSync(catalog);
  try {
    db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL",
    );
    const pool: ScalePdf[] = await measure("shared_pdf_and_raw", async () => {
      const result: ScalePdf[] = [];
      for (const [n, kib] of [
        72,
        96,
        152,
        224,
        310,
        430,
        500,
        20 * 1024,
        20 * 1024,
      ].entries()) {
        const pdf = await addScalePdf(
          db,
          artifacts,
          id(seed, 4, n),
          `shared-${seed}-${n}`,
          n >= 7 ? 160 + n : 1,
          kib * 1024,
        );
        if (n >= 4 && n <= 6) await addScaleRawParse(db, artifacts, pdf);
        result.push(pdf);
      }
      return result;
    });
    const write = bibliographies(db);
    const organize = libraryOrganization(db, seed);
    const bind = db.prepare(
      "INSERT INTO literature_assets VALUES(?,?,?,'primary-pdf',?,NULL)",
    );
    const attach = (lit: string, pdf: ScalePdf) =>
      bind.run(lit, lit, pdf.asset, lit);
    const counts = {
      meta: papers,
      literature: papers,
      without_doi: 0,
      without_doi_versions: 0,
      double: 0,
      bibliography_only: papers - papers / 10,
      pdf_only: papers / 20 - 1,
      parsed_only: papers / 25,
      draft: papers / 100,
      proofread: 1,
      statuses: {
        UNREVIEWED: 0,
        ASSET_READY: papers / 10 - 4,
        ARCHIVING: 1,
        ARCHIVE_FAILED: 1,
        READY: 1,
        EXCLUDED: 1,
      },
    };
    await measure("metadata_and_organization", async () => {
      const dates = Array.from({ length: 1461 }, (_, day) =>
        new Date(Date.parse(date) - day * 86400000).toISOString(),
      );
      for (let start = 1; start < papers; start += 1000) {
        await batch(db, async () => {
          for (let n = start; n < Math.min(papers, start + 1000); n++) {
            const paper = id(seed, 1, n),
              lit = id(seed, 2, n);
            const doi = (n * 37 + 15 + (seed % 85)) % 100 >= 15;
            const alternate = (n * 73 + 10 + (seed % 90)) % 100 < 10;
            const at = dates[(Math.imul(n, 2654435761) >>> 0) % dates.length]!;
            write.meta.run(paper, lit);
            await write.write(
              lit,
              paper,
              "published",
              seededMetadata(seed, n, false, doi),
              at,
            );
            organize.reading(lit, n);
            if (!doi) {
              counts.without_doi++;
              counts.without_doi_versions++;
            }
            if (alternate) {
              await write.write(
                id(seed, 3, n),
                paper,
                "preprint",
                seededMetadata(seed, n, true, doi),
                at,
              );
              counts.double++;
              counts.literature++;
              counts.bibliography_only++;
              if (!doi) counts.without_doi_versions++;
            }
            const slot = n % 100;
            if (slot <= 4)
              attach(
                lit,
                pool[n <= 2 ? 6 + n : Math.floor(n / 100 + slot) % 4]!,
              );
            else if (slot <= 8) attach(lit, pool[4 + (n % 3)]!);
          }
        });
      }
    });
    counts.statuses.UNREVIEWED = counts.bibliography_only;
    const draft = await measure("drafts_and_archive_states", async () => {
      let first = "";
      for (let n = 9; n < papers; n += 100) {
        const pdf = await addScalePdf(
          db,
          artifacts,
          id(seed, 5, n),
          `draft-${seed}-${n}`,
          1,
          72 * 1024,
        );
        const lit = id(seed, 2, n);
        attach(lit, pdf);
        const result = await addScaleDraft(db, artifacts, pdf, lit);
        organize.tag(lit, n, result);
        if (!first) first = result.version;
      }
      const run = db.prepare(
        "INSERT INTO archive_runs VALUES(?,?,'full',?,NULL,?,?,?)",
      );
      for (const [row, state] of [
        [5, "running"],
        [6, "finished"],
        [7, "finished"],
      ] as const) {
        const lit = id(seed, 2, row),
          asset = pool[4 + (row % 3)]!.asset;
        run.run(
          lit,
          asset,
          id(seed, 6, row),
          state,
          date,
          state === "running" ? null : date,
        );
        if (row === 6)
          db.prepare(
            "INSERT INTO archive_issues VALUES(?,?,?,'proofread','correction-failed','{}',NULL,?)",
          ).run(id(seed, 7, row), lit, asset, date);
      }
      return first;
    });
    const jobs = await measure("citation_events", () =>
      citationTasks(db, seed, sourceRecords),
    );
    await measure("checkpoint", () =>
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)"),
    );
    const report = {
      catalog,
      artifacts,
      home,
      seed,
      papers,
      counts,
      jobs,
      draft,
      source_records: sourceRecords,
      elapsed_ms: Math.round(performance.now() - start),
      phase_ms: phases,
      pdf: {
        literature_id: id(seed, 2, 1),
        asset: pool[7]!.asset,
        artifact: pool[7]!.artifact,
        pages: pool[7]!.pages,
      },
    };
    await writeFile(
      join(directory, "fixture.json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    return report;
  } finally {
    db.close();
  }
}

export type ScaleLibrary = Awaited<ReturnType<typeof generateScaleLibrary>>;

export async function scaleLibraryStorage(library: ScaleLibrary) {
  const db = new DatabaseSync(library.catalog, { readOnly: true });
  try {
    const objects = db
      .prepare(
        "SELECT name,sum(pgsize) AS bytes,count(*) AS pages FROM dbstat GROUP BY name ORDER BY bytes DESC",
      )
      .all();
    const catalog_bytes = (await stat(library.catalog)).size;
    const files = db
      .prepare(
        "SELECT count(*) AS files, sum(byte_size) AS bytes FROM artifact_objects",
      )
      .get()!;
    return {
      catalog_bytes,
      files,
      bytes_per_paper: catalog_bytes / library.papers,
      objects,
    };
  } finally {
    db.close();
  }
}
