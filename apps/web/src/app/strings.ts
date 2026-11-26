import {
  TRANSLATION_LANGUAGES,
  type DocumentTranslationState,
  type TextLevel,
  type ProcessorCheckStatus,
  type ProofreadBasis,
} from "@sciretriever/contracts";

export const sectionLabels = {
  lib: "文献库",
  archive: "需处理",
  tags: "标签词表",
  snapshots: "快照",
  disc: "找文献",
  ins: "洞察",
  ask: "全文检索",
  syn: "综合",
  ext: "算子",
  task: "任务",
  web: "浏览器",
  agent: "Agent 会话",
  stats: "来源统计",
  set: "设置",
  lab: "交互实验台",
  gallery: "组件画廊",
} as const;
/**
 * The one word for each state on screen (page specs “界面用词”): a paper's
 * material, a task, a target or an Agent session. A queued task that was never
 * started reads “未启动”, see `taskStateLabel` in `data/tasks.ts`.
 */
export const statusLabels: Readonly<Record<string, string>> = {
  UNREVIEWED: "只有书目",
  ASSET_READY: "有 PDF",
  READY: "有全文",
  ARCHIVING: "正在解析全文",
  ARCHIVE_FAILED: "全文解析失败",
  EXCLUDED: "已排除",
  UNAVAILABLE: "没找到 PDF",
  queued: "排队中",
  pending: "排队中",
  running: "进行中",
  paused: "等你处理",
  cancelled: "已取消",
  completed: "已完成",
  complete: "已完成",
  partial: "部分完成",
  failed: "失败",
  interrupted: "已中断",
  skipped: "已跳过",
  unavailable: "不可用",
  unknown: "未知",
};
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /[\u3400-\u9fff]/u.test(message) ? message : serviceMessage(message);
}

export const archiveStrings = {
  tagOperations: {
    create: "新建",
    merge: "合并",
    "set-parent": "调整层级",
    "set-category": "修改类别",
    "edit-definition": "修改定义",
    rename: "修改名称",
    "set-lock": "修改锁定",
    undo: "撤销",
  },
  tagActors: {
    tagging: "自动打标",
    consolidation: "词表整理",
    manual: "人工",
    backfill: "标签回溯",
  },
  title: "需处理",
  description:
    "按需处理影响阅读与加工的问题。解析 PDF、解析全文和总结都由你分别启动。",
  metadata: "字段与来源",
  continue: "继续解析全文",
  retry: "重新解析全文",
  empty: "没有需要处理的问题",
  stats: "解析全文的用量",
  snapshot: "快照",
  createSnapshot: "从当前筛选生成快照",
  vocabulary: "标签词表",
  sources: "显示来源",
  compare: "区块对照",
  stale: "已过时",
  outcomes: {
    with_result: "有结果",
    empty: "结果为空",
    incomplete: "读取不完整",
  },
  steps: {
    parse: "解析",
    arrange: "整理",
    proofread: "校订",
    render: "全文发布",
    translate: "翻译",
    layers: "分层",
    document: "全文发布（旧流程）",
    structure: "章节结构（旧流程）",
    metadata: "元数据",
    references: "引用关系",
    tags: "文献标签",
  },
} as const;

/** Why a leaf was left out of the reading text; the six reasons are closed by the archive contract. */
export const dropReasons: Readonly<Record<string, string>> = {
  header: "页眉",
  footer: "页脚",
  interface: "网页界面文字",
  bibliography: "书目信息",
  copyright: "版权声明",
  decoration: "装饰性内容",
};

/** Why a processing task left a paper untouched, with what to do next. */
export const skipReasons: Readonly<Record<string, string>> = {
  "needs-parse": "还没有解析 PDF。点“解析全文”会先解析 PDF，再校订成全文。",
  "needs-pdf": "还没有 PDF。先获取或补充 PDF。",
  blocked: "所需的前一步还没有完成，这一项暂时不能处理。",
  excluded: "文章性质为观点、评论、勘误或社论，不解析全文。",
};
/**
 * A problem as a short phrase (“解析服务连不上”), for group titles and the
 * one line that says where a paper stopped; never the raw code. Null for a
 * code without a phrase of its own.
 */
