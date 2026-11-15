import {
  ContractValidationError,
  parseIdentifier,
  type Identifier,
} from "@sciretriever/contracts";

export const clueText = (value: string) =>
  value
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
export function normalizeRecognitionTitle(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/<[^>]*>/gu, " ")
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/gu, "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
function decoded(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
export function clueDois(value: string): readonly Identifier[] {
  return uniqueIdentifiers(
    [
      ...decoded(value)
        .normalize("NFKC")
        .matchAll(/(?<!\d)10\.\d{4,9}\/[^\s"'<>]+/giu),
    ].flatMap((match) => {
      try {
        return [
          parseIdentifier({
            namespace: "doi",
            value: match[0]
              .replace(/[.,;:)\]}]+$/u, "")
              .replace(/\/(?:full|abstract|pdf|epdf|html)$/iu, "")
              .replace(/\.pdf$/iu, ""),
          }),
        ];
      } catch (error) {
        if (error instanceof ContractValidationError) return [];
        throw error;
      }
    }),
  );
}
export function clueArxiv(value: string): readonly Identifier[] {
  const source = decoded(value).normalize("NFKC"),
    matches = [
      ...source.matchAll(
        /(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)((?:\d{4}\.\d{4,5}|[a-z][a-z0-9-]*(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?)/giu,
      ),
    ],
    old = [
      ...source.matchAll(
        /\b[a-z][a-z0-9-]*(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?\b/giu,
      ),
    ];
  return uniqueIdentifiers(
    [...matches.map((m) => m[1]!), ...old.map((m) => m[0])].map((value) =>
      parseIdentifier({ namespace: "arxiv", value: value.toLowerCase() }),
    ),
  );
}
export function uniqueIdentifiers(values: readonly Identifier[]): Identifier[] {
  return [
    ...new Map(values.map((v) => [`${v.namespace}:${v.value}`, v])).values(),
  ];
}
