import {
  LITERATURE_SOURCE_IDS,
  parseSourceDirectory,
  parseSourceSaveRequest,
  parseSourceSelectionSaveRequest,
  type SourceDirectory,
  type SourceDirectoryRow,
  type SourceConfigurationField,
  type SourceUseCell,
  type SourceRoute,
  type SourceSelectionPlan,
  type SourceSelection,
  type SourceSaveResult,
  type SourceTechnicalDetails,
  type LiteratureSourceId,
  type ConfigurationApplyState,
  type SourceTestResult,
  type SourceTestTarget,
  type SourceTestTicket,
} from "@sciretriever/contracts";
import { randomUUID } from "node:crypto";
import {
  LITERATURE_PROVIDERS,
  METADATA_PROVIDER_NAMES,
} from "../providers/registry.js";
import {
  configuredMetadataSelections,
  METADATA_CAPABILITIES,
  type MetadataCapability,
  type MetadataRegistry,
} from "../metadata/registry.js";
import { acquireFileLock } from "../storage/locking.js";
import {
  bundlePreview,
  editSourceCredentials,
  loadCredentialBundle,
  publishCredentialText,
} from "./credentials.js";
import { type OrdinaryConfiguration } from "./index.js";
import {
  renderConfigurationText,
  type TypeScriptConfigurationOwner,
} from "./owner.js";
import {
  acquisitionConfigurationFailure,
  configuredAcquisitionRoutes,
} from "./acquisition-selection.js";
import {
  currentSourceState,
  readSourceState,
  sourceDigest,
  sourceFileIdentity,
  sameSourceFiles,
  sourceStateChanged,
  SOURCE_METHOD_VERSION,
  writeSourceState,
} from "./source-state.js";

