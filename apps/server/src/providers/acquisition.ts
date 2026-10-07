import type { AcquisitionSourceRequest } from "../acquisition/ports.js";
import * as core from "./core/acquisition.js";
import * as elsevier from "./elsevier/acquisition.js";
import type {
  AuthorizedDownloadLocator,
  AuthorizedLookupTarget,
  AuthorizedProvider,
} from "./shared/authorized-pdf.js";
import * as wiley from "./wiley/acquisition.js";
const routes = Object.freeze({ core, elsevier, wiley });
export function authorizedTargets(
  provider: AuthorizedProvider,
  request: AcquisitionSourceRequest,
): readonly AuthorizedLookupTarget[] {
  return routes[provider].targets(request);
}
export function authorizedUrl(
  provider: AuthorizedProvider,
  locator: AuthorizedDownloadLocator,
): string {
  return routes[provider].candidateUrl(locator);
}