export function problemPhrase(code: string): string | null {
  return (
    (
      {
        ...archiveStrings.steps,
        "raw-parse": "原始解析",
        "primary-pdf": "获取 PDF",
        "tags-failed": "标签生成失败",
        "needs-parse": "还没有解析 PDF",
        "parser-unavailable": "解析服务连不上",
        "parse-failed": "解析 PDF 没有完成",
        "proofread-incomplete": "校订没有完成",
        "correction-model-unconfigured": "还没有配置矫正模型",
        "correction-budget-exhausted": "矫正预算用完了",
        "page-content-missing": "有页面没解析出正文",
        "validation-repeated": "同一校验错误反复出现",
        "no-progress": "模型多次没有进展",
        "page-tools-unavailable": "页面图像读不到",
        "model-failed": "模型调用失败",
        "request-too-large": "单次请求太大",
        "response-too-large": "模型回复太大",
        "source-integrity": "原始材料校验没通过",
        "publication-conflict": "内容被其他操作改过",
        "render-failed": "全文渲染失败",
        "input-stale": "原始解析已变化",
        "input-missing": "缺少原始解析",
        interrupted: "任务被中断",
        "configuration-option-removed": "配置里有已删除的选项",
        "manual-conflict": "人工修订与新解析冲突",
        "metadata-incomplete": "书目缺少必填项",
        "structure-unsatisfied": "章节结构待确认",
        "tags-empty": "还没有有效标签",
        "part-unavailable": "补充材料暂不可用",
        "model-unavailable": "模型不可用",
        "metadata-missing": "书目缺少必填项",
        "translation-incomplete": "有段落没有译文",
        "translation-unavailable": "翻译时模型不可用",
        // Technical 04 §10.3, §10.5.
        "layers-incomplete": "概览与脉络的要点太少",
        "layers-unavailable": "分层时模型不可用",
        "layers-translation-incomplete": "概览与脉络没有译文",
      } as Record<string, string>
    )[code] ?? null
  );
}
/** The phrase, or for an unknown code the service's general message. */
export function archiveReason(code: string): string {
  return problemPhrase(code) ?? serviceMessage(code);
}
/**
 * A 需处理 group's title: the problem itself, or for a code without a phrase
 * (such as “archive-step-failed”) the step that did not finish.
 */
export function issueTitle(code: string, stepName: string): string {
  return problemPhrase(code) ?? `“${stepName}”没有完成`;
}
/**
 * What a translation problem in 需处理 means for the paper and what to do
 * (technical 04 §9.3): the full text reads as before; resuming fills in only
 * the paragraphs still missing. Null for any other problem.
 */
export function translationIssueHint(code: string): string | null {
  return code === "translation-incomplete"
    ? "全文照常可读，没有译文的段落显示原文。继续解析全文只补这些段落。"
    : code === "translation-unavailable"
      ? "全文照常可读，这篇还没有完整的译文。确认模型可用后继续解析全文即可补上。"
      : code === "layers-incomplete"
        ? "全文照常可读，这篇没有概览与脉络：核对后留下的要点太少。继续解析全文会重做分层。"
        : code === "layers-unavailable"
          ? "全文照常可读，这篇还没有概览与脉络。确认模型可用后继续解析全文即可补上。"
          : code === "layers-translation-incomplete"
            ? "概览与脉络照常可读，只有原文一种读法。继续解析全文会补上它们的译文。"
            : null;
}

/**
 * 全文检索 (technical 04 §9.7): words are matched as written, translations
 * stored when the full text was parsed are indexed too, Chinese, Japanese
 * and Korean by character; the index line says when its rule is older.
 */
