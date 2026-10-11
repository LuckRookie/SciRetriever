import { definition } from "./definition.js";
import type {
  AcquisitionSourcePort,
  AcquisitionSourceRequest,
} from "../../acquisition/ports.js";
import { type SourceCandidate } from "../../acquisition/sources/locators.js";
import { dedupe, values } from "../shared/acquisition-locators.js";
import { arxivPdf } from "./locators.js";
export class ArxivPdfSource implements AcquisitionSourcePort {
  readonly source_name = "arxiv" as const;
  readonly ready = true;
  readonly acquisition_stage = definition.acquisitionStage!;
  async discover(
    request: AcquisitionSourceRequest,
  ): Promise<readonly SourceCandidate[]> {
    return dedupe(
      values(request, "arxiv").flatMap((identifier) => {
        try {
          return [arxivPdf(identifier)];
        } catch {
          return [];
        }
      }),
    );
  }
}
