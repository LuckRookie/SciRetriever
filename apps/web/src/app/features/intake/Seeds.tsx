import { useRef, useState } from "react";
import { Button } from "../../components/index.js";
import { titleText } from "../../../reading/title.js";
import {
  CITATION_SEED_LIMIT as SEED_LIMIT,
  type LiteratureChoice,
} from "../../data/library.js";
import {
  ChoiceText,
  LiteratureSearch,
} from "../maintenance/LiteraturePicker.js";

/** The list shows this many seeds before “另外 n 篇”. */
const SHOWN = 5;

/** Adds papers to the seeds: each once, in the order chosen, up to the limit. */
export function addSeeds(
  seeds: readonly LiteratureChoice[],
  more: readonly LiteratureChoice[],
): LiteratureChoice[] {
  const seen = new Set(seeds.map((seed) => seed.id)),
    next = [...seeds];
  for (const seed of more) {
    if (next.length >= SEED_LIMIT) break;
    if (seen.has(seed.id)) continue;
    seen.add(seed.id);
    next.push(seed);
  }
  return next;
}

/**
 * The seeds of a citation expansion (page specs “入库 · 检索”): picked from
 * the library by title or author, never typed as numbers (design core rule
 * 8), and listed under the search as 标题 · 第一作者 · 年份.
 */
export function Seeds({
  seeds,
  onChange,
  isDisabled = false,
}: {
  seeds: readonly LiteratureChoice[];
  onChange: (seeds: LiteratureChoice[]) => void;
  isDisabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false),
    root = useRef<HTMLDivElement>(null);
  const focusSearch = () =>
    root.current
      ?.querySelector<HTMLElement>(".literature-search input")
      ?.focus();
  /** Each listed seed's “移除”, in order. */
  const removeButtons = () => [
    ...(root.current?.querySelectorAll<HTMLElement>(
      ".seed-list li .ui-button",
    ) ?? []),
  ];
  const chosen = new Set(seeds.map((seed) => seed.id)),
    full = seeds.length >= SEED_LIMIT,
    shown = expanded ? seeds : seeds.slice(0, SHOWN);
  /**
   * After a removal focus moves to the next seed's “移除”, or the one before
   * it at the end, or back to the search once none is left.
   */
  const remove = (at: number) => {
    const next = seeds.filter((_, i) => i !== at);
    onChange(next);
    requestAnimationFrame(() => {
      const buttons = removeButtons(),
        target = buttons[Math.min(at, buttons.length - 1)];
      if (target) target.focus();
      else focusSearch();
    });
  };
  return (
    <div className="seed-picker" ref={root}>
      <LiteratureSearch
        label="种子文献"
        chosen={chosen}
        isDisabled={isDisabled || full}
        onPick={(choice) => onChange(addSeeds(seeds, [choice]))}
      />
      {full ? (
        <p className="intake-submit-note">
          已选满 {SEED_LIMIT.toLocaleString()} 篇种子，移除一些才能再加。
        </p>
      ) : null}
      {seeds.length ? (
        <div className="seed-list" role="group" aria-label="已选的种子文献">
          <p className="seed-list-head">
            <span>已选 {seeds.length.toLocaleString()} 篇</span>
            {seeds.length >= 2 ? (
              <Button
                variant="text"
                size="compact"
                isDisabled={isDisabled}
                onPress={() => {
                  onChange([]);
                  setExpanded(false);
                  requestAnimationFrame(focusSearch);
                }}
              >
                全部移除
              </Button>
            ) : null}
          </p>
          <ul>
            {shown.map((seed, at) => (
              <li key={seed.id}>
                <p>
                  <ChoiceText choice={seed} />
                </p>
                <Button
                  variant="text"
                  size="compact"
                  isDisabled={isDisabled}
                  aria-label={`移除《${titleText(seed.title)}》`}
                  onPress={() => remove(at)}
                >
                  移除
                </Button>
              </li>
            ))}
          </ul>
          {seeds.length > shown.length ? (
            <Button
              variant="text"
              size="compact"
              onPress={() => {
                setExpanded(true);
                // The button goes; focus moves to the first seed it showed.
                requestAnimationFrame(() => removeButtons()[SHOWN]?.focus());
              }}
            >
              另外 {(seeds.length - shown.length).toLocaleString()} 篇
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