export const retrievalStrings = {
  hanNote:
    "按词匹配，不扩展同义词。解析全文时存下的译文也在索引里，用中文可以搜到英文资料。",
  translated: "译文",
  translatedLabel: "命中的是库中的译文，出处是原文的这一段",
  /** Before a translated hit's text in the copied context. */
  translatedNote: (language: string) =>
    `译文（机器翻译，${translationLanguageName(language)}）；引用请以出处的原文为准。`,
  kindsAll: "全文与知识",
  kindsSource: "仅全文",
  kindsKnowledge: "仅知识",
  noHitsHint: "可以换成全文里的用词，或在高级检索选项里放宽范围。",
  indexMissing: "还没有全文索引，全文和书目都搜不到。",
  indexMissingBuild:
    "还没有全文索引，全文和书目都搜不到。建立约需几分钟，可以离开本页。",
  indexCorruptRebuild:
    "将从已有材料重新建立全文索引，约需几分钟，可以离开本页。完成前全文和书目都搜不到。",
  indexRebuildSource:
    "从已保存的书目、全文与库中的译文重新建立全文索引，不下载 PDF、解析材料或调用模型。平时索引会随文献变化自动更新，只在索引缺失、损坏或检索结果明显不对时需要重建。",
  ruleOld: "检索规则已更新，需要重建索引。",
  languageChanged: "译文语言已更改，需要重建索引。",
  rebuild: "重建索引",
  rebuildTitle: "重建全文索引？",
  rebuildDescription:
    "将按当前规则从已有材料重新建立全文索引，约需几分钟，在后台进行，期间旧索引照常可搜。可以离开本页，完成后自动生效。",
  libraryOld: "书目检索按旧规则，中文的部分词查不到。",
  libraryRewrite: "重写书目检索",
  libraryRewriteTitle: "重写书目检索？",
  libraryRewriteDescription:
    "按当前规则重写全部文献的书目检索，不改动书目本身；文献多时需要一些时间，完成前照常可搜。",
  libraryRewriting: "正在重写书目检索，完成前照常可搜。",
  libraryRewritten: (count: number) =>
    `书目检索已按新规则重写，共 ${count.toLocaleString("zh-CN")} 篇。`,
  libraryFailed: "书目检索没有重写完，可以重试。",
} as const;
/** 找文献 → Zotero, as it stands: the import program, not yet the extension. */
export const intakeStrings = {
  zotero:
    "在装了 Zotero 的电脑上运行 Zotero 导入程序，把一个库或其中几个分类连同标签和 PDF 导入文献库；可以让 Agent 代为运行，也可以自己运行。PDF 上的批注在这个 PDF 与库里这篇文献的主 PDF 相同时一并导入。扩展里的“从 Zotero 导入”尚未开放。",
  zoteroGuide:
    "做法见使用说明《导入文献》的“Zotero”一节（docs/guides/importing.md）。只要书目和 PDF 时，也可以在 Zotero 里导出 BibTeX 或 RIS，再从“文件”导入。",
  /** 找文献 → 文件: what a drop may hold (literature materials 6.4.14). */
  supported:
    "支持 PDF；BibTeX、BibLaTeX、RIS、CSL JSON、EndNote（.enw、.xml）、NoteExpress（.net）导出文件，以及知网、万方、维普导出的 EndNote 与 NoteExpress 文本",
  supportedAttachments:
    "导出文件里的附件路径只用来配对同时放入的 PDF，不读取路径所指的文件。",
  /** The format names a drop's export may be read in. */
  formats: {
    bibtex: "BibTeX",
    biblatex: "BibLaTeX",
    ris: "RIS",
    "csl-json": "CSL JSON",
    "endnote-tagged": "EndNote（.enw）",
    "endnote-xml": "EndNote XML",
    noteexpress: "NoteExpress",
  },
  gb18030: "按 GB18030 编码读出",
  encodingRefused: (format: string) =>
    `这个文件不是 UTF-8 编码，${format} 只接受 UTF-8；请另存为 UTF-8 后再放入，或选择别的格式。`,
  undecodable: "这个文件既不是 UTF-8 也不是 GB18030 编码，读不出文字。",
  /** A batch's “批注” item (literature materials 6.4.13). */
  annotationsImportable: "可导入",
  annotationsImported: "已导入",
  annotationsWaiting: "等文件",
  annotationsUnit: "条",
  annotationsSkipped: "不导入的批注",
  annotationReasons: {
    "unsupported-kind": "种类不支持（便笺、文字框、手绘）",
    "annotation-other-file": "在这篇文献的其他附件上",
    "pdf-differs": "Zotero 里的 PDF 与库里的主 PDF 不同",
    "file-missing": "PDF 文件没有交来",
    "position-invalid": "位置无法确定",
    "comment-too-long": "评论超过 20,000 个字符",
    "quote-invalid": "原文为空或超过 4,000 个字符",
    "already-imported": "已经导入过",
  },
} as const;
/** A translation language by the name it has for its readers (“简体中文”). */
export function translationLanguageName(code: string): string {
  return TRANSLATION_LANGUAGES.find((l) => l.code === code)?.label ?? code;
}
/**
 * The full-text view and its three readings (reading-experience 9, ADR
 * 0068): the view is “全文”; “原文” is only the author's own language.
 */
