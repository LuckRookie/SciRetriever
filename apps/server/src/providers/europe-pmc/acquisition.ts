import type {
  AcquisitionSourcePort,
  AcquisitionSourceRequest,
} from "../../acquisition/ports.js";
import { type SourceCandidate } from "../../acquisition/sources/locators.js";
import { dedupe, values } from "../shared/acquisition-locators.js";
import { europePmcPdf } from "./locators.js";
export class EuropePmcPdfSource implements AcquisitionSourcePort {
  readonly source_name = "europe-pmc" as const;
  readonly ready = true;
  async discover(
    request: AcquisitionSourceRequest,
  ): Promise<readonly SourceCandidate[]> {
    return dedupe(
      values(request, "pmcid").flatMap((identifier) => {
        try {
          return [europePmcPdf(identifier)];
        } catch {
          return [];
        }
      }),
    );
  }
}
