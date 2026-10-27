import { designSampleImage } from "./design-samples-image.js";
import { randomUUID } from "node:crypto";
import {
  parseLiterature,
  parseAsset,
  parseFolderNode,
  sha256,
} from "@sciretriever/contracts";
import {
  coreProcessingFixture,
  type ModelInput,
} from "../../server/test/core-processing-fixture.js";
import { archiveModel } from "../../server/test/archive-fixture.js";
import { topicDraft } from "../../server/test/tag-fixture.js";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";
import { syntheticReadingPdf } from "./reading-pdf-fixture.js";
import { createQueryApplication } from "../../server/src/bootstrap/application.js";
import {
  processorHttpAdapters,
  taskHttpAdapters,
} from "../../server/src/bootstrap/workbench.js";
import { TypeScriptConfigurationOwner } from "../../server/src/configuration/owner.js";
import {
  startWorkbenchHttp,
  type WorkbenchStaticAsset,
} from "../../server/src/workbench/http.js";
import { ProductionWorkbenchSession } from "../../server/src/workbench/production-session.js";

export interface DesignSampleIds {
  literature: string;
  folder: string;
  snapshot: string;
  task: string;
  result: string;
  resultHash: string;
  agent: string;
}
export const DESIGN_SAMPLE_GAPS = [
  "无法获取是 PDF 获取耗尽筛选（unavailable_pdf），不是第七个 LiteratureStatus；按实际合同展示。",
  "no-citation 与 citation-unavailable 不能经当前算子正常接纳产生；不伪造结果或删除引用材料。已有 found、not-found、value-null、derived；其余两种留给独立合同回归。",
  "设置页的显式‘样例库’标记需要前端配合；当前以样例目录名、虚构期刊与标题识别，不注入 UI。",
  "基线 885e9e1 尚无 gallery 路由，组件基线使用 lab；后续构建有 gallery 时自动采用 gallery 并在 manifest 记录。",
];
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(70000 + n).padStart(12, "0")}`;
// Samples 1 and 2 carry publisher inline markup, raw and entity-escaped, as real metadata does.
const title = (n: number) =>
  n === 0
    ? "[样例] A quiet atlas of synthetic spectra and evidence"
    : n === 1
      ? "[Sample 01] Moisture-tolerant Li <sub>6</sub> PS <sub>5</sub> Cl in the imaginary Northlight laboratory"
      : n === 2
        ? "[Sample 02] Synthetic Csp&lt;sup&gt;3&lt;/sup&gt; couplings &lt;i&gt;via&lt;/i&gt; imaginary catalysts"
        : n % 7 === 0
          ? `[样例 ${n}] 虚构材料的光谱观察与可复现研究笔记`
          : `[Sample ${String(n).padStart(2, "0")}] ${n % 9 === 0 ? "A deliberately long study of synthetic interfaces, reproducible measurements, uncertain boundaries and the relationship between spectroscopy and hypothetical material behaviour across multiple research contexts" : "Synthetic observations in the imaginary Northlight laboratory"}`;
/** The synthetic document body repeats the title without metadata markup. */
const plainTitle = (n: number) =>
  title(n).replace(/&lt;\/?[a-z]+&gt;|<\/?[a-z]+>/g, "");
const text = (n: number) =>
  `# ${plainTitle(n)}\n\n# Abstract\n\nSynthetic spectroscopy in the imaginary Northlight laboratory. All values are fictional design samples.\n\n# Introduction\n\nWe compare imaginary materials and retain evidence for every observation.\n\n# Methods\n\nThe measured energy was 4.2 eV. The reagent $\\mathrm{SnBu}_4$ is a fictional example.\n\n# Results\n\n![Synthetic diagram](diagram.png)\n\n| Sample | Energy |\n| --- | --- |\n| Northlight | 4.2 eV |\n\n# Conclusion\n\nSynthetic spectroscopy supports this design example only.\n\n# References\n\n[1] Imaginary Researcher. Synthetic reference. Northlight Sample Journal, 2025.\n`;
// A public, synthetic PNG; contains no paper-derived bytes.
const diagram = designSampleImage();