export const fullTextStrings = {
  view: "全文",
  readings: "全文读法",
  reading: {
    original: "原文",
    translation: "译文",
    bilingual: "对照",
  },
  /** What the page header adds after the text level. */
  header: {
    translation: "译文（机器翻译）",
    bilingual: "对照",
  },
  untranslated: "未译",
  /** The right-margin sign of a paragraph with marks, in the translation reading. */
  marks: (count: number) => `批注 ${count}`,
  marksAction: (count: number) =>
    `这段有 ${count} 条批注，切到对照并定位到这一段`,
  loading: "正在读取译文…",
  loadFailed: "译文没有读到，按原文显示。",
  download: "下载全文",
  downloadAs: {
    original: "原文",
    translation: "译文",
    bilingual: "对照",
  },
  /** The side panel's translation that came from the library, not from a model. */
  stored: "库中的译文",
  /** The 翻译 tab of a deployment without a translation service (stored translations only). */
  storedOnly:
    "没有配置翻译服务，划词翻译不可用。段落上右键“翻译本段”显示库中的译文。",
  storedPlaceholder: "库中的译文会显示在这里。",
  noStored: "这一段没有库中的译文。",
  pdfOpen: "对照翻译",
  pdfReading: (done: number, total: number) =>
    `正在读取译文 ${done} / ${total} 页`,
  pdfFailed: (count: number) => `${count} 页的译文没有读到`,
  pdfPartial: "部分段落没有译文，显示原文。",
  pdfClose: "关闭译文",
  pdfStop: "停止",
  pdfRetry: "重试",
  pdfMode: "译文显示",
  pdfPair: "对照",
  pdfOnly: "只看译文",
  settingsTitle: "翻译",
  settingsDescription:
    "解析全文的“翻译”一步把校订好的全文逐段译成这种语言，存进文献库；阅读页的“译文”“对照”与 PDF 的对照翻译读的都是它。",
  settingsLanguage: "译文语言",
  settingsLanguageHelp:
    "在配置文件的 [translation] 一节改 target_language，重启服务后生效。只影响以后的解析全文，已有的译文保留。",
} as const;
/**
 * The reading layers (reading-experience 3.1–3.3.3, 3.8, 3.9; ADR 0069):
 * 概览, 脉络 and 全文 are one page folded three ways.
 */
export const layerStrings = {
  names: ["概览", "脉络", "全文"] as const,
  /** What the page header says the layer rests on (spec 1.2). */
  basis: (level: "draft" | "proofread" | null) =>
    level === "draft" ? "基于未校对的全文" : "基于已校对的全文",
  points: (count: number) => `要点 ${count} 项`,
  digest: "提要",
  digestKinds: {
    nature: "这是一份什么资料",
    limits: "局限与未决事项",
    advice: "精读建议",
  },
  notGiven: "原文未给出",
  folded: (lines: number) => `${lines} 行`,
  expand: "展开这一段",
  collapse: "收起",
  marks: (count: number) => `批注 ${count}`,
  evidence: (count: number) => `证据 ${count}`,
  farther: "远一层",
  nearer: "近一层",
  view: (name: string) => `切换到${name}`,
  keys: "标出重点词",
  /** The view switch's group, for assistive technology. */
  group: "阅读层",
  /** The information panel's “概览与脉络” row (spec 1.4, 3.9). */
  material: "概览与脉络",
  present: "有",
  /** One line under the page header when the layers belong to an older text (spec 3.1). */
  staleLine: "全文改过，概览与脉络还没有更新；再解析一次全文即可更新。",
  ready: "概览与脉络已可用。",
  /** 译文 and 对照 in a paper whose layers have no translation part (spec 3.4.1). */
  noTranslation: "这篇的概览与脉络没有译文；再解析一次全文即可补上",
  readFailed: "概览与脉络没有读到，按全文显示。",
} as const;
/**
 * Why a paper has no 概览 and 脉络 (reading-experience 3.9, 3.8): before
 * the full text is parsed or while it is a draft; a proofread text parsed
 * before layering was a step (or the step failed); the text edited since; a
 * long document; too short. Null when there are layers to read.
 */
