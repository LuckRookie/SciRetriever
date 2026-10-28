import type {
  AcquisitionAttempt,
  AcquisitionRoute,
  AcquisitionRouteState,
} from "@sciretriever/contracts";
import { serviceMessage } from "../strings.js";

/** Display names for acquisition routes; unknown ids stay as ids. */
const SOURCES: Readonly<Record<string, string>> = {
  direct: "直链",
  "doi-landing": "DOI 落地页",
  arxiv: "arXiv",
  "europe-pmc": "Europe PMC",
  elsevier: "Elsevier API",
  wiley: "Wiley API",
  springer: "Springer API",
  core: "CORE",
  unpaywall: "Unpaywall",
  "sci-hub": "Sci-Hub",
  browser: "Browser Agent",
  "web-of-science": "Web of Science",
  crossref: "Crossref",
  "semantic-scholar": "Semantic Scholar",
  openalex: "OpenAlex",
  datacite: "DataCite",
  opencitations: "OpenCitations",
  plos: "PLOS",
};
export const STAGES: Readonly<Record<AcquisitionRoute["stage"], string>> = {
  direct: "直链",
  "publisher-api": "出版社 API",
  "general-api": "通用 API",
  "public-web": "公开网站",
  browser: "Browser Agent",
};
export const sourceName = (source: string) => SOURCES[source] ?? source;

/** Why a route is in the list, or why it cannot run. */
export function routeStatus(route: AcquisitionRoute) {
  if (!route.ready)
    return `不可用：${codeText(route.unavailable_code ?? "unavailable")}`;
  return {
    "auto-default": "已启用（默认）",
    "auto-configured": "已启用（已配凭据）",
    custom: "已启用（自定义）",
    builtin: "已启用（内置）",
  }[route.mode_reason];
}

const RESULTS: Readonly<Record<AcquisitionAttempt["result"], string>> = {
  hit: "命中",
  miss: "未命中",
  "not-applicable": "不适用",
  "not-enabled": "未启用",
  unavailable: "不可用",
  failed: "错误",
  cooldown: "冷却中",
  rejected: "候选被拒",
  escalated: "交给 Agent",
};
/** A platform code in words; unknown codes stay visible as codes. */
function codeText(code: string) {
  const known = serviceMessage(code);
  return known === serviceMessage("") ? code : known;
}

/**
 * One line per paper: each tried source and its result, in order. Sources the
 * platform skipped without a request read as skipped, never as a miss.
 */
export function attemptsLine(attempts: readonly AcquisitionAttempt[]) {
  return attempts
    .map((attempt) =>
      attempt.result === "escalated"
        ? "→ 交给 Agent"
        : `${sourceName(attempt.source)} ${RESULTS[attempt.result]}`,
    )
    .join(" · ")
    .replace(" · →", " →");
}
/** Full text for a hover title: adds codes and whether a request was sent. */
export function attemptsDetail(attempts: readonly AcquisitionAttempt[]) {
  return attempts
    .map(
      (attempt) =>
        `${STAGES[attempt.stage]} · ${sourceName(attempt.source)}：${RESULTS[attempt.result]}${attempt.requested ? "" : "（未发出请求）"}${attempt.code ? `，${codeText(attempt.code)}` : ""}`,
    )
    .join("\n");
}

export type { AcquisitionRouteState };
