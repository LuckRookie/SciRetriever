import type {
  AssetHint,
  Identifier,
  MetadataObservation,
  VersionRole,
} from "@sciretriever/contracts";
import type {
  AuthorizedDownloadLocator,
  AuthorizedDownloadResult,
  AuthorizedLookupTarget,
  AuthorizedProvider,
} from "../providers/shared/authorized-pdf.js";
import type { SourceCandidate } from "./sources/locators.js";
export type AcquisitionStage =
  | "direct"
  | "publisher-api"
  | "general-api"
  | "public-web";
export interface AcquisitionSourceRequest {
  readonly identifiers: readonly Identifier[];
  readonly observations?: readonly MetadataObservation[];
  readonly asset_hints?: readonly AssetHint[];
  readonly target_version?: VersionRole;
  /** Admitted DOI landing origins from this operation only; never persisted. */
  readonly landing_origins?: readonly string[];
}
export interface AcquisitionSourcePort {
  readonly source_name: string;
  readonly ready: boolean;
  /** Acquisition order is independent of whether the source requires credentials. */
  readonly acquisition_stage?: AcquisitionStage;
  /** Legacy authentication grouping, retained for existing registry consumers. */
  readonly acquisition_tier?: "public" | "authorized-api";
  discover(
    request: AcquisitionSourceRequest,
    signal?: AbortSignal,
  ): Promise<readonly SourceCandidate[]>;
  /** Optional second phase for sources whose endpoint requires a credential grant. */
  download_candidate?(
    candidate: SourceCandidate,
    signal?: AbortSignal,
  ): Promise<AuthorizedDownloadResult | null>;
}
export interface PublicAcquisitionTransport {
  request(
    url: string,
    options?: {
      readonly signal?: AbortSignal;
      readonly headers?: Readonly<Record<string, string>>;
    },
  ): Promise<unknown>;
}
export interface AuthorizedPdfClientPort {
  readonly provider: AuthorizedProvider;
  lookup(target: AuthorizedLookupTarget):
    | {
        readonly kind: "downloads";
        readonly downloads: readonly AuthorizedDownloadLocator[];
      }
    | { readonly kind: "miss" };
  download(
    locator: AuthorizedDownloadLocator,
    signal?: AbortSignal,
  ): Promise<AuthorizedDownloadResult>;
}