/** Seed through the same Application services/repositories as existing integration fixtures; no SQL. */
export async function seedDesignSamples(options: { homeParent?: string } = {}) {
  const e = await coreProcessingFixture({
    ...options,
    offline: true,
    sourcePdf: syntheticReadingPdf(3),
    pageCount: 3,
    metadata: {
      topic_search_ports: [],
      lookup_ports: [],
      reference_query_ports: [],
    },
    configurationText: '\n[sources.acquisition]\nmode="custom"\nproviders=[]\n',
  });
  const app = e.app;
  const papers = [
    e.parseRequest.literature_id,
    ...Array.from({ length: 59 }, (_, i) => id(i + 1)),
  ];
  let failArchive = false,
    hold = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reply: (input: ModelInput) => unknown = summary;
  e.setModel(async (input, signal) => {
    if (hold)
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error("Synthetic work stopped"));
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
        void gate.then(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        });
      });
    if (input.method === "section-role-dsh-v1") return { role: "body" };
    if (
      input.method === "archive-metadata-dsh-v1" ||
      ["topics", "select", "consolidate"].includes(String(input.task))
    ) {
      if (failArchive) throw new Error("Synthetic archive model failure");
      return archiveModel(input);
    }
    return reply(input);
  });
  const requests = new Map<
    string,
    { literature_id: string; asset_id: string; asset_sha256: string }
  >();
  const archive = async (literature: string, key: string, start = false) => {
    const job = await app.processingTasks!.submit({
      schema_version: 1,
      idempotency_key: key,
      operations: [
        {
          operation: "build-archive",
          request: {
            schema_version: 2,
            literature_id: literature,
            mode: "full",
            from_step: null,
          },
        },
      ],
    });
    if (start) app.processingTasks!.start(job.job_id);
    else await app.processingTasks!.run(job.job_id);
    return job;
  };
  try {
    await e.setResources([
      {
        reference: "diagram.png",
        content: {
          bytes: diagram,
          artifact: {
            sha256: await sha256(diagram),
            byte_size: diagram.length,
            media_type: "image/png",
          },
        },
      },
    ]);
    for (let n = 0; n < papers.length; n++) {
      await app.database.putLiterature(
        parseLiterature({
          ...FIXTURE_LITERATURE,
          literature_id: papers[n],
          meta_literature_id:
            n === 0 ? FIXTURE_LITERATURE.meta_literature_id : id(100 + n),
          version_role: n > 0 && n % 11 === 0 ? "preprint" : "published",
          metadata: {
            ...FIXTURE_LITERATURE.metadata,
            title: title(n),
            identifiers: [],
            publication_form: "journal-article",
            publication_year: n > 0 && n % 13 === 0 ? null : 2019 + (n % 8),
            venue: n % 10 === 0 ? null : "Northlight Sample Journal · 虚构期刊",
            abstract:
              "合成设计样例，仅用于界面审阅。Synthetic spectroscopy and imaginary research evidence.",
            authors: Array.from({ length: n === 45 ? 35 : 2 }, (_, a) => ({
              kind: "person",
              display_name: `Imaginary Author ${a + 1}`,
              given_name: "Imaginary",
              family_name: `Author ${a + 1}`,
              orcid: null,
              affiliations: [],
            })),
          },
        }),
      );
      if (n > 0 && n < 29)
        await app.maintenance!.ingestPdf({
          literature_id: papers[n]!,
          bytes: Buffer.concat([
            syntheticReadingPdf(3),
            Buffer.from(`\n% sample-${n}\n`),
          ]),
        });
      if (n < 29) {
        const asset = (await app.library.detail(papers[n]!)).primary_pdf!.asset;
        requests.set(papers[n]!, {
          literature_id: papers[n]!,
          asset_id: asset.asset_id,
          asset_sha256: asset.sha256,
        });
      }
      if (n >= 29 && n <= 31)
        await app.database.setAutomaticPdfExhaustion(papers[n]!);
      if (n <= 16) {
        e.setText(text(n >= 15 ? 15 : n));
        await app.documentProcessing.parseDocuments({
          ...requests.get(papers[n]!)!,
          profiles: ["vlm-engine"],
          force: false,
        });
      }
      if (n <= 10) {
        await archive(papers[n]!, `design-archive-${n}`);
        if ((await app.archive.status(papers[n]!)).status !== "READY")
          throw new Error(
            `Sample ${n} did not become ready: ${JSON.stringify(await app.archive.status(papers[n]!))}`,
          );
        if (n >= 8) {
          const state = await app.metadataFields.read(papers[n]!);
          await app.metadataFields.edit({
            literature_id: papers[n],
            expected_revision: state.metadata_revision,
            set: [{ field: "article_kind", value: "correction-or-editorial" }],
            unlock: [],
          });
        }
      }
      if (n >= 11 && n <= 14) {
        // Missing initial draft and genuine fake-transport failure exercise owned diagnostics.
        failArchive = n % 2 === 0;
        await archive(papers[n]!, `design-archive-failure-${n}`);
        failArchive = false;
      }
    }
    // An unparsed supplement is an owned, non-blocking archive issue.
    const supplement = Buffer.concat([
      syntheticReadingPdf(3),
      Buffer.from("\n% sample-supplement\n"),
    ]);
    const stage = await app.files.stage();
    await stage.write(supplement);
    await app.files.publish(stage, "objects/design-supplement.pdf");
    await stage.discard();
    const supplementAsset = parseAsset({
      asset_id: randomUUID(),
      sha256: await sha256(supplement),
      size_bytes: supplement.length,
      media_type: "application/pdf",
      path: "objects/design-supplement.pdf",
    });
    await app.database.putLiteratureAsset({
      literature_asset_id: randomUUID(),
      literature_id: papers[6]!,
      asset: supplementAsset,
      role: "supplementary-pdf",
      source_url: null,
      provenance: {
        provenance_id: randomUUID(),
        source_kind: "user",
        source_name: "design-sample",
        source_record_id: null,
        observed_at: new Date().toISOString(),
        input_sha256: supplementAsset.sha256,
        parameters_sha256: null,
      },
    });
    e.setText(text(6));
    await archive(papers[6]!, "design-supplement-issue");
    e.setText(text(15));
    const tags: string[] = [];
    for (const name of [
      "Sample spectroscopy",
      "Sample materials",
      "Sample methods",
      "Sample surfaces",
      "Sample optics",
      "Sample reproducibility",
    ]) {
      const changed = await app.tags.change({
        mutation: {
          op: "create",
          tag: {
            ...topicDraft(name),
            category: name.includes("methods")
              ? "Sample methods"
              : "Sample materials",
          },
        },
        expected_version: (await app.tags.state()).version,
        reason: "Synthetic design vocabulary",
      });
      tags.push(changed.inverse[0]!.tag_id);
    }
    const current = await app.documentRead.default(requests.get(papers[0]!)!);
    const version = current.default!.document_version_id;
    const segments = await app.documentRead.segments({
      document_version_id: version,
      section_id: null,
      limit: 200,
      cursor: null,
    });
    await app.tags.assign({
      literature_id: papers[0],
      expected_revision: (await app.tags.assignment(papers[0]!))!.revision,
      expected_version: (await app.tags.state()).version,
      model: null,
      reason: "Synthetic six-tag layout",
      items: tags.map((tag_id, n) => ({
        tag_id,
        rank: n + 1,
        reason: "Synthetic source evidence",
        origin: "manual",
        locked: true,
        evidence: [
          {
            document_version_id: version,
            segment_ids: [segments.segments[0]!.segment_id],
          },
        ],
      })),
    });
    const createFolder = async (
      name: string,
      parent_id: string | null = null,
    ) =>
      parseFolderNode(
        await app.folders.manage({
          operation: "create",
          request: { name, parent_id, position: null },
        }),
      );
    const parent = await createFolder("样例 · 光谱研究");
    const child = await createFolder("阅读中的材料", parent.folder_id);
    await createFolder("待整理（空文件夹）");
    await app.folders.manage({
      operation: "add",
      request: {
        folder_id: parent.folder_id,
        literature_ids: papers.slice(0, 8),
      },
    });
    await app.folders.manage({
      operation: "add",
      request: {
        folder_id: child.folder_id,
        literature_ids: papers.slice(8, 12),
      },
    });
    for (const literature_id of papers.slice(0, 5))
      await app.folders.opened({ literature_id });
    const snapshots = [];
    for (const [n, name] of [
      "样例 · 初次阅读",
      "样例 · 光谱证据",
      "样例 · 待比较版本",
    ].entries()) {
      snapshots.push(
        await app.snapshots.create({
          name,
          kind: "literatures",
          literature_ids: papers.slice(n, n + 4),
        }),
      );
    }
    const run = async (
      processor: string,
      spec: object,
      key: string,
      inputs: unknown[] = [{ kind: "literature", literature_id: papers[0] }],
    ) => {
      const job = await app.processors!.submit({
        schema_version: 1,
        idempotency_key: `design-${processor}-${(await sha256(Buffer.from(key))).slice(0, 8)}`,
        name: `样例 · ${key}`,
        processor: { id: processor, version: "2" },
        spec,
        inputs,
      });
      await app.processingTasks!.run(job.job_id);
      const result = await app.processingTasks!.read(job.job_id);
      if (result.failures.length)
        throw new Error(
          `Synthetic ${key} failed: ${JSON.stringify(result.failures)}`,
        );
      return result;
    };
    const completed = await run("summary", {}, "全文总结");
    reply = (input) => ({
      answer: "Synthetic spectroscopy",
      source_ids: [
        input.segments!.find((s) => s.text.includes("Synthetic spectroscopy"))!
          .segment_id,
      ],
      reason: null,
    });
    await run(
      "labels",
      { question: "What method is reported?", answer_type: "string" },
      "逐篇问答",
    );
    reply = (input) => ({
      records: [
        {
          values: {
            method: "Synthetic spectroscopy",
            missing: null,
            // Long enough to wrap in its cell; cites the passage with inline math.
            note:
              "This is deliberately absent from the cited passage. " +
              "The synthetic note keeps going so that the result table has to wrap a long value across several lines instead of running past the column.",
          },
          evidence: {
            method: [
              input.segments!.find((s) =>
                s.text.includes("Synthetic spectroscopy"),
              )!.segment_id,
            ],
            missing: [],
            note: [
              input.segments!.find((s) => s.text.includes("SnBu"))!.segment_id,
            ],
          },
          missing: {
            method: null,
            missing: "Not reported in this synthetic example",
            note: null,
          },
        },
      ],
    });
    await run(
      "records",
      {
        record_meaning: "A synthetic observation",
        fields: [
          { name: "method", type: "string", description: "Reported method" },
          {
            name: "missing",
            type: "string",
            description: "An unreported value",
          },
          { name: "note", type: "string", description: "A comparison example" },
        ],
      },
      "记录提取",
    );
    reply = (input) =>
      input.purpose
        ? summary(input)
        : {
            claims: [
              {
                text: "合成资料共同描述光谱观察；此处仅为排版示例。",
                source_ids: (input.candidates as { id: string }[]).map(
                  (c) => c.id,
                ),
              },
            ],
          };
    await run(
      "knowledge-synthesis",
      {
        question: "Compare the synthetic observations.",
        policy: "require-all",
      },
      "多篇综合",
      [{ kind: "snapshot", snapshot_id: snapshots[0]!.snapshot_id }],
    );
    reply = () => ({
      answer: null,
      source_ids: [],
      reason: "Not reported in the synthetic material",
    });
    await run(
      "labels",
      { question: "Is a third spectrum reported?", answer_type: "string" },
      "未报告的值",
    );
    reply = (input) => {
      if (input.segments?.some((s) => s.text.includes("[Sample 01]")))
        throw new Error("Synthetic partial model failure");
      return summary(input);
    };
    const partial = await app.processors!.submit({
      schema_version: 1,
      idempotency_key: "design-partial-summary",
      name: "样例 · 部分失败",
      processor: { id: "summary", version: "2" },
      spec: { purpose: "question", question: "Compare the synthetic context" },
      inputs: papers
        .slice(0, 2)
        .map((literature_id) => ({ kind: "literature", literature_id })),
    });
    await app.processingTasks!.run(partial.job_id);
    const partialState = await app.processingTasks!.read(partial.job_id);
    if (!partialState.failures.length || !partialState.results.length)
      throw new Error("Synthetic partial failure was not exercised");
    await run(
      "labels",
      {
        question: "What is reported in the supplementary material?",
        answer_type: "string",
        reads: { parts: "supplementary", roles: "all" },
      },
      "补充材料未完成",
      [{ kind: "literature", literature_id: papers[6] }],
    );
    // Freeze a snapshot, then publish a real manual content revision to make it outdated.
    const part = (await app.archive.status(papers[2]!)).parts[0]!;
    const editor = await app.proofreading!.editor({ asset_id: part.asset_id });
    const { executeMaintenance } = await import(
      "../../server/src/entry/maintenance-operations.js"
    );
    await executeMaintenance(app, "proofread-save", {
      literature_id: papers[2],
      asset_id: part.asset_id,
      proofread_id: part.proofread_id,
      markdown: editor.text + "\n\nA revised synthetic observation.\n",
      page_starts_utf8: Array.from(
        { length: editor.page_count },
        (_, page) => editor.ranges.find((r) => r.page === page)!.start_utf8,
      ),
      actor: "fixture:design",
    });
    // Durable task states use public job controls; interrupted is a simulated recovery event.
    for (const state of [
      "queued",
      "paused",
      "cancelled",
      "interrupted",
    ] as const) {
      const job = await app.processingTasks!.submit({
        schema_version: 1,
        idempotency_key: `design-${state}`,
        operations: [
          {
            operation: "parse-documents",
            request: {
              ...requests.get(papers[17]!)!,
              profiles: ["vlm-engine"],
              force: false,
            },
          },
        ],
      });
      if (state === "paused" || state === "cancelled")
        await app.processingTasks!.control(
          job.job_id,
          state === "paused" ? "pause" : "cancel",
        );
      if (state === "interrupted") {
        await app.jobs!.updateJob(job.job_id, "interrupted");
        await app.jobs!.appendEvent({
          event_id: randomUUID(),
          job_id: job.job_id,
          sequence: -1,
          kind: "processing-runtime-failed",
          payload: { code: "synthetic-previous-run-interrupted" },
          created_at: new Date().toISOString(),
        });
      }
    }
    reply = summary;
    await app.maintenance!.rebuildIndex();
    hold = true;
    for (const n of [15, 16])
      await archive(papers[n]!, `design-running-${n}`, true);
    // Wait on observable owned state, not arbitrary rendering delays.
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await app.archive.status(papers[16]!)).status === "ARCHIVING") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (attempt === 199)
        throw new Error("Synthetic archive did not enter running state");
    }
    const results = (await app.processorRead!.list()).items;
    const record = results.find((r) => r.processor_id === "records")!;
    const sessions = await app.database.review<{
      items: {
        session_id: string;
        status: string;
        subject: { kind?: string };
      }[];
    }>("session-list", { limit: 200 });
    const agent =
      sessions.items.find(
        (s) => s.status === "completed" && s.subject.kind === "summary",
      ) ?? sessions.items[0]!;
    const counts = await app.library.counts({});
    return {
      env: e,
      ids: {
        literature: papers[0]!,
        folder: parent.folder_id,
        snapshot: snapshots[0]!.snapshot_id,
        task: completed.job.job_id,
        result: String(record.result_id),
        resultHash: String(record.content_sha256),
        agent: agent.session_id,
      } satisfies DesignSampleIds,
      inventory: {
        count: papers.length,
        counts,
        snapshots: snapshots.map((s) => s.snapshot_id),
        results: results.map((r) => ({
          processor: r.processor_id,
          id: r.result_id,
        })),
        gaps: DESIGN_SAMPLE_GAPS,
      },
      close: async () => {
        release();
        hold = false;
        await e.close();
      },
    };
  } catch (error) {
    release();
    hold = false;
    await e.close();
    throw error;
  }
}
function summary(input: ModelInput) {
  return {
    outcome: "completed",
    title: "样例 · 光谱观察阅读笔记",
    statements: [
      {
        statement_id: "s1",
        category: "finding",
        epistemic: "reported",
        text: "Synthetic spectroscopy",
        conditions: ["全部内容为虚构设计样例"],
        quantity: null,
        evidence_segment_ids: [
          input.segments!.find((s) =>
            s.text.includes("Synthetic spectroscopy"),
          )!.segment_id,
        ],
      },
      {
        statement_id: "s2",
        category: "method",
        epistemic: "reported",
        text:
          "A deliberately long synthetic reading note. " +
          "This fictional example retains context and evidence for visual inspection. ".repeat(
            45,
          ),
        conditions: [],
        quantity: null,
        evidence_segment_ids: [input.segments![0]!.segment_id],
      },
    ],
  };
}

