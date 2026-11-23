import type {
  DatabaseSync,
  SQLInputValue,
  SQLOutputValue,
  StatementSync,
} from "node:sqlite";
import {
  LIBRARY_COUNT_LIMIT,
  RELEVANCE_RESULT_LIMIT,
} from "@sciretriever/contracts";

const FTS = "literature_search_fts";
const START = "\x01";
const END = "\x02";
const PRINTABLE_ASCII = /^[ -~]*$/u;
const SPAN_CACHE_LIMIT = 256;
const CACHED_SPAN_LENGTH = 128;
const MAX_UNCACHED_CHUNKS_PER_ROW = 4;
// The first FTS column is an unindexed ID. Index text never contains START or END.
const highlightColumns = Array.from(
  { length: 12 },
  (_, i) => `highlight_${i + 1}`,
);
const HIGHLIGHTS = highlightColumns
  .map((alias, i) => {
    const column = i + 1;
    return `CASE WHEN document.c${column}<>''
      THEN highlight(${FTS},${column},char(1),char(2)) END AS ${alias}`;
  })
  .join(",");
const textColumns = highlightColumns.map((_, i) => `c${i + 1}`);
const INDEXED_TEXT = textColumns
  .map((column) => `document.${column}`)
  .join(",");

type Sql = { sql: string; args: SQLInputValue[] };
type Row = Record<string, SQLOutputValue>;
type Score = { literature_id: string; relevance: number };

// The default unicode61 tokenizer uses ASCII letters and digits as tokens.
const asciiTokens = (text: string) =>
  text.toLowerCase().match(/[a-z0-9]+/gu) ?? [];

// FTS5 stores the row count followed by the summed lengths in its averages
// record, and the per-column lengths in docsize. Both use SQLite varints.
function lengths(bytes: SQLOutputValue | undefined): number[] {
  if (!(bytes instanceof Uint8Array)) throw new Error("missing FTS5 lengths");
  const values: number[] = [];
  let value = 0;
  let width = 0;
  for (const byte of bytes) {
    value = width === 8 ? value * 256 + byte : value * 128 + (byte & 127);
    if (!(byte & 128) || width === 8) {
      if (!Number.isSafeInteger(value)) throw new Error("invalid FTS5 length");
      values.push(value);
      value = 0;
      width = 0;
    } else width++;
  }
  if (width || !values.length) throw new Error("invalid FTS5 lengths");
  return values;
}

class PhraseTokenizer {
  private readonly chunks = new Map<string, readonly string[]>();
  private sqlite?: {
    db: DatabaseSync;
    clear: StatementSync;
    insert: StatementSync;
    positions: StatementSync;
  };

  tokens(text: string): string[] {
    if (PRINTABLE_ASCII.test(text)) return asciiTokens(text);
    if (!this.sqlite) {
      // The CLI can load the query module before it opens a catalog.
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
      const db = new DatabaseSync(":memory:");
      db.exec(`CREATE VIRTUAL TABLE phrases USING fts5(text,tokenize='unicode61');
        CREATE VIRTUAL TABLE positions USING fts5vocab(phrases,'instance')`);
      this.sqlite = {
        db,
        clear: db.prepare("DELETE FROM phrases"),
        insert: db.prepare("INSERT INTO phrases(text) VALUES(?)"),
        positions: db.prepare("SELECT term FROM positions ORDER BY offset"),
      };
    }
    this.sqlite.clear.run();
    this.sqlite.insert.run(text);
    return this.sqlite.positions.all().map(({ term }) => String(term));
  }

  columnTokens(text: string, budget: { left: number }): string[] | undefined {
    if (PRINTABLE_ASCII.test(text)) return asciiTokens(text);
    if (text.includes("\0")) return undefined;
    const tokens: string[] = [];
    // An ASCII separator is also a unicode61 separator. Let SQLite tokenize
    // the runs containing non-ASCII and keep their token order in the column.
    for (const chunk of text.match(/(?:[a-zA-Z0-9]|\P{ASCII})+/gu) ?? []) {
      if (PRINTABLE_ASCII.test(chunk)) {
        tokens.push(chunk.toLowerCase());
        continue;
      }
      let normalized = this.chunks.get(chunk);
      if (!normalized) {
        if (budget.left === 0 || chunk.length > CACHED_SPAN_LENGTH)
          return undefined;
        budget.left--;
        normalized = this.tokens(chunk);
        if (this.chunks.size < SPAN_CACHE_LIMIT)
          this.chunks.set(chunk, normalized);
      }
      for (const token of normalized) tokens.push(token);
    }
    return tokens;
  }

