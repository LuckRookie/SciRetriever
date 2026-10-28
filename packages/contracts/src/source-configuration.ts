import { ContractValidationError, parseUtcTimestamp } from "./index.js";
import type { AcquisitionRouteStage } from "./acquisition.js";

export const LITERATURE_SOURCE_IDS = [
  "web-of-science",
  "crossref",
  "semantic-scholar",
  "arxiv",
  "openalex",
  "europe-pmc",
  "elsevier",
  "springer",
  "datacite",
  "core",
  "opencitations",
  "unpaywall",
  "wiley",
  "sci-hub",
  "plos",
] as const;
export type LiteratureSourceId = (typeof LITERATURE_SOURCE_IDS)[number];
export type SourceTestTarget = LiteratureSourceId | "browser";
export type SourcePurpose =
  | "topic-search"
  | "lookup"
  | "reference-query"
  | "pdf";
export interface SourceTechnicalDetails {
  readonly diagnostics: readonly {
    readonly code: string;
    readonly scope:
      | "configuration"
      | "metadata"
      | "pdf"
      | "runtime"
      | "test"
      | "apply";
    readonly field?: string;
    readonly http_status?: number;
    readonly retry_after_ms?: number;
  }[];
}
export type SourceProblemDisplay =
  | "error"
  | "not-configured"
  | "credential-invalid"
  | "no-fulltext-permission";
export interface SourceProblem {
  readonly display: SourceProblemDisplay;
  readonly technical_details: SourceTechnicalDetails;
}
export interface SourceUseCell {
  readonly state: "active" | "available" | "not-provided";
  readonly selected: boolean | null;
  readonly ready: boolean;
  readonly pending_selected: boolean;
  readonly selectable: boolean;
  readonly technical_details: SourceTechnicalDetails;
}
export type SourcePdfCell =
  | (SourceUseCell & {
      readonly kind: "acquisition";
      readonly stage: AcquisitionRouteStage;
    })
  | {
      readonly kind: "hint";
      readonly state: "hint";
      readonly delivery_stage: "direct";
      readonly selectable: false;
      readonly technical_details: SourceTechnicalDetails;
    }
  | {
      readonly kind: "none";
      readonly state: "not-provided";
      readonly selectable: false;
    };
export type SourceConfigurationState =
  | "missing"
  | "configured"
  | "optional-enhancement"
  | "not-required";
export type SourcePublicFieldSchema =
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "string"; readonly format: "email" | "nonempty" }
  | {
      readonly kind: "string-array";
      readonly format: "mirror-https";
      readonly min_items: number;
      readonly max_items: number;
    };
interface SourceFieldBase {
  readonly field: string;
  readonly label: string;
  readonly needed_for: readonly SourcePurpose[];
  readonly state: SourceConfigurationState;
  readonly required: boolean;
  readonly required_when?: { readonly field: string; readonly equals: string };
}
export type SourceConfigurationField = SourceFieldBase &
  (
    | {
        readonly credential: true;
        readonly type: "secret";
        readonly present: boolean;
        readonly actions: readonly ("replace" | "clear")[];
      }
    | {
        readonly credential: false;
        readonly type: SourcePublicFieldSchema;
        readonly value: string | readonly string[] | null;
        readonly value_origin: "saved" | "builtin" | "unset";
        readonly resettable: boolean;
      }
  );
