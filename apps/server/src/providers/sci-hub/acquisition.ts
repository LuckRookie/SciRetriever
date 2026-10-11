import { definition } from "./definition.js";
import type {
  AcquisitionSourcePort,
  AcquisitionSourceRequest,
} from "../../acquisition/ports.js";
import {
  safeLocator,
  type SourceCandidate,
} from "../../acquisition/sources/locators.js";
import { dedupe, values } from "../shared/acquisition-locators.js";
import { configuredMirrors } from "./locators.js";
export class ConfiguredSciHubSource implements AcquisitionSourcePort {
  readonly source_name = "sci-hub" as const;
  readonly ready = true;
  readonly acquisition_stage = definition.acquisitionStage!;
  private readonly mirrors: readonly SourceCandidate[];
  constructor(urls: readonly string[]) {
    this.mirrors = configuredMirrors(true, urls);
  }
  async discover(
    request: AcquisitionSourceRequest,
  ): Promise<readonly SourceCandidate[]> {
    const doi = values(request, "doi")[0];
    if (!doi) return [];
    return dedupe(
      this.mirrors.flatMap((mirror) => {
        try {
          const url = new URL(mirror.locator);
          // Keep the DOI slash as a path separator. Network rejects encoded
          // separators (`%2F`) at the transport boundary, and Sci-Hub-style
          // mirrors conventionally expose DOI paths as `/10.xxxx/suffix`.
          url.pathname = `${url.pathname.replace(/\/$/u, "")}/${doi
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`;
          return [safeLocator(this.source_name, url.toString(), "landing")];
        } catch {
          return [];
        }
      }),
    );
  }
}