  close() {
    this.sqlite?.db.close();
  }
}

type SpanCounts = readonly [index: number, count: number][];
type PhraseStarts = ReadonlyMap<
  string,
  readonly { index: number; rest: readonly string[] }[]
>;

function indexPhrases(phrases: readonly (readonly string[])[]): PhraseStarts {
  const byFirstToken = new Map<
    string,
    { index: number; rest: readonly string[] }[]
  >();
  for (const [index, tokens] of phrases.entries()) {
    const [first, ...rest] = tokens;
    if (!first) continue;
    const candidates = byFirstToken.get(first) ?? [];
    candidates.push({ index, rest });
    byFirstToken.set(first, candidates);
  }
  return byFirstToken;
}

function visitPhrases(
  tokens: readonly string[],
  byFirstToken: PhraseStarts,
  onMatch: (index: number) => void,
) {
  for (let start = 0; start < tokens.length; start++) {
    const candidates = byFirstToken.get(tokens[start]!);
    if (!candidates) continue;
    for (const { index, rest } of candidates)
      if (rest.every((token, i) => token === tokens[start + 1 + i]))
        onMatch(index);
  }
}

function spanCounter(byFirstToken: PhraseStarts, tokenizer: PhraseTokenizer) {
  const cache = new Map<string, SpanCounts>();
  return (text: string): SpanCounts => {
    const cached = cache.get(text);
    if (cached) return cached;
    const tokens = tokenizer.tokens(text);
    const counts = new Map<number, number>();
    // FTS5 coalesces overlapping matches, including phrases that normalize to
    // the same tokens. Visit every start inside a span to recover each count.
    visitPhrases(tokens, byFirstToken, (index) =>
      counts.set(index, (counts.get(index) ?? 0) + 1),
    );
    const result = [...counts];
    if (text.length <= CACHED_SPAN_LENGTH && cache.size < SPAN_CACHE_LIMIT)
      cache.set(text, result);
    return result;
  };
}

function countIndexedText(
  row: Row,
  phrases: PhraseStarts,
  frequencies: number[],
  tokenizer: PhraseTokenizer,
) {
  frequencies.fill(0);
  const budget = { left: MAX_UNCACHED_CHUNKS_PER_ROW };
  const count = (index: number) => {
    frequencies[index] = frequencies[index]! + 1;
  };
  for (const column of textColumns) {
    const text = row[column];
    if (text === null || text === "") continue;
    if (typeof text !== "string") return false;
    const tokens = tokenizer.columnTokens(text, budget);
    if (!tokens) return false;
    visitPhrases(tokens, phrases, count);
  }
  return true;
}

function countHighlights(
  row: Row,
  frequencies: number[],
  countSpan: ((text: string) => SpanCounts) | undefined,
) {
  frequencies.fill(0);
  for (const column of highlightColumns) {
    const text = row[column];
    if (typeof text !== "string") continue;
    for (
      let start = text.indexOf(START);
      start >= 0;
      start = text.indexOf(START, start + 1)
    ) {
      if (!countSpan) {
        frequencies[0] = frequencies[0]! + 1;
        continue;
      }
      const end = text.indexOf(END, start + 1);
      if (end < 0) throw new Error("unclosed FTS5 highlight");
      for (const [index, count] of countSpan(text.slice(start + 1, end)))
        frequencies[index] = frequencies[index]! + count;
      start = end;
    }
  }
}

const orderScores = (a: Score, b: Score) =>
  a.relevance - b.relevance ||
  (a.literature_id < b.literature_id
    ? -1
    : Number(a.literature_id > b.literature_id));