export interface SourceTestCheck {
  readonly purpose: "lookup" | "pdf" | "runtime";
  readonly result:
    | "ok"
    | "empty"
    | "not-applicable"
    | "not-exercised"
    | "error";
  readonly requested: boolean;
  readonly pdf_validated: boolean;
  readonly authentication:
    | "not-attempted"
    | "not-required"
    | "accepted"
    | "rejected"
    | "not-proven";
  readonly fixture_entitlement: "not-proven" | "granted" | "denied";
  readonly technical_details: SourceTechnicalDetails;
}
export interface SourceTestResult {
  readonly test_id: string;
  readonly source: SourceTestTarget;
  readonly source_revision: string;
  readonly method_version: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly elapsed_ms: number;
  readonly status: "available" | SourceProblemDisplay;
  readonly checks: readonly SourceTestCheck[];
  readonly requests_started: number;
  readonly received_bytes: number;
  readonly browser_launched: boolean;
  readonly library_written: false;
  readonly assets_published: false;
  readonly technical_details: SourceTechnicalDetails;
}
export interface SourceTestSlot {
  readonly availability: "ready" | "missing-configuration" | "not-supported";
  readonly state: "idle" | "queued" | "running" | "finished" | "cancelled";
  readonly current_test_id: string | null;
  readonly latest: SourceTestResult | null;
}
export interface SourceDirectoryRow {
  readonly source: LiteratureSourceId;
  readonly name: string;
  readonly group:
    | "publisher-api"
    | "general-api"
    | "metadata"
    | "public-builtin";
  readonly pdf_stage: AcquisitionRouteStage | null;
  readonly source_revision: string;
  readonly uses: {
    readonly topic_search: SourceUseCell;
    readonly lookup: SourceUseCell;
    readonly reference_query: SourceUseCell;
    readonly pdf: SourcePdfCell;
  };
  readonly configuration: {
    readonly state: SourceConfigurationState;
    readonly fields: readonly SourceConfigurationField[];
    readonly expandable: boolean;
  };
  readonly test: SourceTestSlot;
  readonly technical_details: SourceTechnicalDetails;
}
export interface SourceSelection {
  readonly mode: "auto" | "custom";
  readonly providers: readonly LiteratureSourceId[];
}
export interface SourceRoute {
  readonly source: SourceTestTarget | "direct" | "doi-landing";
  readonly name: string;
  readonly stage: AcquisitionRouteStage;
  readonly mode_reason:
    | "auto-default"
    | "auto-configured"
    | "custom"
    | "builtin";
  readonly ready: boolean;
  readonly technical_details: SourceTechnicalDetails;
}
export interface SourceSelectionPlan {
  readonly metadata_selection: SourceSelection;
  readonly pdf_selection: SourceSelection;
  readonly metadata: {
    readonly topic: readonly LiteratureSourceId[];
    readonly lookup: readonly LiteratureSourceId[];
    readonly references: readonly LiteratureSourceId[];
  };
  readonly pdf_routes: readonly SourceRoute[];
  readonly technical_details: SourceTechnicalDetails;
}
export interface ConfigurationApplyState {
  readonly managed: boolean;
  readonly runtime_id: string | null;
  readonly generation: number | null;
  readonly state:
    | "unmanaged"
    | "idle"
    | "waiting"
    | "draining"
    | "stopping"
    | "starting"
    | "applied"
    | "cancelled"
    | "failed";
  readonly request_id: string | null;
  readonly target_binding_revision: string | null;
  readonly current_binding_revision: string | null;
  readonly can_cancel: boolean;
  readonly blockers: {
    readonly queued: number;
    readonly running: number;
    readonly foreground: number;
    readonly probes: number;
    readonly browser_transfers: number;
  };
  readonly updated_at: string;
  readonly problem: SourceProblem | null;
}
export interface SourceDirectory {
  readonly schema_version: 1;
  readonly catalog_revision: string;
  readonly binding_revision: string;
  readonly runtime: {
    readonly runtime_id: string;
    readonly binding_revision: string;
  } | null;
  readonly rows: readonly SourceDirectoryRow[];
  readonly builtin_tests: readonly {
    readonly source: "browser";
    readonly source_revision: string;
    readonly test: SourceTestSlot;
  }[];
  readonly saved: {
    readonly metadata: SourceSelection;
    readonly pdf: SourceSelection;
    readonly metadata_scan_limit: number;
  };
  readonly effective_pdf_routes: readonly SourceRoute[] | null;
  readonly pending_pdf_routes: readonly SourceRoute[];
  readonly preview: {
    readonly auto: SourceSelectionPlan;
    readonly custom: SourceSelectionPlan;
  };
  readonly restart_required: boolean | null;
  readonly apply: ConfigurationApplyState;
  readonly technical_details: SourceTechnicalDetails;
}
export interface SourcePublicParameters {
  readonly "web-of-science": {
    readonly product: "starter" | "expanded";
    readonly database: string;
    readonly edition?: string | null;
  };
  readonly crossref: {
    readonly mode: "anonymous" | "polite";
    readonly mailto: string | null;
  };
  readonly unpaywall: { readonly contact_email: string };
  readonly "sci-hub": { readonly urls: readonly string[] };
}
export type CredentialFieldEdit =
  | {
      readonly field: string;
      readonly action: "replace";
      readonly value: string;
    }
  | { readonly field: string; readonly action: "clear" };
