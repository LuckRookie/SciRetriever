import type {
  WorkbenchCandidate,
  WorkbenchView,
} from "@sciretriever/contracts";

/** Candidate wording follows verified publication and the actual operation terminal. */
export function candidateStatus(
  view: WorkbenchView,
  candidate: WorkbenchCandidate,
): string {
  if (candidate.publication) return "已发布到当前文献；文章身份未验证";
  if (view.mode !== "production")
    return candidate.disposition === "accepted"
      ? "文件检查已通过，文章身份未验证"
      : "候选已保存，身份待确认";
  const operation = view.operation_feedback;
  if (operation?.primary_pdf?.sha256 === candidate.sha256)
    return "已接纳并提交为当前主 PDF；文章身份未验证";
  if (
    operation?.phase === "ended" ||
    ["failed", "cancelled", "finished"].includes(view.state)
  )
    return "操作已结束，本次候选未确认提交；请查看最终报告";
  if (candidate.disposition === "accepted")
    return "候选文件检查已通过，文章身份未验证，等待提交";
  if (candidate.disposition === "rejected") return "候选未通过文件检查";
  return "候选已捕获，身份待确认";
}
