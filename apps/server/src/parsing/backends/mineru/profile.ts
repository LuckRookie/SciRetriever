/** Fixed service contract; credentials, URLs and operational budgets are not provenance. */
export const MINERU_RELEASE = "3.4.4";
export const MINERU_PROTOCOL = 2;
export const MINERU_ARCHIVE_VERSION = "mineru-ts-archive-v3";
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