export type PublicParametersEdit<S extends LiteratureSourceId> =
  S extends keyof SourcePublicParameters
    ?
        | { readonly action: "keep" }
        | { readonly action: "reset" }
        | { readonly action: "set"; readonly value: SourcePublicParameters[S] }
    : { readonly action: "keep" };
export type SourceSaveRequest = {
  [S in LiteratureSourceId]: {
    readonly source: S;
    readonly baseline: string;
    readonly parameters: PublicParametersEdit<S>;
    readonly credentials: readonly CredentialFieldEdit[];
    readonly test_after_save: boolean;
  };
}[LiteratureSourceId];
export type SourceSaveResult =
  | {
      readonly status: "saved";
      readonly catalog_revision: string;
      readonly row: SourceDirectoryRow;
      readonly restart_required: boolean | null;
      readonly test_ticket: SourceTestTicket | null;
      readonly test_problem?: SourceProblem;
    }
  | {
      readonly status: "partial";
      readonly committed_fields: readonly string[];
      readonly row: SourceDirectoryRow;
      readonly catalog_revision: string;
      readonly problem: SourceProblem;
      readonly test_ticket: null;
    };
export interface SourceSelectionSaveRequest {
  readonly baseline: string;
  readonly domain: "metadata" | "pdf";
  readonly selection: SourceSelection;
}
export interface SourceTestTicket {
  readonly test_id: string;
  readonly source: SourceTestTarget;
  readonly source_revision: string;
  readonly state: "queued" | "running";
}
export interface SourceTestRequest {
  readonly source: SourceTestTarget;
  readonly source_revision: string;
  readonly request_id: string;
}
export interface SourceTestAllRequest {
  readonly catalog_revision: string;
  readonly request_id: string;
  readonly scope: "configured";
}
export interface ConfigurationApplyRequest {
  readonly request_id: string;
  readonly target_binding_revision: string;
  readonly runtime_id: string;
}
export interface ConfigurationApplyCancelRequest {
  readonly request_id: string;
  readonly runtime_id: string;
}

// Closed bounded wire schemas. Return fresh values so unknown fields can never be echoed.
type Reader<T> = (value: unknown) => T;
const fail = (): never => {
  throw new ContractValidationError();
};
const str: Reader<string> = (v) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 256 &&
  ![...v].some((c) => (c.codePointAt(0) ?? 0) < 32)
    ? v
    : fail();
const token: Reader<string> = (v) =>
  typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(v)
    ? v
    : fail();
const num: Reader<number> = (v) =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= 0 &&
  v <= Number.MAX_SAFE_INTEGER
    ? v
    : fail();
const uuid: Reader<string> = (v) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    v,
  )
    ? v
    : fail();
