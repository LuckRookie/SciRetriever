export const sectionLabels = {
  lib: "文献库",
  archive: "建档问题",
  tags: "词表",
  snapshots: "快照",
  disc: "发现",
  ins: "洞察",
  ask: "检索",
  syn: "综合",
  ext: "提取",
  task: "任务",
  web: "浏览器",
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
  title: "建档问题",
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
    extracted: "已提取",
    "not-reported": "原文未报告",
    "part-absent": "无该部分",
    incomplete: "读取不完整",
  },
  steps: {
    proofread: "校订",
    document: "全文发布",
    structure: "章节结构",
    metadata: "元数据",
    references: "引用关系",
    tags: "文献标签",
  },
} as const;

export function archiveReason(code: string): string {
  return (
    (
      {
        ...archiveStrings.steps,
        "raw-parse": "原始解析",
        "primary-pdf": "获取 PDF",
        "tags-failed": "标签生成失败",
        "needs-parse": "需要先解析 PDF",
        "proofread-incomplete": "校订尚未完成",
        "correction-model-unconfigured": "矫正模型未配置",
        "correction-budget-exhausted": "本次矫正预算已用完，可继续",
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
  "mapped-verification-retained": "沿用来源中同一数值的核对结果。",
  "synthesis-requires-interpretation":
    "这是综合结论，来源核对结果不能直接证明这条新结论。",
  "corrected-fragment-unavailable": "没有可用于核对的校订原文片段。",
  "value-not-reported": "原文未报告这个值。",
  "cited-values-present":
    "数字和单位能在所引校订片段中找到；这只核对抄录，不判断科学解释。",
  "cited-value-missing":
    "有数字或单位未能在所引校订片段中找到，请对照原文确认。",
  "visual-model-unavailable":
    "图像核对模型未配置，或不支持所需的图像与工具能力。",
  "pdf-region-unavailable": "原始 PDF 区域暂时无法渲染，未进行图像核对。",
  "visual-budget-exhausted": "本次图像核对额度已用完。",
  "visual-verification-incomplete": "图像核对尚未完成。",
  "visual-value-confirmed": "已对照原始 PDF 图像核对。",
  "visual-value-uncertain": "对照图像后仍无法确认，请查看对应原文。",
  "value-evidence-missing": "没有提供这个值所依据的原文。",
  "value-verification-uncertain": "部分内容仍待确认，展开下面的来源查看原因。",
  "value-verification-confirmed": "已按各来源标注完成核对。",
  "verification-not-configured": "尚未配置用时核对。",
  "external-candidate-not-visually-verified":
    "外部提交的候选尚未经过图像核对。",
};
export function valueCheckReason(code: string): string {
  return (
    valueCheckReasons[code] ??
    "这份结果没有可识别的核对原因，请查看对应原文确认。"
  );
}
export const valueCheckLabels = {
  "text-layer": "文字核对",
  "image-checked": "图像核对",
  uncertain: "存疑",
} as const;

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
        "operation-not-open": "这项交付操作已关闭，不能再提交。",
        "knowledge-index-unavailable":
          "知识检索索引不可用，请先检查或重建索引。",
        "browser-network-drain-timeout":
          "浏览器网络连接未能及时关闭，请查看服务日志。",
        "publication-disk-full": "存储空间不足，材料发布未完成。",
        "invalid-request": "请求内容无效，请检查填写的内容。",
        "invalid-input": "输入内容无效，请检查后重试。",
        "not-found": "所需内容不存在或已被移除。",
        "library-unavailable": "文献库暂时不可用，请检查服务状态。",
        "catalog-schema-refused": "数据库结构尚未就绪，请先完成数据库转换。",
        "catalog-layout-not-current": "数据库结构与当前程序不一致。",
        "parser-unavailable": "解析服务尚不可用，请检查解析配置。",
        "model-unavailable": "模型尚不可用，请检查模型配置。",
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
