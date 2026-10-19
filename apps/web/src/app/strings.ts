export const sectionLabels = {
  lib: "文献库",
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
  CONTENT_READY: "内容已就绪",
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