const integer: Reader<number> = (v) => {
  const n = num(v);
  return Number.isSafeInteger(n) ? n : fail();
};
const bool: Reader<boolean> = (v) => (typeof v === "boolean" ? v : fail());
function literal<T extends string | number | boolean | null>(
  expected: T,
): Reader<T> {
  return (v) => (v === expected ? expected : fail());
}
function one<const T extends readonly string[]>(values: T): Reader<T[number]> {
  return (v) => (typeof v === "string" && values.includes(v) ? v : fail());
}
function nullable<T>(read: Reader<T>): Reader<T | null> {
  return (v) => (v === null ? null : read(v));
}
function array<T>(read: Reader<T>, max = 64): Reader<readonly T[]> {
  return (v) =>
    Array.isArray(v) && v.length <= max ? Object.freeze(v.map(read)) : fail();
}
function object<T>(
  value: unknown,
  readers: { [K in keyof T]-?: Reader<T[K]> },
  optional: readonly (keyof T)[] = [],
): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const r = value as Record<string, unknown>,
    out: Record<string, unknown> = {};
  if (Object.keys(r).some((key) => !Object.hasOwn(readers, key))) fail();
  for (const [key, reader] of Object.entries(readers) as [
    keyof T & string,
    Reader<unknown>,
  ][]) {
    if (!Object.hasOwn(r, key) && optional.includes(key)) continue;
    out[key] = reader(r[key]);
  }
  return Object.freeze(out) as T;
}
const stage = one([
  "direct",
  "publisher-api",
  "general-api",
  "public-web",
  "browser",
]);
export const parseLiteratureSourceId = one(LITERATURE_SOURCE_IDS);
const target = one([...LITERATURE_SOURCE_IDS, "browser"]);
const purpose = one(["topic-search", "lookup", "reference-query", "pdf"]);
const configurationState = one([
  "missing",
  "configured",
  "optional-enhancement",
  "not-required",
]);
const problemDisplay = one([
  "error",
  "not-configured",
  "credential-invalid",
  "no-fulltext-permission",
]);
export const parseSourceTechnicalDetails: Reader<SourceTechnicalDetails> = (
  v,
) =>
  object(v, {
    diagnostics: array(
      (d) =>
        object<SourceTechnicalDetails["diagnostics"][number]>(
          d,
          {
            code: token,
            scope: one([
              "configuration",
              "metadata",
              "pdf",
              "runtime",
              "test",
              "apply",
            ]),
            field: token,
            http_status: (v) => {
              const n = num(v);
              return Number.isInteger(n) && n >= 100 && n <= 599 ? n : fail();
            },
            retry_after_ms: num,
          },
          ["field", "http_status", "retry_after_ms"],
        ),
      32,
    ),
  });
export const parseSourceProblem: Reader<SourceProblem> = (v) =>
  object(v, {
    display: problemDisplay,
    technical_details: parseSourceTechnicalDetails,
  });
const use: Reader<SourceUseCell> = (v) => {
  const r = object<SourceUseCell>(v, {
    state: one(["active", "available", "not-provided"]),
    selected: nullable(bool),
    ready: bool,
    pending_selected: bool,
    selectable: bool,
    technical_details: parseSourceTechnicalDetails,
  });
  if (r.state === "active" && (!r.selected || !r.ready)) fail();
  if (r.state === "not-provided" && (r.ready || r.selectable)) fail();
  return r;
};
const publicSchema: Reader<SourcePublicFieldSchema> = (v) => {
  const kind = (v as Record<string, unknown> | null)?.kind;
  if (kind === "enum")
    return object(v, { kind: literal("enum"), values: array(str, 16) });
  if (kind === "string")
    return object(v, {
      kind: literal("string"),
      format: one(["email", "nonempty"]),
    });
  return object(v, {
    kind: literal("string-array"),
    format: literal("mirror-https"),
    min_items: num,
    max_items: num,
  });
};
const field: Reader<SourceConfigurationField> = (v) => {
  const base = {
    field: token,
    label: str,
    needed_for: array(purpose, 4),
    state: configurationState,
    required: bool,
    required_when: (v: unknown) =>
      object<{ field: string; equals: string }>(v, {
        field: token,
        equals: str,
      }),
  };
  return (v as Record<string, unknown> | null)?.credential === true
    ? object(
        v,
        {
          ...base,
          credential: literal(true),
          type: literal("secret"),
          present: bool,
          actions: array(one(["replace", "clear"]), 2),
        },
        ["required_when"],
      )
    : object(
        v,
        {
          ...base,
          credential: literal(false),
          type: publicSchema,
          value: nullable((v) =>
            Array.isArray(v) ? array(str, 8)(v) : str(v),
          ),
          value_origin: one(["saved", "builtin", "unset"]),
          resettable: bool,
        },
        ["required_when"],
      );
};
const check: Reader<SourceTestCheck> = (v) => {
  const r = object<SourceTestCheck>(v, {
    purpose: one(["lookup", "pdf", "runtime"]),
    result: one(["ok", "empty", "not-applicable", "not-exercised", "error"]),
    requested: bool,
    pdf_validated: bool,
    authentication: one([
      "not-attempted",
      "not-required",
      "accepted",
      "rejected",
      "not-proven",
    ]),
    fixture_entitlement: one(["not-proven", "granted", "denied"]),
    technical_details: parseSourceTechnicalDetails,
  });
  if (
    r.pdf_validated &&
    (r.purpose !== "pdf" || r.result !== "ok" || !r.requested)
  )
    fail();
  return r;
};
export const parseSourceTestResult: Reader<SourceTestResult> = (v) => {
  const r = object<SourceTestResult>(v, {
    test_id: token,
    source: target,
    source_revision: token,
    method_version: token,
    started_at: parseUtcTimestamp,
    finished_at: parseUtcTimestamp,
    elapsed_ms: num,
    status: one([
      "available",
      "error",
      "not-configured",
      "credential-invalid",
      "no-fulltext-permission",
    ]),
    checks: array(check, 3),
    requests_started: integer,
    received_bytes: integer,
    browser_launched: bool,
    library_written: literal(false),
    assets_published: literal(false),
    technical_details: parseSourceTechnicalDetails,
  });
  if (
    r.finished_at < r.started_at ||
    (r.status === "available" && r.checks.some((c) => c.result === "error")) ||
    (r.status === "credential-invalid" &&
      !r.checks.some((c) => c.requested && c.authentication === "rejected")) ||
    (r.status === "no-fulltext-permission" &&
      !r.checks.some(
        (c) =>
          c.requested &&
          c.authentication === "accepted" &&
          c.fixture_entitlement === "denied",
      ))
  )
    fail();
  return r;
};
const slot: Reader<SourceTestSlot> = (v) =>
  object(v, {
    availability: one(["ready", "missing-configuration", "not-supported"]),
    state: one(["idle", "queued", "running", "finished", "cancelled"]),
    current_test_id: nullable(token),
    latest: nullable(parseSourceTestResult),
  });
