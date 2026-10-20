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
  return error instanceof Error ? error.message : "操作未完成，请重试。";
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
    )[code] ?? code
  );
}