export function layersUnavailable(
  state: "none" | "complete" | "stale" | "not-applicable" | null,
  reason: "long-document" | "too-short" | null,
  level: TextLevel | null,
): string | null {
  if (state === "complete") return null;
  if (state === "stale") return "全文改过，概览与脉络还没有更新";
  if (state === "not-applicable")
    return reason === "too-short"
      ? "这篇太短，不提供概览与脉络"
      : "长文档暂不提供概览与脉络";
  if (level === "proofread")
    return "这篇解析全文时还没有产生概览与脉络；再解析一次全文即可补上";
  return "概览与脉络在解析全文时产生";
}
/**
 * Why “译文” and “对照” cannot be chosen (reading-experience 9): no
 * translation yet — before the full text is parsed, or for a proofread text
 * parsed before translating was a step — the text is already in that
 * language, or the text was edited after it was translated. Null when there
 * is a translation to read. `level` is the full text's, null without one.
 */
export function translationUnavailable(
  state: DocumentTranslationState | null,
  language: string,
  level: TextLevel | null = null,
): string | null {
  if (state === "complete" || state === "partial") return null;
  if ((state === "none" || state === null) && level === "proofread")
    return "这篇解析全文时还没有翻译；再解析一次全文即可补上译文";
  if (state === "same-language")
    return `这篇已经是${translationLanguageName(language)}`;
  if (state === "stale")
    return "全文改过，译文还没有更新；再解析一次全文即可补上";
  return "译文在解析全文时产生";
}

const valueCheckReasons: Readonly<Record<string, string>> = {
  "synthesis-requires-interpretation":
    "这是综合结论，不做原文比对；请查看所链接来源结果各自的核对状态。",
  "corrected-fragment-unavailable":
    "所引片段在当前已校对的全文中已不存在，无法比对。",
  "value-not-reported": "原文未报告这个值。",
  "cited-values-present":
    "值中的数字、单位或文字能在所引的已校对片段中找到；这只核对抄录，不判断科学解释。",
  "cited-value-missing": "值未能在所引的已校对片段中找到，请对照原文确认。",
  "value-evidence-missing": "没有提供这个值所依据的原文。",
};
export function valueCheckReason(code: string): string {
  return (
    valueCheckReasons[code] ??
    "这份结果没有可识别的核对原因，请查看对应原文确认。"
  );
}
export const valueCheckLabels: Readonly<Record<ProcessorCheckStatus, string>> =
  {
    found: "可找到",
    "not-found": "找不到",
    "value-null": "值为空",
    "no-citation": "无引用",
    "citation-unavailable": "引用片段不可用",
    derived: "综合值",
  };
export const valueCheckBasisLabels: Readonly<Record<ProofreadBasis, string>> = {
  "text-layer": "PDF 自带的文字",
  "image-only": "图像页转写",
  manual: "人工修改",
};