const pdf: Reader<SourcePdfCell> = (v) => {
  const kind = (v as Record<string, unknown> | null)?.kind;
  if (kind === "none")
    return object(v, {
      kind: literal("none"),
      state: literal("not-provided"),
      selectable: literal(false),
    });
  if (kind === "hint")
    return object(v, {
      kind: literal("hint"),
      state: literal("hint"),
      delivery_stage: literal("direct"),
      selectable: literal(false),
      technical_details: parseSourceTechnicalDetails,
    });
  const r = object<
    SourceUseCell & { kind: "acquisition"; stage: AcquisitionRouteStage }
  >(v, {
    kind: literal("acquisition"),
    stage,
    state: one(["active", "available", "not-provided"]),
    selected: nullable(bool),
    ready: bool,
    pending_selected: bool,
    selectable: bool,
    technical_details: parseSourceTechnicalDetails,
  });
  const { kind: _kind, stage: _stage, ...cell } = r;
  void _kind;
  void _stage;
  use(cell);
  return r;
};
export const parseSourceDirectoryRow: Reader<SourceDirectoryRow> = (v) =>
  object(v, {
    source: parseLiteratureSourceId,
    name: str,
    group: one(["publisher-api", "general-api", "metadata", "public-builtin"]),
    pdf_stage: nullable(stage),
    source_revision: token,
    uses: (v) =>
      object(v, { topic_search: use, lookup: use, reference_query: use, pdf }),
    configuration: (v) =>
      object(v, {
        state: configurationState,
        fields: array(field, 12),
        expandable: bool,
      }),
    test: slot,
    technical_details: parseSourceTechnicalDetails,
  });
export const parseSourceSelection: Reader<SourceSelection> = (v) => {
  const r = object<SourceSelection>(v, {
    mode: one(["auto", "custom"]),
    providers: array(parseLiteratureSourceId, 15),
  });
  if (
    new Set(r.providers).size !== r.providers.length ||
    (r.mode === "auto" && r.providers.length)
  )
    fail();
  return r;
};
const route: Reader<SourceRoute> = (v) =>
  object(v, {
    source: one([...LITERATURE_SOURCE_IDS, "direct", "doi-landing", "browser"]),
    name: str,
    stage,
    mode_reason: one(["auto-default", "auto-configured", "custom", "builtin"]),
    ready: bool,
    technical_details: parseSourceTechnicalDetails,
  });
