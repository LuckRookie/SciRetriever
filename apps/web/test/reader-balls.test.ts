/** Reading-experience 1.9 (ADR 0071): a click swaps, a double click pairs. */
import { describe, expect, it } from "vitest";
import {
  DOUBLE_MS,
  ballLabel,
  pressBall,
  togglePair,
  type BallState,
} from "../src/app/features/reader/input/balls.js";

const first: BallState = { side: "first", paired: false };
const names = ["原", "译"] as const;

describe("the reader's balls", () => {
  it("swap on a click, and say where the next click goes", () => {
    expect(ballLabel(first, names)).toBe("译");
    const one = pressBall(first, 1000, null, true);
    expect(one.state).toEqual({ side: "second", paired: false });
    expect(ballLabel(one.state, names)).toBe("原");
    // A later click is another click, not the second of a double click.
    const two = pressBall(one.state, 1000 + DOUBLE_MS, one.press, true);
    expect(two.state).toEqual(first);
  });
  it("pair on a double click, and go back to what showed before it", () => {
    const one = pressBall(first, 1000, null, true);
    const two = pressBall(one.state, 1200, one.press, true);
    expect(two.state).toEqual({ side: "first", paired: true });
    expect(ballLabel(two.state, names)).toBe("原/译");
    // One more click takes the pair back.
    const three = pressBall(two.state, 5000, two.press, true);
    expect(three.state).toEqual(first);
    // From the second of the pair it goes back to the second.
    const second: BallState = { side: "second", paired: false };
    const a = pressBall(second, 0, null, true);
    const b = pressBall(a.state, 100, a.press, true);
    expect(b.state).toEqual({ side: "second", paired: true });
    expect(pressBall(b.state, 9000, null, true).state).toEqual(second);
  });
  it("only swap where two do not fit side by side", () => {
    const one = pressBall(first, 1000, null, false);
    const two = pressBall(one.state, 1100, one.press, false);
    expect(two.state).toEqual(first);
  });
  it("turn the pair on and off from the tag beside the ball", () => {
    expect(togglePair(first)).toEqual({ side: "first", paired: true });
    expect(togglePair({ side: "second", paired: true })).toEqual({
      side: "second",
      paired: false,
    });
  });
});
