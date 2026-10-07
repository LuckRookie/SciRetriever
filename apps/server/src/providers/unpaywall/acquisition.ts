import type {
  AcquisitionSourcePort,
  AcquisitionSourceRequest,
  PublicAcquisitionTransport,
} from "../../acquisition/ports.js";
import { type SourceCandidate } from "../../acquisition/sources/locators.js";
import { values } from "../shared/acquisition-locators.js";
import { services } from "./definition.js";
import { unpaywallLocations } from "./locators.js";
function email(value: string): string {
  const normalized = value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(normalized))
    throw new TypeError("Unpaywall email is invalid");
  return normalized;
}
export class UnpaywallSource implements AcquisitionSourcePort {
  readonly source_name = "unpaywall" as const;
  readonly ready = true;
  private readonly contact: string;
  private readonly origin: URL;
  constructor(
    private readonly transport: PublicAcquisitionTransport,
    options: { readonly email: string; readonly origin?: string },
  ) {
    this.contact = email(options.email);
    this.origin = new URL(options.origin ?? services.unpaywall.endpoint);
    if (
      this.origin.protocol !== "https:" ||
      this.origin.username ||
      this.origin.password
    )
      throw new TypeError("Unpaywall origin must be HTTPS");
  }
  async discover(
    request: AcquisitionSourceRequest,
    signal?: AbortSignal,
  ): Promise<readonly SourceCandidate[]> {
    const doi = values(request, "doi")[0];
    if (!doi) return [];
    const url = new URL(
      `${this.origin.toString().replace(/\/$/u, "")}/v2/${doi
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
    );
    url.searchParams.set("email", this.contact);
    const response = await this.transport.request(url.toString(), {
      ...(signal ? { signal } : {}),
      headers: { accept: "application/json" },
    });
    if (!response || typeof response !== "object" || Array.isArray(response))
      throw new Error("Unpaywall response is invalid");
    const record = response as Record<string, unknown>;
    const locations = [
      ...(Array.isArray(record.best_oa_location)
        ? record.best_oa_location
        : record.best_oa_location
          ? [record.best_oa_location]
          : []),
      ...(Array.isArray(record.oa_locations) ? record.oa_locations : []),
    ].flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const value = item as Record<string, unknown>;
      const location = {
        ...(typeof value.url_for_pdf === "string"
          ? { url: value.url_for_pdf }
          : typeof value.url === "string"
            ? { url: value.url }
            : {}),
        ...(typeof value.version === "string"
          ? { version: value.version }
          : {}),
        ...(typeof value.host_type === "string"
          ? { host_type: value.host_type }
          : {}),
        direct_pdf: typeof value.url_for_pdf === "string",
      };
      return [location];
    });
    return unpaywallLocations(locations);
  }
}