const routes: Reader<readonly SourceRoute[]> = (v) => {
  const r = array(route, 18)(v),
    stages = [
      "direct",
      "publisher-api",
      "general-api",
      "public-web",
      "browser",
    ];
  if (
    new Set(r.map((a) => a.source)).size !== r.length ||
    r.some(
      (a, i) =>
        i > 0 && stages.indexOf(a.stage) < stages.indexOf(r[i - 1]!.stage),
    )
  )
    fail();
  const mirror = r.findIndex((a) => a.source === "sci-hub"),
    landing = r.findIndex((a) => a.source === "doi-landing");
  if (mirror >= 0 && (landing < 0 || landing > mirror)) fail();
  return r;
};
const plan: Reader<SourceSelectionPlan> = (v) =>
  object(v, {
    metadata_selection: parseSourceSelection,
    pdf_selection: parseSourceSelection,
    metadata: (v) =>
      object(v, {
        topic: array(parseLiteratureSourceId, 15),
        lookup: array(parseLiteratureSourceId, 15),
        references: array(parseLiteratureSourceId, 15),
      }),
    pdf_routes: routes,
    technical_details: parseSourceTechnicalDetails,
  });
export const parseConfigurationApplyState: Reader<ConfigurationApplyState> = (
  v,
) => {
  const r = object<ConfigurationApplyState>(v, {
    managed: bool,
    runtime_id: nullable(token),
    generation: nullable(integer),
    state: one([
      "unmanaged",
      "idle",
      "waiting",
      "draining",
      "stopping",
      "starting",
      "applied",
      "cancelled",
      "failed",
    ]),
    request_id: nullable(token),
    target_binding_revision: nullable(token),
    current_binding_revision: nullable(token),
    can_cancel: bool,
    blockers: (v) =>
      object(v, {
        queued: integer,
        running: integer,
        foreground: integer,
        probes: integer,
        browser_transfers: integer,
      }),
    updated_at: parseUtcTimestamp,
    problem: nullable(parseSourceProblem),
  });
  if (
    (!r.managed &&
      (r.state !== "unmanaged" ||
        r.runtime_id !== null ||
        r.generation !== null)) ||
    (r.managed &&
      (!r.runtime_id || r.generation === null || r.generation < 1)) ||
    (r.can_cancel && !["waiting", "draining"].includes(r.state))
  )
    fail();
  return r;
};
export const parseSourceDirectory: Reader<SourceDirectory> = (v) => {
  const r = object<SourceDirectory>(v, {
    schema_version: literal(1),
    catalog_revision: token,
    binding_revision: token,
    runtime: nullable((v) =>
      object(v, { runtime_id: token, binding_revision: token }),
    ),
    rows: array(parseSourceDirectoryRow, 15),
    builtin_tests: array(
      (v) =>
        object(v, {
          source: literal("browser"),
          source_revision: token,
          test: slot,
        }),
      1,
    ),
    saved: (v) =>
      object(v, {
        metadata: parseSourceSelection,
        pdf: parseSourceSelection,
        metadata_scan_limit: num,
      }),
    effective_pdf_routes: nullable(routes),
    pending_pdf_routes: routes,
    preview: (v) => object(v, { auto: plan, custom: plan }),
    restart_required: nullable(bool),
    apply: parseConfigurationApplyState,
    technical_details: parseSourceTechnicalDetails,
  });
  if (
    r.rows.length !== 15 ||
    new Set(r.rows.map((a) => a.source)).size !== 15 ||
    (r.runtime === null &&
      (r.effective_pdf_routes !== null || r.restart_required !== null))
  )
    fail();
  if (
    r.runtime &&
    (r.effective_pdf_routes === null || r.restart_required === null)
  )
    fail();
  for (const row of r.rows) {
    if (
      row.test.latest &&
      (row.test.latest.source_revision !== row.source_revision ||
        row.test.latest.source !== row.source)
    )
      fail();
    if (
      !r.runtime &&
      [
        row.uses.topic_search,
        row.uses.lookup,
        row.uses.reference_query,
        ...(row.uses.pdf.kind === "acquisition" ? [row.uses.pdf] : []),
      ].some((cell) => cell.selected !== null)
    )
      fail();
  }
  return r;
};
const credentials: Reader<readonly CredentialFieldEdit[]> = (v) => {
  const r = array<CredentialFieldEdit>(
    (v) =>
      (v as Record<string, unknown> | null)?.action === "clear"
        ? object(v, { field: token, action: literal("clear") })
        : object(v, {
            field: token,
            action: literal("replace"),
            value: (v) =>
              typeof v === "string" && v.trim().length > 0 && v.length <= 65_536
                ? v
                : fail(),
          }),
    8,
  )(v);
  if (new Set(r.map((e) => e.field)).size !== r.length) fail();
  return r;
};
export const parseSourceSaveRequest: Reader<SourceSaveRequest> = (v) => {
  // Provider-specific field allowlists and public parameter semantics are validated by the owner.
  const r = object<{
    source: LiteratureSourceId;
    baseline: string;
    parameters: unknown;
    credentials: readonly CredentialFieldEdit[];
    test_after_save: boolean;
  }>(v, {
    source: parseLiteratureSourceId,
    baseline: token,
    parameters: (v) => v,
    credentials,
    test_after_save: bool,
  });
  const a = (r.parameters as Record<string, unknown> | null)?.action;
  if (a === "keep") object(r.parameters, { action: literal("keep") });
  else if (
    ["web-of-science", "crossref", "unpaywall", "sci-hub"].includes(r.source)
  ) {
    if (a === "reset") object(r.parameters, { action: literal("reset") });
    else
      object(r.parameters, {
        action: literal("set"),
        value: (v) => {
          if (r.source === "web-of-science")
            return object<SourcePublicParameters["web-of-science"]>(
              v,
              {
                product: one(["starter", "expanded"]),
                database: str,
                edition: nullable(str),
              },
              ["edition"],
            );
          if (r.source === "crossref") {
            const c = object<SourcePublicParameters["crossref"]>(v, {
              mode: one(["anonymous", "polite"]),
              mailto: nullable(str),
            });
            if (c.mode === "anonymous" ? c.mailto !== null : !c.mailto) fail();
            return c;
          }
          if (r.source === "unpaywall")
            return object(v, { contact_email: str });
          return object(v, {
            urls: (v) => {
              const a = array(str, 8)(v);
              return a.length ? a : fail();
            },
          });
        },
      });
  } else fail();
  return r as SourceSaveRequest;
};
export const parseSourceSelectionSaveRequest: Reader<
  SourceSelectionSaveRequest
