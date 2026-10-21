const SECTION_BYTES = 64 * 1024;
const INPUT_BYTES = 256 * 1024;
const FALLBACK_SEGMENTS = 8;
type Segment = {
  readonly segment_id: string;
  readonly start_utf8: number;
  readonly end_utf8: number;
};
type Omission =
  | "section-byte-limit"
  | "input-byte-limit"
  | "fallback-segment-limit";

/** Bound model input at whole corrected-document segments and report every omitted count. */
export function selectTagInput(
  markdown: Uint8Array,
  segments: readonly Segment[],
  roles: ReadonlyMap<string, string>,
) {
  const preferred = segments.filter((s) =>
    ["abstract", "introduction", "conclusion"].includes(
      roles.get(s.segment_id) ?? "",
    ),
  );
  const candidates = preferred.length
    ? preferred
    : segments.filter(
        (s) =>
          !["references", "bibliography", "front-matter"].includes(
            roles.get(s.segment_id) ?? "",
          ),
      );
  const sections = new Map<
    string,
    {
      role: string;
      available_segments: number;
      included_segments: number;
      available_utf8_bytes: number;
      included_utf8_bytes: number;
      omitted: Record<Omission, number>;
    }
  >();
  const fragments: { segment_id: string; text: string; role: string }[] = [];
  let includedBytes = 0;
  for (const s of candidates) {
    const role = roles.get(s.segment_id) ?? "body";
    const section = sections.get(role) ?? {
      role,
      available_segments: 0,
      included_segments: 0,
      available_utf8_bytes: 0,
      included_utf8_bytes: 0,
      omitted: {
        "section-byte-limit": 0,
        "input-byte-limit": 0,
        "fallback-segment-limit": 0,
      },
    };
    sections.set(role, section);
    const bytes = s.end_utf8 - s.start_utf8;
    section.available_segments++;
    section.available_utf8_bytes += bytes;
    const omission =
      !preferred.length && fragments.length >= FALLBACK_SEGMENTS
        ? "fallback-segment-limit"
        : section.included_utf8_bytes + bytes > SECTION_BYTES
          ? "section-byte-limit"
          : includedBytes + bytes > INPUT_BYTES
            ? "input-byte-limit"
            : null;
    if (omission) {
      section.omitted[omission]++;
      continue;
    }
    fragments.push({
      segment_id: s.segment_id,
      text: new TextDecoder("utf8", { fatal: true }).decode(
        markdown.subarray(s.start_utf8, s.end_utf8),
      ),
      role,
    });
    section.included_segments++;
    section.included_utf8_bytes += bytes;
    includedBytes += bytes;
  }
  return {
    fragments,
    coverage: {
      selection: preferred.length
        ? ("preferred-sections" as const)
        : ("body-fallback" as const),
      limits: {
        section_utf8_bytes: SECTION_BYTES,
        total_utf8_bytes: INPUT_BYTES,
        fallback_segments: FALLBACK_SEGMENTS,
      },
      available_segments: candidates.length,
      included_segment_ids: fragments.map((f) => f.segment_id),
      included_utf8_bytes: includedBytes,
      truncated: fragments.length !== candidates.length,
      sections: [...sections.values()],
    },
  };
}
