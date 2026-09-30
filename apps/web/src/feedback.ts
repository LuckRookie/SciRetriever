import type {
  WorkbenchCandidate,
  WorkbenchView,
} from "@sciretriever/contracts";

/** Candidate wording follows verified publication and the actual operation terminal. */
export function candidateStatus(
  view: WorkbenchView,
  candidate: WorkbenchCandidate,
): string {
  if (candidate.publication) return "已发布到当前文献";
  if (view.mode !== "production")
    return candidate.disposition === "accepted"
      ? "身份与版本已核验"
      : "候选已保存，身份待确认";
  const operation = view.operation_feedback;
  if (operation?.primary_pdf?.sha256 === candidate.sha256)
    return "已接纳并提交为当前主 PDF";
  if (
    operation?.phase === "ended" ||
    ["failed", "cancelled", "finished"].includes(view.state)
  )
    return "操作已结束，本次候选未确认提交；请查看最终报告";
  if (candidate.disposition === "accepted")
    return "候选已捕获且身份与版本已核验，等待提交";
  if (candidate.disposition === "rejected") return "候选未通过身份检查";
  return "候选已捕获，身份待确认";
}