const probeReasons: Readonly<Record<string, string>> = {
  "model-authentication-rejected":
    "模型服务拒绝了 API key，请在“模型服务”里检查这个服务的密钥。",
  "model-quota-limited": "模型服务限流或额度已用完，稍后再试或检查账户余额。",
  "model-provider-unavailable": "模型服务出错（5xx），稍后再试。",
  "model-request-rejected":
    "模型服务拒绝了请求：远程名称可能写错，或这个模型不支持结构化输出。",
  "model-timeout": "模型服务超时没有回应，稍后再试。",
  "model-network-failed": "连不上模型服务，请检查网络或服务地址。",
  "model-identity-mismatch": "服务返回的模型名称与登记的远程名称不一致。",
  "model-response-invalid": "模型的回复不符合要求，请检查模型声明。",
  "model-request-invalid": "请求没有发出：请检查服务商声明与凭据。",
  "model-capability-unsupported": "这个模型不具备所需能力，请换一个模型。",
  "model-probe-cancelled": "测试被中断，请重试。",
  "probe-not-authorized": "测试需要确认后才会访问外部服务。",
  "proxy-unavailable": "连不上代理，或代理拒绝了连接。请在“网络”分区测试代理。",
  "proxy-test-target-unavailable": "测试用的公网主机暂时无法解析，稍后再试。",
  "network-proxy-required": "还没有保存代理地址。",
};
/** Why a configuration probe did not pass; an unknown reason shows its code. */
export function probeReason(code: string): string {
  return probeReasons[code] ?? `没有通过（${code}）。`;
}

/**
 * Why a line of a `lookup` batch did not go in (literature materials 6.4.12),
 * said to the reader; an unknown reason falls back to the service's message.
 */
const lookupReasons: Readonly<Record<string, string>> = {
  "lookup-unsupported-url":
    "不支持这个网址：网址里要有 DOI，或者是 arXiv、PubMed 的文献页",
  "lookup-too-short": "标题太短，不足 10 个字符",
  "lookup-too-long": "太长，超过 500 个字符，不像一个标题",
  "duplicate-line": "与前面的一行是同一篇",
  "lookup-candidates": "有几篇可能是它，没有挑选",
  "lookup-unrecognized": "没有认出，没有选择仍然入库",
  excluded: "决定不入库",
};
export function lookupReason(code: string): string {
  return lookupReasons[code] ?? serviceMessage(code);
}

