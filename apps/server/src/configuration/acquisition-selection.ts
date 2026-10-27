import {
  ACQUISITION_STAGES,
  parseAcquisitionRouteState,
  type AcquisitionRouteState,
  type AcquisitionRoute,
} from "@sciretriever/contracts";
import {
  AUTO_ACQUISITION_SOURCES,
  ACQUISITION_PROVIDER_NAMES,
  LITERATURE_PROVIDERS,
} from "../providers/registry.js";
import type { bundlePreview } from "./credentials.js";
import type { OrdinaryConfiguration } from "./index.js";
type Presence = ReturnType<typeof bundlePreview>;

/** Presence metadata only. Never authorizes or reads a credential value. */
export function acquisitionConfigurationFailure(
  configuration: Pick<OrdinaryConfiguration, "sources">,
  preview: Presence,
  source: string,
): string | null {
  const definition = LITERATURE_PROVIDERS[source];
  if (source === "unpaywall")
    return typeof configuration.sources.acquisition.unpaywall?.contact_email ===
      "string" &&
      configuration.sources.acquisition.unpaywall.contact_email.trim()
      ? null
      : "missing-ordinary-parameter";
  if (definition?.acquisition === "authorized-api")
    return definition.requiredPdfCredential &&
      preview.sections.some(
        (s) =>
          s.section === source &&
          s.fields.some(
            (f) => f.field === definition.requiredPdfCredential && f.present,
          ),
      )
      ? null
      : "missing-credential";
  return definition &&
    definition.acquisition !== "hints" &&
    definition.acquisition !== "none"
    ? null
    : "missing-source-adapter";
}
export function selectedAcquisitionSources(
  configuration: Pick<OrdinaryConfiguration, "sources">,
  preview: Presence,
): readonly string[] {
  const choice = configuration.sources.acquisition;
  if (choice.mode === "custom")
    return choice.providers.filter((source) =>
      ["public", "authorized-api"].includes(
        LITERATURE_PROVIDERS[source]!.acquisition,
      ),
    );
  return [
    ...new Set([
      ...AUTO_ACQUISITION_SOURCES,
      ...ACQUISITION_PROVIDER_NAMES.filter(
        (source) =>
          (LITERATURE_PROVIDERS[source]?.acquisition === "authorized-api" ||
            source === "unpaywall") &&
          acquisitionConfigurationFailure(configuration, preview, source) ===
            null,
      ),
    ]),
  ];
}
export function configuredAcquisitionRoutes(
  configuration: Pick<OrdinaryConfiguration, "sources" | "browser">,
  preview: Presence,
): readonly AcquisitionRoute[] {
  const selected = selectedAcquisitionSources(configuration, preview);
  const rows: AcquisitionRoute[] = [
    { source: "direct", stage: "direct", mode_reason: "builtin", ready: true },
    ...selected
      .filter((source) => source !== "sci-hub")
      .map((source) => {
        const code = acquisitionConfigurationFailure(
          configuration,
          preview,
          source,
        );
        return {
          source,
          stage:
            LITERATURE_PROVIDERS[source]?.acquisitionStage ??
            ("direct" as const),
          mode_reason:
            configuration.sources.acquisition.mode === "custom"
              ? ("custom" as const)
              : AUTO_ACQUISITION_SOURCES.includes(source)
                ? ("auto-default" as const)
                : ("auto-configured" as const),
          ready: code === null,
          ...(code ? { unavailable_code: code } : {}),
        };
      }),
    {
      source: "doi-landing",
      stage: "public-web",
      mode_reason: "builtin",
      ready: true,
    },
  ];
  if (selected.includes("sci-hub"))
    rows.push({
      source: "sci-hub",
      stage: "public-web",
      mode_reason:
        configuration.sources.acquisition.mode === "auto"
          ? "auto-default"
          : "custom",
      ready: true,
    });
  if (configuration.browser.enabled)
    rows.push({
      source: "browser",
      stage: "browser",
      mode_reason: "builtin",
      ready: true,
    });
  return Object.freeze(
    rows
      .sort(
        (a, b) =>
          ACQUISITION_STAGES.indexOf(a.stage) -
          ACQUISITION_STAGES.indexOf(b.stage),
      )
      .map((row) => Object.freeze(row)),
  );
}

/** Compare saved selection with this process without performing readiness checks. */
export function acquisitionRouteState(
  configuration: Pick<OrdinaryConfiguration, "sources" | "browser">,
  preview: Presence,
  effective: readonly AcquisitionRoute[] | null,
): AcquisitionRouteState {
  const pending = configuredAcquisitionRoutes(configuration, preview);
  // Browser runtime health is not predicted from ordinary configuration alone.
  const comparable = (rows: readonly AcquisitionRoute[]) =>
    rows.map((r) =>
      r.source === "browser"
        ? { source: r.source, stage: r.stage, mode_reason: r.mode_reason }
        : r,
    );
  const changed =
    effective === null
      ? null
      : JSON.stringify(comparable(effective)) !==
        JSON.stringify(comparable(pending));
  return parseAcquisitionRouteState({
    effective,
    pending,
    changed,
    restart_required: changed,
  });
}
