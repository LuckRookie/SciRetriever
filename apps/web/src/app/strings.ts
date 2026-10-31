import type {
  ProcessorCheckStatus,
  ProofreadBasis,
} from "@sciretriever/contracts";

export const sectionLabels = {
  lib: "文献库",
  archive: "需处理",
  tags: "词表",
  snapshots: "快照",
  disc: "入库",
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
export const statusLabels: Readonly<Record<string, string>> = {
  UNREVIEWED: "仅元数据",
  ASSET_READY: "有 PDF",
  READY: "已就绪",
  ARCHIVING: "建档中",
  ARCHIVE_FAILED: "建档失败",
  EXCLUDED: "已排除",
  queued: "等待执行",
  running: "进行中",
  paused: "待处理",
  cancelled: "已取消",
  completed: "完成",
  complete: "完成",
  partial: "部分完成",
  failed: "失败",
  interrupted: "运行中断",
  skipped: "已跳过",
  unavailable: "不可用",
  unknown: "未知",
  pending: "等待执行",
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
  description: "按需处理影响阅读与加工的问题。解析、建档和总结都由你分别启动。",
  metadata: "字段与来源",
  continue: "继续建档",
  retry: "重试建档",
  empty: "没有待处理的建档问题",
  stats: "建档用量",
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
  "needs-parse": "还没有解析 PDF。点“建档”会先解析，再接着建档。",
  "needs-pdf": "还没有 PDF。先获取或补充 PDF。",
  blocked: "所需的前一步还没有完成，这一项暂时不能处理。",
  excluded: "文章性质为观点、评论、勘误或社论，不进入建档。",
};
export function archiveReason(code: string): string {
  return (
    (
      {
        ...archiveStrings.steps,
        "raw-parse": "原始解析",
        "primary-pdf": "获取 PDF",
        "tags-failed": "标签生成失败",
        "needs-parse": "还没有解析 PDF，重新建档会先解析",
        "parser-unavailable": "解析服务尚不可用，请检查解析配置",
        "parse-failed": "解析 PDF 没有完成",
        "proofread-incomplete": "校订尚未完成",
        "correction-model-unconfigured": "矫正模型未配置",
        "correction-budget-exhausted": "本次矫正预算已用完，可继续",
        "page-content-missing": "有页面没有解析出正文",
        "validation-repeated": "同一校验错误连续出现",
        "no-progress": "模型连续多次没有进展",
        "page-tools-unavailable": "页面图像暂不可读",
        "model-failed": "模型调用失败",
        "request-too-large": "单次请求过大",
        "response-too-large": "模型回复过大",
        "source-integrity": "原始材料校验未通过",
        "publication-conflict": "内容已被其他操作更新",
        "render-failed": "全文渲染失败",
        "input-stale": "原始解析已变化",
        "input-missing": "缺少原始解析",
        interrupted: "任务被中断",
        "configuration-option-removed": "配置中有已删除的选项",
        "manual-conflict": "初稿已变化，请核对人工修订",
        "metadata-incomplete": "元数据字段不完整",
        "structure-unsatisfied": "章节结构待确认",
        "tags-empty": "尚无有效标签",
        "part-unavailable": "补充材料尚不可用",
        "model-unavailable": "模型尚不可用",
      } as Record<string, string>
    )[code] ?? serviceMessage(code)
  );
}

const valueCheckReasons: Readonly<Record<string, string>> = {
  "synthesis-requires-interpretation":
    "这是综合结论，不做原文比对；请查看所链接来源结果各自的核对状态。",
  "corrected-fragment-unavailable":
    "所引片段在当前校订稿中已不存在，无法比对。",
  "value-not-reported": "原文未报告这个值。",
  "cited-values-present":
    "值中的数字、单位或文字能在所引校订片段中找到；这只核对抄录，不判断科学解释。",
  "cited-value-missing": "值未能在所引校订片段中找到，请对照原文确认。",
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
  "text-layer": "文字层",
  "image-only": "图像页转写",
  manual: "人工修改",
};

const probeReasons: Readonly<Record<string, string>> = {
  "model-authentication-rejected":
    "模型服务拒绝了 API key，请在凭据中检查这个服务商的密钥。",
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
};
/** Why a configuration probe did not pass; an unknown reason shows its code. */
export function probeReason(code: string): string {
  return probeReasons[code] ?? `没有通过（${code}）。`;
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
        "invalid-request": "请求内容无效，请检查填写的内容。",
        "invalid-input": "输入内容无效，请检查后重试。",
        "not-found": "所需内容不存在或已被移除。",
        "library-unavailable": "文献库暂时不可用，请检查服务状态。",
        "catalog-schema-refused": "数据库结构尚未就绪，请先完成数据库转换。",
        "catalog-layout-not-current": "数据库结构与当前程序不一致。",
        "parser-unavailable": "解析服务尚不可用，请检查解析配置。",
        "model-unavailable": "模型尚不可用，请检查模型配置。",
        "proofread-manual-stale":
          "校订版本已被其他操作修改。当前草稿仍保留，请对照最新版本后再保存。",
        "proofread-missing": "此材料尚无校订稿，请先解析并建立档案。",
        "proofread-manual-input-conflict":
          "原始解析已变化，现有人工修订不会被自动覆盖，请先核对原稿。",
        "proofread-edit-pages-invalid":
          "校订稿的页定位无效，请重新读取当前版本后核对。",
        "proofread-renderer-unavailable":
          "PDF 页面渲染器不可用，请检查浏览器运行环境。",
        "network-error": "网络连接失败，请检查连接后重试。",
        "Failed to fetch": "网络连接失败，请检查连接后重试。",
        "fetch failed": "网络连接失败，请检查连接后重试。",
        "request-cancelled": "操作已取消。",
        "archive-tagging": "建档时自动生成标签",
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
        references: "引用关系",
        structure: "结构",
        metadata: "元数据",
        tags: "标签",
        backfill: "标签回溯",
        consolidate: "词表整理",
        "parse-documents": "解析（不调用语言模型）",
        "assess-article-identity": "文章身份核验",
        "build-archive": "指定步骤建档",
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