/** Transport diagnostics are codes, never copy for a human-facing notification. */
export function serviceMessage(code: string): string {
  return (
    (
      {
        "invalid-contract": "返回内容无法通过验证，未显示不匹配的材料。",
        "contract validation failed":
          "返回内容无法通过验证，未显示不匹配的材料。",
        "command-rejected": "任务操作未被接受，请刷新任务状态后重试。",
        "configuration-conflict": "配置已被其他操作修改，请刷新后核对草稿。",
        "manual-pdf-invalid": "文件不是可读取的 PDF，请选择有效的 PDF 文件。",
        "primary-asset-conflict": "这篇文献已有主 PDF，不能直接替换。",
        "folder-name-conflict": "同一层已有同名文件夹，请换一个名称。",
        "filter-name-conflict": "已有同名的筛选，请换一个名称。",
        "filter-limit": "保存的筛选已达 200 项上限，请先删除不用的筛选。",
        "filter-not-found": "这项筛选已不存在，请刷新后重试。",
        "filter-condition-invalid": "当前筛选条件不合格，未保存。",
        "folder-cycle": "不能把文件夹移到它自己或它的子文件夹中。",
        "folder-not-found": "文件夹已不存在，请刷新后重试。",
        "literature-not-found": "有文献已不存在，请刷新后重试。",
        "operation-not-open": "这项交付操作已关闭，不能再提交。",
        "knowledge-index-unavailable":
          "知识检索索引不可用，请先检查或重建索引。",
        "browser-network-drain-timeout":
          "浏览器网络连接未能及时关闭，请查看服务日志。",
        "browser-page-runtime":
          "页面操作没能执行（控件可能已变化或不可见），流程停止。",
        "browser-navigation-failed": "打开新页面时导航失败，流程停止。",
        "browser-navigation-retry-limit":
          "同一个链接连续两次没能打开，流程停止。",
        "publication-disk-full": "存储空间不足，材料发布未完成。",
        "device-address-mismatch":
          "连接码里的地址与本页地址不一致，请从要连接的地址打开设置页再生成。",
        "device-connection-missing": "这个设备连接已不存在，请刷新列表。",
        "device-artifact-unavailable": "skill 包尚未构建。",
        "device-unavailable": "设备连接暂不可用，请查看服务日志。",
        "intake-format-unsupported":
          "不支持这种导出格式，请选择 BibTeX、RIS 或 CSL JSON。",
        "local-identity-required":
          "这个来源只给出了本地库号，请让 Agent 经设备连接入库。",
        "intake-batch-missing": "这个批次已不存在，请刷新后重试。",
        "intake-file-missing": "清单里已没有这个文件，请刷新批次。",
        "intake-source-busy":
          "同一个来源库已有进行中的批次，请先结束或取消它。",
        "intake-batch-state": "批次状态已变化，请刷新后再操作。",
        "intake-batch-busy":
          "这一批有文献正在被任务处理，请等任务结束或取消后再撤回。",
        "pdf-reader-missing":
          "这台服务器读不了 PDF（缺少 MuPDF），不能识别书目。请管理员在程序目录执行 pnpm build 后重启服务。",
        "recognize-selection-too-large":
          "书目不全的文献超过 10,000 篇，请分批选择后再识别。",
        "recognize-selection-empty":
          "没有可以识别的文献：要书目不全并且有 PDF。",
        "library-collection-pending":
          "文献库的记录还在整理，暂时不能移出；请稍后再试。",
        "library-trash-busy":
          "其中有文献正在被任务处理，请等任务结束或取消后再删除。",
        "intake-data-changed": "批次数据在确认前有变化，请重新预览后确认。",
        "intake-request-too-large":
          "导出文件太大，请拆成几个小于 7 MiB 的文件分别导入。",
        "intake-batch-limit":
          "超出一个批次的记录或数据上限，请拆分后分别导入。",
        "intake-metadata-pending": "书目还没入库完，稍后再结束。",
        "intake-lookup-too-many":
          "一次最多 200 行（空行不算），请分成几批分别查找。",
        "intake-recognition-pending": "还在识别，完成后才能确认。",
        "intake-decision-invalid":
          "这个决定已不适用于这一条，请刷新批次后重新决定。",
        "intake-file-hash-required":
          "这篇文献已有 PDF，只需核对文件，不需上传。",
        "intake-input-invalid": "入库内容无效，请检查后重试。",
        "intake-item-empty": "没有标识、标题或文件，无法收藏。",
        "intake-pdf-invalid": "这个文件不是可接受的 PDF。",
        "intake-disk-space": "存储空间不足，入库未完成。",
        "intake-unavailable": "入库暂不可用，请查看服务日志。",
        "device-purpose-forbidden": "这个连接没有所需的用途。",
        "invalid-request": "请求内容无效，请检查填写的内容。",
        "invalid-input": "输入内容无效，请检查后重试。",
        "not-found": "所需内容不存在或已被移除。",
        "library-unavailable": "文献库暂时不可用，请检查服务状态。",
        "catalog-schema-refused": "数据库结构尚未就绪，请先完成数据库转换。",
        "catalog-layout-not-current": "数据库结构与当前程序不一致。",
        "parser-unavailable": "解析服务尚不可用，请检查解析配置。",
        "model-unavailable": "模型尚不可用，请检查模型配置。",
        "proofread-manual-stale":
          "全文已被其他操作修改。当前草稿仍保留，请对照最新版本后再保存。",
        "proofread-missing": "此材料还没有全文，请先解析全文。",
        "proofread-manual-input-conflict":
          "原始解析已变化，现有人工修订不会被自动覆盖，请先核对原稿。",
        "proofread-edit-pages-invalid":
          "全文的页定位无效，请重新读取当前版本后核对。",
        "proofread-renderer-unavailable":
          "PDF 页面渲染器不可用，请检查浏览器运行环境。",
        "network-error": "网络连接失败，请检查连接后重试。",
        "Failed to fetch": "网络连接失败，请检查连接后重试。",
        "fetch failed": "网络连接失败，请检查连接后重试。",
        "request-cancelled": "操作已取消。",
        "network-proxy-invalid": "代理地址只接受 http://主机:端口。",
        "network-proxy-required":
          "有服务选择了走代理，代理地址不能为空。请先取消这些选择，或填写代理地址。",
        "network-source-unknown": "走代理的来源中有未知项，请刷新配置后重试。",
        "network-provider-unknown":
          "走代理的模型服务中有已删除的模型服务，请刷新配置后重试。",
        "network-local-target":
          "本机或局域网上的服务始终直连，不能选择走代理。",
        "network-target-unresolved":
          "无法解析所选服务的域名，暂时不能确认它不在局域网内，请稍后再试。",
        "archive-tagging": "解析全文时自动生成标签",
        "correction-failed": "本次矫正未完成",
        "correction-edit-conflict": "矫正与当前文字存在冲突，请重新核对",
        "page-content-missing": "页面正文尚未完整确认",
      } as Record<string, string>
    )[code] ?? "操作未完成，请重试；若问题持续，请查看任务详情或服务日志。"
  );
}

