/**
 * The reader's two floating balls (reading-experience 1.9, ADR 0071). Each
 * minds a pair of things: 译 the original and its translation, 读 the PDF
 * and the reading copy. The rule is the same for both:
 *
 * 1. a click swaps to the other of the pair;
 * 2. a double click puts the two side by side; one more click takes the
 *    pair back to what showed before it.
 *
 * A click acts at once; the second click of a double click, coming within
 * `DOUBLE_MS`, turns what the first one did into the pair. Pure, for the
 * direct tests.
 */
export const DOUBLE_MS = 400;
export type BallSide = "first" | "second";
export interface BallState {
  /** The one that shows, or the one to go back to while the pair shows. */
  readonly side: BallSide;
  readonly paired: boolean;
}
/** The last press: when, and what showed before it. */
export interface BallPress {
  readonly at: number;
  readonly before: BallSide;
}
const other = (side: BallSide): BallSide =>
  side === "first" ? "second" : "first";

/** One press of a ball at time `now` (ms); `canPair` false where two do not fit. */
export function pressBall(
  state: BallState,
  now: number,
  last: BallPress | null,
  canPair: boolean,
): { state: BallState; press: BallPress | null } {
  if (state.paired)
    return { state: { side: state.side, paired: false }, press: null };
  if (canPair && last && now - last.at < DOUBLE_MS)
    // The pair goes back to what showed before the double click began.
    return { state: { side: last.before, paired: true }, press: null };
  return {
    state: { side: other(state.side), paired: false },
    press: { at: now, before: state.side },
  };
}
/** The small tag beside a ball: the pair on, or taken back. */
export function togglePair(state: BallState): BallState {
  return { side: state.side, paired: !state.paired };
}
/**
 * What a ball says: where one click goes, or both names while the pair
 * shows. `names` are the pair's two, the first the starting one.
 */
export function ballLabel(
  state: BallState,
  names: readonly [string, string],
): string {
  if (state.paired) return `${names[0]}/${names[1]}`;
  return state.side === "first" ? names[1] : names[0];
}