export class SourceConfigurationError extends Error {
  constructor(
    readonly code:
      | "source-configuration-invalid"
      | "source-configuration-conflict"
      | "source-test-conflict"
      | "source-test-unavailable"
      | "configuration-apply-busy",
    readonly current_revision?: string,
  ) {
    super("source configuration operation failed");
    this.name = "SourceConfigurationError";
  }
}
export const sourceDetails = (
  code?: string,
  scope: SourceTechnicalDetails["diagnostics"][number]["scope"] = "configuration",
  field?: string,
): SourceTechnicalDetails => ({
  diagnostics: code ? [{ code, scope, ...(field ? { field } : {}) }] : [],
});
export const unmanagedApply = (): ConfigurationApplyState => ({
  managed: false,
  runtime_id: null,
  generation: null,
  state: "unmanaged",
  request_id: null,
  target_binding_revision: null,
  current_binding_revision: null,
  can_cancel: false,
  blockers: {
    queued: 0,
    running: 0,
    foreground: 0,
    probes: 0,
    browser_transfers: 0,
  },
  updated_at: new Date().toISOString(),
  problem: null,
});
type Presence = ReturnType<typeof bundlePreview>;
export function hasSourceField(
  preview: Presence,
  source: string,
  field: string,
): boolean {
  return preview.sections.some(
    (s) =>
      s.section === source &&
      s.fields.some((f) => f.field === field && f.present),
  );
}
export function sourceParameters(
  c: OrdinaryConfiguration,
  source: string,
): Record<string, unknown> | null {
  if (source === "web-of-science") return c.sources.metadata.web_of_science;
  if (source === "crossref") return c.sources.metadata.crossref;
  if (source === "unpaywall") return c.sources.acquisition.unpaywall;
  if (source === "sci-hub") return c.sources.acquisition.sci_hub;
  return null;
}
export function sourceBindingRevision(
  c: OrdinaryConfiguration,
  p: Presence,
): string {
  return sourceDigest({
    configuration: c,
    required: LITERATURE_SOURCE_IDS.map((s) => {
      const d = LITERATURE_PROVIDERS[s]!;
      return [
        s,
        ...[d.requiredMetadataCredential, d.requiredPdfCredential]
          .filter((f) => f)
          .map((f) => [f, hasSourceField(p, s, f!)]),
      ];
    }),
  });
}
export function sourceCapabilities(
  c: OrdinaryConfiguration,
): Readonly<Record<string, readonly MetadataCapability[]>> {
  return {
    ...METADATA_CAPABILITIES,
    "web-of-science":
      c.sources.metadata.web_of_science?.product === "expanded"
        ? ["topic-search", "lookup", "reference-query"]
        : ["topic-search", "lookup"],
  };
}
function metadataFailure(
  c: OrdinaryConfiguration,
  p: Presence,
  s: string,
): string | null {
  const d = LITERATURE_PROVIDERS[s]!;
  if (
    d.requiredMetadataCredential &&
    !hasSourceField(p, s, d.requiredMetadataCredential)
  )
    return "missing-credential";
  if (s === "web-of-science" && !c.sources.metadata.web_of_science)
    return "missing-ordinary-parameter";
  return null;
}
export interface SourceRuntimeBinding {
  readonly runtime_id: string;
  readonly configuration: OrdinaryConfiguration;
  readonly presence: Presence;
  readonly metadata: MetadataRegistry;
  readonly effective_routes: () => Promise<
    readonly import("@sciretriever/contracts").AcquisitionRoute[]
  >;
}
export interface SourceTestDispatcher {
  start(
    source: SourceTestTarget,
    revision: string,
    requestId: string,
  ): Promise<SourceTestTicket>;
  slot(source: SourceTestTarget): {
    state: "queued" | "running" | "cancelled";
    test_id: string;
    source_revision: string;
  } | null;
}
export class SourceConfigurationOwner {
  runtime: SourceRuntimeBinding | null = null;
  lifecycle: import("./apply.js").ConfigurationLifecycle | null = null;
  tests: SourceTestDispatcher | null = null;
  applyState: () => ConfigurationApplyState = unmanagedApply;
  /** Same admission hook is shared with lifecycle/probes; reads never take a permit. */
  admission: <T>(work: () => Promise<T>) => Promise<T> = (work) => work();
  constructor(
    readonly owner: TypeScriptConfigurationOwner,
    readonly seams: {
      beforeConfigurationWrite?: () => Promise<void>;
      beforeCacheWrite?: () => Promise<void>;
    } = {},
  ) {
    this.admission = (work) => owner.admit(work);
  }
  async snapshot(signal?: AbortSignal) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.owner.read(signal);
      const identity = await sourceFileIdentity(
        this.owner.home,
        current.revision,
      );
      const bundle = await loadCredentialBundle(this.owner.home),
        preview = bundlePreview(bundle);
      const read = await readSourceState(this.owner.home);
      const latest = await this.owner.read(signal),
        after = await sourceFileIdentity(this.owner.home, latest.revision);
      if (!sameSourceFiles(identity, after)) continue;
      return {
        current,
        bundle,
        preview,
        identity,
        state: currentSourceState(identity, read.cache),
        cache_code: read.code,
        catalog_revision: sourceDigest(identity),
      };
    }
    throw new SourceConfigurationError("source-configuration-conflict");
  }
  private sourceRevision(
    source: SourceTestTarget,
    snap: Awaited<ReturnType<SourceConfigurationOwner["snapshot"]>>,
  ): string {
    const c = snap.current.configuration,
      p = snap.preview;
    if (source === "browser")
      return sourceDigest({
        method: SOURCE_METHOD_VERSION,
        browser: c.browser,
        generation: snap.state.generations.browser,
      });
    const def = LITERATURE_PROVIDERS[source]!,
      parameters = sourceParameters(c, source);
    return sourceDigest({
      method: SOURCE_METHOD_VERSION,
      source,
      generation: snap.state.generations[source],
      parameters,
      fields: [
        ...def.credentialFields
          .filter((f) => f !== "api_metric")
          .map((f) => [f, hasSourceField(p, source, f)]),
        ...(def.configurationFields ?? []).map((f) => [
          f.field,
          parameters?.[f.field] ?? f.default_value ?? null,
        ]),
      ],
      definition: def,
    });
  }
  private selections(c: OrdinaryConfiguration, p: Presence) {
    return configuredMetadataSelections(
      c,
      sourceCapabilities(c),
      LITERATURE_SOURCE_IDS.filter((s) => {
        const d = LITERATURE_PROVIDERS[s]!;
        return d.requiredMetadataCredential
          ? hasSourceField(p, s, d.requiredMetadataCredential)
          : d.credentialFields.some((f) => hasSourceField(p, s, f));
      }),
    );
  }
  private routes(
    c: OrdinaryConfiguration,
    p: Presence,
  ): readonly SourceRoute[] {
    return configuredAcquisitionRoutes(c, p).map((r) => ({
      source: r.source as SourceRoute["source"],
      name: LITERATURE_PROVIDERS[r.source]?.displayName ?? r.source,
      stage: r.stage,
      mode_reason: r.mode_reason,
      ready: r.ready,
      technical_details: sourceDetails(r.unavailable_code),
    }));
  }
  private plan(
    c: OrdinaryConfiguration,
    p: Presence,
    mode: "auto" | "custom",
  ): SourceSelectionPlan {
    const selections = {
      metadata: {
        mode,
        providers: mode === "custom" ? c.sources.metadata.providers : [],
      },
      pdf: {
        mode,
        providers: mode === "custom" ? c.sources.acquisition.providers : [],
      },
    };
    const modified = {
      ...c,
      sources: {
        ...c.sources,
        metadata: { ...c.sources.metadata, ...selections.metadata },
        acquisition: { ...c.sources.acquisition, ...selections.pdf },
      },
    };
    const chosen = this.selections(modified, p);
    return {
      metadata_selection: selections.metadata as SourceSelection,
      pdf_selection: selections.pdf as SourceSelection,
      metadata: {
        topic: chosen.topic as LiteratureSourceId[],
        lookup: chosen.lookup as LiteratureSourceId[],
        references: chosen.reference as LiteratureSourceId[],
      },
      pdf_routes: this.routes(modified, p),
      technical_details: sourceDetails(),
    };
  }
  async directory(signal?: AbortSignal): Promise<SourceDirectory> {
    const snap = await this.snapshot(signal),
      { configuration: c } = snap.current,
      p = snap.preview;
    const selections = this.selections(c, p),
      pending = this.routes(c, p),
      runtime = this.runtime;
    const binding = sourceBindingRevision(c, p),
      runtimeBinding = runtime
        ? sourceBindingRevision(runtime.configuration, runtime.presence)
        : null;
    const effective = runtime
      ? (await runtime.effective_routes()).map((r) => ({
          source: r.source as SourceRoute["source"],
          name: LITERATURE_PROVIDERS[r.source]?.displayName ?? r.source,
          stage: r.stage,
          mode_reason: r.mode_reason,
          ready: r.ready,
          technical_details: sourceDetails(r.unavailable_code),
        }))
      : null;
    const runtimeSelections = runtime
      ? this.selections(runtime.configuration, runtime.presence)
      : null;
    const capabilities = sourceCapabilities(c),
      runtimeCapabilities = runtime
        ? Object.fromEntries(
            runtime.metadata.statuses.map((s) => [
              s.provider_name,
              s.capabilities,
            ]),
          )
        : capabilities;
    const row = (source: LiteratureSourceId): SourceDirectoryRow => {
      const def = LITERATURE_PROVIDERS[source]!,
        parameters = sourceParameters(c, source);
      const fields: SourceConfigurationField[] = [
        ...def.credentialFields
          .filter((f) => f !== "api_metric")
          .map((field): SourceConfigurationField => {
            const present = hasSourceField(p, source, field),
              required =
                field === def.requiredMetadataCredential ||
                field === def.requiredPdfCredential;
            return {
              field,
              label: field,
              needed_for: [
                ...(sourceCapabilities(c)[source] ?? []),
                ...(def.acquisition === "authorized-api"
                  ? ["pdf" as const]
                  : []),
              ],
              state: present
                ? "configured"
                : required
                  ? "missing"
                  : "optional-enhancement",
              required,
              credential: true,
              type: "secret",
              present,
              actions: ["replace", "clear"],
            };
          }),
        ...(def.configurationFields ?? []).map(
          (f): SourceConfigurationField => {
            const saved = parameters?.[f.field],
              value = saved ?? f.default_value ?? null;
            const required =
              f.required ||
              !!(
                f.required_when &&
                (parameters?.[f.required_when.field] ??
                  def.configurationFields?.find(
                    (g) => g.field === f.required_when!.field,
                  )?.default_value) === f.required_when.equals
              );
            return {
              field: f.field,
              label: f.label,
              needed_for: f.needed_for,
              state:
                value === null
                  ? required
                    ? "missing"
                    : "optional-enhancement"
                  : saved === undefined
                    ? "not-required"
                    : "configured",
              required,
              ...(f.required_when ? { required_when: f.required_when } : {}),
              credential: false,
              type: f.type,
              value: value as string | readonly string[] | null,
              value_origin:
                saved !== undefined && saved !== null
                  ? "saved"
                  : value !== null
                    ? "builtin"
                    : "unset",
              resettable: true,
            };
          },
        ),
      ];
      const state = fields.some((f) => f.state === "missing")
        ? "missing"
        : fields.some((f) => f.state === "configured")
          ? "configured"
          : fields.some((f) => f.state === "optional-enhancement")
            ? "optional-enhancement"
            : "not-required";
      const rev = this.sourceRevision(source, snap);
      const cell = (
        cap: MetadataCapability,
        key: "topic" | "lookup" | "reference",
      ): SourceUseCell => {
        const supported = capabilities[source]?.includes(cap) ?? false;
        const currentSupported =
          runtimeCapabilities[source]?.includes(cap) ?? false;
        const selected = runtimeSelections
          ? runtimeSelections[key].includes(source) && currentSupported
          : null;
        const failure = metadataFailure(
          selected && runtime ? runtime.configuration : c,
          p,
          source,
        );
        const ready =
          (selected ? currentSupported : supported) &&
          !failure &&
          (!runtime ||
            !selected ||
            runtime.metadata.statuses.some(
              (s) => s.provider_name === source && s.ready,
            ));
        return {
          state:
            runtime && selected && ready
              ? "active"
              : supported || currentSupported
                ? "available"
                : "not-provided",
          selected,
          ready,
          pending_selected: supported && selections[key].includes(source),
          selectable: supported || currentSupported,
          technical_details: sourceDetails(
            source === "web-of-science" &&
              cap === "reference-query" &&
              !supported &&
              !currentSupported
              ? "reference-product-unavailable"
              : (failure ?? undefined),
            "metadata",
          ),
        };
      };
      const currentPdf = effective?.find((r) => r.source === source);
      const pdfFailure = acquisitionConfigurationFailure(
        currentPdf && runtime ? runtime.configuration : c,
        p,
        source,
      );
      const pdfReady = pdfFailure === null && (!currentPdf || currentPdf.ready);
      const latest = snap.state.results[source];
      const inFlight = this.tests?.slot(source);
      return {
        source,
        name: def.displayName ?? source,
        group:
          def.acquisitionStage === "publisher-api"
            ? "publisher-api"
            : def.acquisitionStage === "general-api"
              ? "general-api"
              : def.acquisition === "none" || def.acquisition === "hints"
                ? "metadata"
                : "public-builtin",
        pdf_stage: def.acquisitionStage ?? null,
        source_revision: rev,
        uses: {
          topic_search: cell("topic-search", "topic"),
          lookup: cell("lookup", "lookup"),
          reference_query: cell("reference-query", "reference"),
          pdf:
            def.acquisition === "hints"
              ? {
                  kind: "hint",
                  state: "hint",
                  delivery_stage: "direct",
                  selectable: false,
                  technical_details: sourceDetails(
                    c.sources.acquisition.providers.includes(source)
                      ? "hint-only-selection"
                      : undefined,
                  ),
                }
              : def.acquisition === "none"
                ? { kind: "none", state: "not-provided", selectable: false }
                : {
                    kind: "acquisition",
                    stage: def.acquisitionStage!,
                    state:
                      runtime && currentPdf?.ready && pdfReady
                        ? "active"
                        : "available",
                    selected: runtime ? !!currentPdf : null,
                    ready: pdfReady,
                    pending_selected: pending.some((r) => r.source === source),
                    selectable: true,
                    technical_details: sourceDetails(
                      pdfFailure ??
                        currentPdf?.technical_details.diagnostics[0]?.code,
                      "pdf",
                    ),
                  },
        },
        configuration: { state, fields, expandable: fields.length > 0 },
        test: {
          availability:
            source === "plos"
              ? "not-supported"
              : state === "missing"
                ? "missing-configuration"
                : "ready",
          state:
            inFlight?.source_revision === rev
              ? inFlight.state
              : latest?.source_revision === rev
                ? "finished"
                : "idle",
          current_test_id:
            inFlight?.source_revision === rev ? inFlight.test_id : null,
          latest:
            latest?.source_revision === rev &&
            latest.method_version === SOURCE_METHOD_VERSION
              ? latest
              : null,
        },
        technical_details: sourceDetails(
          source === "springer" && hasSourceField(p, source, "api_metric")
            ? "unsupported-credential-field"
            : undefined,
          "configuration",
          source === "springer" && hasSourceField(p, source, "api_metric")
            ? "api_metric"
            : undefined,
        ),
      };
    };
    const rows = LITERATURE_SOURCE_IDS.map(row).sort(
      (a, b) =>
        Number(b.configuration.state === "missing") -
        Number(a.configuration.state === "missing"),
    );
    const browserRevision = sourceDigest({
      method: SOURCE_METHOD_VERSION,
      browser: c.browser,
      generation: snap.state.generations.browser,
    });
    const bl = snap.state.results.browser,
      bt = this.tests?.slot("browser");
    return parseSourceDirectory({
      schema_version: 1,
      catalog_revision: snap.catalog_revision,
      binding_revision: binding,
      runtime: runtime
        ? { runtime_id: runtime.runtime_id, binding_revision: runtimeBinding! }
        : null,
      rows,
      builtin_tests: [
        {
          source: "browser",
          source_revision: browserRevision,
          test: {
            availability: "ready",
            state:
              bt?.source_revision === browserRevision
                ? bt.state
                : bl?.source_revision === browserRevision
                  ? "finished"
                  : "idle",
            current_test_id:
              bt?.source_revision === browserRevision ? bt.test_id : null,
            latest: bl?.source_revision === browserRevision ? bl : null,
          },
        },
      ],
      saved: {
        metadata: {
          mode: c.sources.metadata.mode,
          providers: c.sources.metadata.providers,
        },
        pdf: {
          mode: c.sources.acquisition.mode,
          providers: c.sources.acquisition.providers,
        },
        metadata_scan_limit: c.sources.metadata.limit,
      },
      effective_pdf_routes: effective,
      pending_pdf_routes: pending,
      preview: {
        auto: this.plan(c, p, "auto"),
        custom: this.plan(c, p, "custom"),
      },
      restart_required: runtime ? runtimeBinding !== binding : null,
      apply: this.applyState(),
      technical_details: sourceDetails(snap.cache_code ?? undefined),
    });
  }
  async testRevision(
    source: SourceTestTarget,
    snapshot?: Awaited<ReturnType<SourceConfigurationOwner["snapshot"]>>,
  ): Promise<string> {
    return this.sourceRevision(source, snapshot ?? (await this.snapshot()));
  }
  async save(value: unknown, signal?: AbortSignal): Promise<SourceSaveResult> {
    const request = parseSourceSaveRequest(value);
    if (request.test_after_save && !this.tests)
      throw new SourceConfigurationError("source-test-unavailable");
    if (
      request.credentials.some(
        (edit) =>
          !LITERATURE_PROVIDERS[request.source]!.credentialFields.includes(
            edit.field,
          ) || edit.field === "api_metric",
      )
    )
      throw new SourceConfigurationError("source-configuration-invalid");
    return this.admission(async () => {
      const lock = await acquireFileLock(this.owner.home, "configuration");
      let partial: string[] = [];
      let failure = false,
        failureCode = "source-publication-incomplete";
      try {
        const before = await this.snapshot(signal);
        if (before.catalog_revision !== request.baseline)
          throw new SourceConfigurationError(
            "source-configuration-conflict",
            before.catalog_revision,
          );
        const c = before.current.configuration,
          params = request.parameters;
        let candidate = c;
        if (params.action !== "keep") {
          const value = params.action === "reset" ? null : params.value;
          candidate = {
            ...c,
            sources: {
              ...c.sources,
              ...(request.source === "web-of-science" ||
              request.source === "crossref"
                ? {
                    metadata: {
                      ...c.sources.metadata,
                      [request.source === "web-of-science"
                        ? "web_of_science"
                        : "crossref"]: value,
                    },
                  }
                : {
                    acquisition: {
                      ...c.sources.acquisition,
                      [request.source === "sci-hub" ? "sci_hub" : "unpaywall"]:
                        value,
                    },
                  }),
            },
          };
        }
        this.owner.validate(renderConfigurationText(candidate), signal);
        const fields = editSourceCredentials(
          before.bundle,
          request.source,
          request.credentials,
        );
        // All validation precedes either publication. No secret participates in revisions.
        if (fields) {
          await publishCredentialText(this.owner.home, fields);
          partial = request.credentials.map((f) => `credentials.${f.field}`);
        }
        const changed =
          JSON.stringify(c.sources) !== JSON.stringify(candidate.sources);
        try {
          if (changed) {
            await this.seams.beforeConfigurationWrite?.();
            await this.owner.publish(
              renderConfigurationText(candidate),
              before.current.revision,
              ["sources"],
              signal,
              lock,
            );
            partial.push(
              ...Object.keys(
                sourceParameters(candidate, request.source) ??
                  sourceParameters(c, request.source) ??
                  {},
              ).map((f) => `parameters.${f}`),
            );
          }
          if (fields || changed) {
            const after = await this.owner.read(signal);
            await this.seams.beforeCacheWrite?.();
            await sourceStateChanged(
              this.owner.home,
              before.identity,
              await sourceFileIdentity(this.owner.home, after.revision),
              [request.source],
            );
          }
        } catch {
          failure = true;
          try {
            const actual = await this.owner.read(signal);
            await sourceStateChanged(
              this.owner.home,
              before.identity,
              await sourceFileIdentity(this.owner.home, actual.revision),
              [request.source],
            );
          } catch {
            failureCode = "source-state-update-failed";
          }
        }
      } finally {
        await lock.release();
      }
      const directory = await this.directory(signal),
        row = directory.rows.find((r) => r.source === request.source)!;
      if (failure)
        return {
          status: "partial",
          catalog_revision: directory.catalog_revision,
          committed_fields: partial,
          row,
          problem: {
            display: "error",
            technical_details: sourceDetails(failureCode),
          },
          test_ticket: null,
        };
      let test_ticket: SourceTestTicket | null = null;
      let test_problem:
        | import("@sciretriever/contracts").SourceProblem
        | undefined;
      if (
        request.test_after_save &&
        this.tests &&
        row.test.availability === "ready"
      ) {
        try {
          test_ticket = await this.tests.start(
            request.source,
            row.source_revision,
            randomUUID(),
          );
        } catch {
          test_problem = {
            display: "error",
            technical_details: sourceDetails("source-test-not-started", "test"),
          };
        }
      }
      return {
        status: "saved",
        catalog_revision: directory.catalog_revision,
        row,
        restart_required: directory.restart_required,
        test_ticket,
        ...(test_problem ? { test_problem } : {}),
      };
    });
  }
  async select(value: unknown, signal?: AbortSignal): Promise<SourceDirectory> {
    const request = parseSourceSelectionSaveRequest(value);
    const allowed =
      request.domain === "metadata"
        ? METADATA_PROVIDER_NAMES
        : LITERATURE_SOURCE_IDS.filter((s) =>
            ["public", "authorized-api"].includes(
              LITERATURE_PROVIDERS[s]!.acquisition,
            ),
          );
    if (request.selection.providers.some((s) => !allowed.includes(s)))
      throw new SourceConfigurationError("source-configuration-invalid");
    return this.admission(async () => {
      const lock = await acquireFileLock(this.owner.home, "configuration");
      try {
        const before = await this.snapshot(signal);
        if (before.catalog_revision !== request.baseline)
          throw new SourceConfigurationError(
            "source-configuration-conflict",
            before.catalog_revision,
          );
        const c = before.current.configuration,
          key = request.domain === "metadata" ? "metadata" : "acquisition";
        const next = {
          ...c,
          sources: {
            ...c.sources,
            [key]: { ...c.sources[key], ...request.selection },
          },
        };
        if (JSON.stringify(c.sources) !== JSON.stringify(next.sources)) {
          const after = await this.owner.publish(
            renderConfigurationText(next),
            before.current.revision,
            ["sources"],
            signal,
            lock,
          );
          await sourceStateChanged(
            this.owner.home,
            before.identity,
            await sourceFileIdentity(this.owner.home, after.revision),
            [],
          );
        }
      } finally {
        await lock.release();
      }
      return this.directory(signal);
    });
  }
  async acceptTest(result: SourceTestResult): Promise<boolean> {
    const lock = await acquireFileLock(this.owner.home, "configuration");
    try {
      if ((await this.testRevision(result.source)) !== result.source_revision)
        return false;
      const snap = await this.snapshot();
      await writeSourceState(this.owner.home, {
        ...snap.state,
        results: { ...snap.state.results, [result.source]: result },
      });
      return true;
    } finally {
      await lock.release();
    }
  }
}
const owners = new WeakMap<
  TypeScriptConfigurationOwner,
  SourceConfigurationOwner
>();
export function sourceConfiguration(
  owner: TypeScriptConfigurationOwner,
): SourceConfigurationOwner {
  let s = owners.get(owner);
  if (!s) {
    s = new SourceConfigurationOwner(owner);
    owners.set(owner, s);
  }
  return s;
}
