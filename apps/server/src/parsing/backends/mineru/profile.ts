import {
  canonicalJsonBytes,
  sha256,
  parseRawParseProfile,
  type RawParseProfile,
} from "@sciretriever/contracts";

/** Fixed service contract; credentials, URLs and operational budgets are not provenance. */
export const MINERU_RELEASE = "3.4.4";
export const MINERU_PROTOCOL = 2;
export const MINERU_REQUEST_FIELDS: readonly (readonly [string, string])[] = [
  ["backend", "vlm-engine"],
  ["parse_method", "auto"],
  ["formula_enable", "true"],
  ["table_enable", "true"],
  ["image_analysis", "true"],
  ["return_md", "true"],
  ["return_middle_json", "true"],
  ["return_model_output", "true"],
  ["return_content_list", "true"],
  ["return_images", "true"],
  ["response_format_zip", "true"],
  ["return_original_file", "false"],
  ["client_side_output_generation", "false"],
];

// MinerU 3.4.4, commit 0dfc9460cd9ab693b9af60ae3fbffd7bc111b062:
// mineru/cli/api_request.py:parse_request_form; fast_api.py:create_result_zip.
// Pipeline uses auto detection, formula/table parsing and the upstream "ch"
// OCR language default. image_analysis is a VLM/hybrid option, not a pipeline model.
export function mineruRequestFields(
  profile: RawParseProfile,
): readonly (readonly [string, string])[] {
  parseRawParseProfile(profile);
  if (profile === "vlm-engine") return MINERU_REQUEST_FIELDS;
  return Object.freeze([
    ...MINERU_REQUEST_FIELDS.filter(([key]) => key !== "image_analysis").map(
      ([key, value]) => [key, key === "backend" ? "pipeline" : value] as const,
    ),
    ["lang_list", "ch"] as const,
  ]);
}

export const MINERU_RAW_ARCHIVE_VERSION = "mineru-ts-raw-v1";

export async function mineruRawIdentity(
  profile: RawParseProfile,
  deploymentIdentity: string,
) {
  const model_identity = `${deploymentIdentity}/${parseRawParseProfile(profile)}`;
  const parameters_sha256 = await sha256(
    canonicalJsonBytes({
      adapter: MINERU_RAW_ARCHIVE_VERSION,
      release: MINERU_RELEASE,
      protocol: MINERU_PROTOCOL,
      profile,
      model_identity,
      fields: Object.fromEntries(mineruRequestFields(profile)),
    }),
  );
  return {
    model_identity,
    parameters_sha256,
    parser_version: `mineru-${MINERU_RELEASE}-${profile}/${MINERU_RAW_ARCHIVE_VERSION}`,
  };
}
