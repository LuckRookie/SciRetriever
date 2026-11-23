import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import {
  LIBRARY_COUNT_LIMIT,
  RELEVANCE_RESULT_LIMIT,
} from "@sciretriever/contracts";

const FTS = "literature_search_fts";
const START = "\x01";
const END = "\x02";
// The first FTS column is an unindexed ID. Index text never contains START or END.
const HIGHLIGHTS = Array.from({ length: 12 }, (_, i) => {
  const column = i + 1;
  return `highlight(${FTS},${column},char(1),char(2)) AS highlight_${column}`;
}).join(",");

type Sql = { sql: string; args: SQLInputValue[] };
type Row = Record<string, SQLOutputValue>;
type Score = { literature_id: string; relevance: number };

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
  private db?: DatabaseSync;

  tokens(text: string): string[] {
    if (!this.db) {
      // The CLI can load the query module before it opens a catalog.
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
      this.db = new DatabaseSync(":memory:");
      this.db
        .exec(`CREATE VIRTUAL TABLE phrases USING fts5(text,tokenize='unicode61');
        CREATE VIRTUAL TABLE positions USING fts5vocab(phrases,'instance')`);
    }
    this.db.exec("DELETE FROM phrases");
    this.db.prepare("INSERT INTO phrases(text) VALUES(?)").run(text);
    return this.db
      .prepare("SELECT term FROM positions ORDER BY offset")
      .all()
      .map(({ term }) => String(term));
  }

  close() {
    this.db?.close();
  }
}

function occurrences(
  row: Row,
  tokens: readonly string[],
  tokenizer: PhraseTokenizer,
) {
  let count = 0;
  for (let column = 1; column <= 12; column++) {
    const text = row[`highlight_${column}`];
    if (typeof text !== "string") continue;
    for (
      let start = text.indexOf(START);
      start >= 0;
      start = text.indexOf(START, start + 1)
    ) {
      if (tokens.length === 1) {
        count++;
        continue;
      }
      // FTS5 joins overlapping phrase occurrences into one highlight span.
      // Retokenize that span with the same tokenizer to recover all positions.
      const end = text.indexOf(END, start + 1);
      if (end < 0) throw new Error("unclosed FTS5 highlight");
      const span = tokenizer.tokens(text.slice(start + 1, end));
      for (let i = 0; i + tokens.length <= span.length; i++)
        if (tokens.every((token, j) => token === span[i + j])) count++;
      start = end;
    }
  }
  return count;
}

const orderScores = (a: Score, b: Score) =>
  a.relevance - b.relevance ||
  (a.literature_id < b.literature_id
    ? -1
    : Number(a.literature_id > b.literature_id));

/** MATCH seeks each member's FTS rowid. Extract its phrase frequencies with
 * native highlights, and share the global BM25 statistics across those seeks.
 * Calling bm25 after each rowid seek would recompute statistics for every row. */
export function rankLibraryMembers(
  db: DatabaseSync,
  project: (extra: string) => Sql,
  ftsQuery: string,
) {
  const terms = ftsQuery.split(" AND ");
  const single = terms.length === 1;
  const docLength = `(SELECT sz FROM ${FTS}_docsize WHERE id=document.id) AS lengths`;
  const input = project(single ? `${docLength},${HIGHLIGHTS}` : docLength);
  const members = db.prepare(input.sql);
  members.setReadBigInts(true);
  const highlights = single
    ? undefined
    : db.prepare(
        `SELECT ${HIGHLIGHTS} FROM ${FTS} WHERE rowid=? AND ${FTS} MATCH ?`,
      );
  const tokenizer = new PhraseTokenizer();
  const seen = new Set<string>();
  const scores: Score[] = [];
  let average = 0;
  let phrases: { tokens: string[]; weight: number; term: string }[] | undefined;
  let total = 0;
  try {
    for (const row of members.iterate(...input.args)) {
      if (!phrases) {
        const [documents, ...columns] = lengths(
          db.prepare(`SELECT block FROM ${FTS}_data WHERE id=1`).get()?.block,
        );
        average = columns.reduce((sum, value) => sum + value, 0) / documents!;
        const frequency =
          db.prepare(`SELECT ln((? - count(*) + 0.5) / (count(*) + 0.5)) AS idf
          FROM ${FTS} WHERE ${FTS} MATCH ?`);
        phrases = terms.map((term) => {
          const word = term.slice(1, -1);
          const tokens = /^[a-z0-9]+$/iu.test(word)
            ? [word]
            : tokenizer.tokens(word);
          const idf = Number(frequency.get(documents!, term)!.idf);
          return { tokens, weight: idf > 0 ? idf : 0.000001, term };
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
      for (const { term, tokens, weight } of phrases) {
        const marked = highlights
          ? highlights.get(row.doc as bigint, term)
          : row;
        if (!marked || !tokens.length) continue;
        const frequency = occurrences(marked, tokens, tokenizer);
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
