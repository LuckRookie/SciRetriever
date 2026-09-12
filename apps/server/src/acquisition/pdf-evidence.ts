import {
  acceptPdf,
  readPdfTool,
  PdfAcceptanceError,
} from "./pdf-acceptance.js";
import { judgeIdentity, type IdentityVerdict } from "./identity-verdict.js";

export interface PdfIdentityAssessment {
  readonly page_count: number;
  readonly verdict: IdentityVerdict;
}

/** Evidence comes from bounded PDF text, never from a download name or Agent claim. */
export async function assessPdfIdentity(
  bytes: Uint8Array,
  targetIdentifier: string,
  targetVersion: string,
  signal?: AbortSignal,
): Promise<PdfIdentityAssessment> {
  if (signal?.aborted) throw new PdfAcceptanceError();
  const accepted = await acceptPdf(bytes, 10000, signal);
  const text = await readPdfTool(bytes, "pdftotext", 10000, signal);
  const identifiers = [
    ...new Set(
      [...text.matchAll(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/giu)].map(
        (match) => `doi:${match[0].replace(/[.,;]+$/u, "").toLowerCase()}`,
      ),
    ),
  ];
  const version =
    /\bVersion:\s*(published|accepted-manuscript|preprint|other)\b/iu
      .exec(text)?.[1]
      ?.toLowerCase();
  const verdict = judgeIdentity({
    targetIdentifier: targetIdentifier.toLowerCase(),
    targetVersion,
    isPdf: accepted.accepted,
    ...(identifiers.length === 1
      ? { candidateIdentifier: identifiers[0]! }
      : {}),
    ...(version ? { candidateVersion: version } : {}),
  });
  return Object.freeze({ page_count: accepted.page_count, verdict });
}