/** A required phrase locates each candidate and one pass over its indexed
 * text counts all phrases. Text that exceeds the tokenization budget uses a
 * full MATCH and combined highlights. Both share global BM25 statistics. */
export function rankLibraryMembers(
  db: DatabaseSync,
  project: (extra: string, options?: { match?: string }) => Sql,
  ftsQuery: string,
  recentlyOpened: boolean,
) {
  const terms = ftsQuery.split(" AND ");
  const tokenizer = new PhraseTokenizer();
  const seen = new Set<string>();
  const scores: Score[] = [];
  let average = 0;
  let weights: number[] | undefined;
  let total = 0;
  try {
    const tokens = terms.map((term) => tokenizer.tokens(term.slice(1, -1)));
    const frequencies = terms.map(() => 0);
    const phraseStarts = indexPhrases(tokens);
    const countSpan =
      terms.length === 1 && tokens[0]!.length === 1
        ? undefined
        : spanCounter(phraseStarts, tokenizer);
    // Recently opened uses a SQL LIMIT after the full MATCH, before scoring.
    const useAnchor =
      !recentlyOpened &&
      terms.length > 1 &&
      terms.every(
        (term, i) => /^"[^"]+"$/u.test(term) && tokens[i]!.length > 0,
      );
    const docLength = `(SELECT sz FROM ${FTS}_docsize WHERE id=document.id) AS lengths`;
    const input = useAnchor
      ? project(`${docLength},${INDEXED_TEXT}`, { match: terms[0]! })
      : project(`${docLength},${HIGHLIGHTS}`);
    const members = db.prepare(input.sql);
    members.setReadBigInts(true);
    const nativeMatch = useAnchor
      ? db.prepare(
          `SELECT ${HIGHLIGHTS} FROM ${FTS}
           CROSS JOIN ${FTS}_content document ON document.id=${FTS}.rowid
           WHERE ${FTS}.rowid=? AND ${FTS} MATCH ?`,
        )
      : undefined;
    for (const row of members.iterate(...input.args)) {
      if (
        nativeMatch &&
        countIndexedText(row, phraseStarts, frequencies, tokenizer)
      ) {
        if (frequencies.includes(0)) continue;
      } else {
        const marked = nativeMatch
          ? nativeMatch.get(row.doc as bigint, ftsQuery)
          : row;
        if (!marked) continue;
        countHighlights(marked, frequencies, countSpan);
      }
      if (!weights) {
        const [documents, ...columns] = lengths(
          db.prepare(`SELECT block FROM ${FTS}_data WHERE id=1`).get()?.block,
        );
        average = columns.reduce((sum, value) => sum + value, 0) / documents!;
        const frequency =
          db.prepare(`SELECT ln((? - count(*) + 0.5) / (count(*) + 0.5)) AS idf
          FROM ${FTS} WHERE ${FTS} MATCH ?`);
        weights = terms.map((term) => {
          const idf = Number(frequency.get(documents!, term)!.idf);
          return idf > 0 ? idf : 0.000001;
        });
      }
      const literature_id = String(row.literature_id);
      if (total <= LIBRARY_COUNT_LIMIT) {
        if (seen.has(literature_id))
          throw new Error("duplicate library search rows");
        seen.add(literature_id);
        total++;
      }
      const length = lengths(row.lengths).reduce(
        (sum, tokens) => sum + tokens,
        0,
      );
      let score = 0;
      for (let index = 0; index < weights.length; index++) {
        const weight = weights[index]!;
        const frequency = frequencies[index]!;
        score +=
          weight *
          ((frequency * (1.2 + 1)) /
            (frequency + 1.2 * (1 - 0.75 + (0.75 * length) / average)));
      }
      scores.push({ literature_id, relevance: -score });
      if (scores.length === RELEVANCE_RESULT_LIMIT * 2) {
        scores.sort(orderScores);
        scores.length = RELEVANCE_RESULT_LIMIT;
      }
    }
  } finally {
    tokenizer.close();
  }
  return {
    total,
    rows: scores.sort(orderScores).slice(0, RELEVANCE_RESULT_LIMIT),
  };
}