export const sectionRoleNames: Record<string, string> = {
  title: "标题",
  authors: "作者",
  "end-matter": "文末信息",
  additional: "其他章节",
  "front-matter": "前置信息",
  abstract: "摘要",
  keywords: "关键词",
  introduction: "引言",
  methods: "方法",
  results: "结果",
  discussion: "讨论",
  "results-discussion": "结果与讨论",
  conclusion: "结论",
  acknowledgements: "致谢",
  references: "参考文献",
  appendix: "附录",
  body: "正文",
  "si-methods": "补充方法",
  "si-characterization": "补充表征",
  "si-computation": "补充计算",
  "si-tables": "补充表格",
  "si-figures": "补充图片",
  "si-references": "补充引用",
};

export function processorName(id: string): string {
  return (
    (
      {
        summary: "全文总结",
        labels: "问答标注",
        records: "记录提取",
        "knowledge-synthesis": "多篇综合",
      } as Record<string, string>
    )[id] ?? "自定义算子"
  );
}

export function agentRoleName(role: string) {
  return (
    (
      {
        analysis: "分析与总结",
        summary: "文献总结",
        "archive-metadata": "元数据补全",
        "archive-structure": "章节角色",
        "archive-tags": "文献标签",
        proofreading: "原文校订",
        "value-checking": "用值核对",
        tagging: "文献标签",
        "tag-consolidation": "词表整理",
        "tag-backfill": "标签回溯",
        browser: "浏览器",
      } as Record<string, string>
    )[role] ?? "Agent 处理"
  );
}
export function agentEventName(kind: string) {
  return (
    (
      {
        input: "读取任务材料",
        "model-request": "模型调用",
        "tool-start": "调用工具",
        "tool-result": "工具返回",
        "tool-failed": "工具失败",
        submission: "提交内容",
        usage: "用量更新",
      } as Record<string, string>
    )[kind] ?? "过程记录"
  );
}

export function estimateStageName(kind: string) {
  return (
    (
      {
        document: "逐篇处理",
        synthesis: "综合汇总",
        "mapped-documents": "逐篇阅读",
        arrange: "整理",
        proofread: "校订",
        render: "全文发布",
        translate: "翻译",
        layers: "分层",
        references: "引用关系",
        structure: "结构",
        metadata: "元数据",
        tags: "标签",
        backfill: "标签回溯",
        consolidate: "词表整理",
        "parse-documents": "解析（不调用语言模型）",
        "assess-article-identity": "文章身份核验",
        "build-archive": "按指定步骤解析全文",
      } as Record<string, string>
    )[kind] ?? "处理"
  );
}

export function processorMapStatus(status: string) {
  return (
    (
      {
        pending: "等待逐篇读取",
        running: "正在读取",
        computed: "新计算完成",
        reused: "复用已有结果",
        partial: "部分完成",
        failed: "读取失败",
        interrupted: "已中断",
        "not-recorded": "本次未记录逐篇状态",
      } as Record<string, string>
    )[status] ?? "状态待核对"
  );
}
const localTimeFormat = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
/** Machine timestamps are shown in the viewer's local time, to the minute. */
export function localTime(value: unknown): string {
  const date = new Date(String(value));
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : localTimeFormat.format(date);
}
/**
 * Design core rule 6, the one way a time is written: today only the clock
 * (14:28), this year the day and clock (11月19日 14:28), an earlier year the
 * date (2025年11月19日). `localTime` gives the full time for hover.
 */
export function shortTime(value: unknown, now: Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return "时间未知";
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.getFullYear() !== now.getFullYear())
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  if (date.getMonth() === now.getMonth() && date.getDate() === now.getDate())
    return clock;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}