/** Production HTTP/auth/CSP and owners, with only synthetic parser/model ports. */
export async function startDesignSamples(options: {
  assets: ReadonlyMap<string, WorkbenchStaticAsset>;
  password: string;
  port?: number;
  homeParent?: string;
}) {
  const seed = await seedDesignSamples(options);
  let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
  let server: Awaited<ReturnType<typeof startWorkbenchHttp>> | undefined;
  const session = new ProductionWorkbenchSession(null, async () => {
    throw new Error("Synthetic Browser acquisition is disabled");
  });
  const close = async () => {
    const failures: unknown[] = [];
    for (const action of [
      () => server?.close(),
      () => session.close(),
      () => query?.close(),
      () => seed.close(),
    ]) {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Design sample cleanup failed");
  };
  try {
    const app = seed.env.app;
    query = await createQueryApplication(seed.env.home);
    const owner = new TypeScriptConfigurationOwner(seed.env.home);
    server = await startWorkbenchHttp({
      access: { host: "127.0.0.1", password: options.password },
      port: options.port ?? 0,
      ...taskHttpAdapters(app),
      session,
      maintenance: app.maintenance!,
      query: {
        application: query,
        maintenance: app.maintenance!,
        ...processorHttpAdapters(app),
      },
      library: { queries: app.library, artifacts: app.literatureArtifacts },
      assets: options.assets,
      configuration: {
        runtime_revision: (await owner.read()).revision,
        read: owner.read.bind(owner),
        status: owner.status.bind(owner),
        publishConfiguration: owner.publishConfiguration.bind(owner),
        credential: owner.credential.bind(owner),
      },
    });
    return { ...seed, origin: server.origin, close };
  } catch (error) {
    await close();
    throw error;
  }
}