> = (v) =>
  object(v, {
    baseline: token,
    domain: one(["metadata", "pdf"]),
    selection: parseSourceSelection,
  });
export const parseSourceTestRequest: Reader<SourceTestRequest> = (v) =>
  object(v, { source: target, source_revision: token, request_id: uuid });
export const parseSourceTestAllRequest: Reader<SourceTestAllRequest> = (v) =>
  object(v, {
    catalog_revision: token,
    request_id: uuid,
    scope: literal("configured"),
  });
export const parseSourceTestTicket: Reader<SourceTestTicket> = (v) =>
  object(v, {
    test_id: token,
    source: target,
    source_revision: token,
    state: one(["queued", "running"]),
  });
export const parseConfigurationApplyRequest: Reader<
  ConfigurationApplyRequest
> = (v) =>
  object(v, {
    request_id: uuid,
    target_binding_revision: token,
    runtime_id: token,
  });
export const parseConfigurationApplyCancelRequest: Reader<
  ConfigurationApplyCancelRequest
> = (v) => object(v, { request_id: uuid, runtime_id: token });
export const parseSourceSaveResult: Reader<SourceSaveResult> = (v) =>
  (v as Record<string, unknown> | null)?.status === "partial"
    ? object(v, {
        status: literal("partial"),
        committed_fields: array(token, 16),
        row: parseSourceDirectoryRow,
        catalog_revision: token,
        problem: parseSourceProblem,
        test_ticket: literal(null),
      })
    : object(
        v,
        {
          status: literal("saved"),
          catalog_revision: token,
          row: parseSourceDirectoryRow,
          restart_required: nullable(bool),
          test_ticket: nullable(parseSourceTestTicket),
          test_problem: parseSourceProblem,
        },
        ["test_problem"],
      );
