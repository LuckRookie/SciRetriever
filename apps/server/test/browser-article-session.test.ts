import { describe, expect, it } from "vitest";
import {
  BrowserArticleBudgetError,
  BrowserArticleClock,
  DEFAULT_BROWSER_ARTICLE_BUDGET,
} from "../src/browser/article-session.js";

function clockFixture() {
  let at = 0;
  const clock = new BrowserArticleClock({ now: () => at });
  return {
    clock,
    advance(ms: number) {
      at += ms;
    },
  };
}

describe("Browser article active clock", () => {
  it("does not charge queues, download or publication and preserves resumed usage", () => {
    const { clock, advance } = clockFixture();
    advance(45_000);
    expect(clock.remaining().deadline_ms).toBe(300_000);
    clock.recordModelDispatch();
    const endInference = clock.beginActive("inference");
    advance(2_000);
    endInference();
    clock.recordAgentAction();
    const endAction = clock.beginActive("action");
    advance(1_000);
    endAction();
    const endWait = clock.beginActive("page-wait");
    advance(2_000);
    clock.suspend();
    advance(600_000);
    endWait();
    expect(clock.snapshot()).toMatchObject({
      active_elapsed_ms: 5_000,
      remaining_ms: 295_000,
      model_calls: 1,
      actions: 1,
      active: false,
    });
    const resumed = clock.beginActive("page-wait");
    advance(3_000);
    resumed();
    expect(clock.remaining()).toEqual({
      deadline_ms: 292_000,
      model_calls: 29,
      actions: 29,
    });
  });

  it("counts overlapping and nested intervals once without ending another handle", () => {
    const { clock, advance } = clockFixture();
    const firstWait = clock.beginActive("page-wait");
    advance(1_000);
    const secondWait = clock.beginActive("page-wait");
    const pacing = clock.beginActive("pacing");
    advance(1_000);
    firstWait();
    firstWait();
    advance(1_000);
    pacing();
    expect(clock.snapshot().active).toBe(true);
    advance(2_000);
    secondWait();
    expect(clock.snapshot()).toMatchObject({
      active_elapsed_ms: 5_000,
      remaining_ms: 295_000,
      active: false,
    });
  });

  it("makes late end handles inert after suspension while a new interval is active", () => {
    const { clock, advance } = clockFixture();
    const oldInference = clock.beginActive("inference");
    advance(2_000);
    clock.suspend();
    advance(60_000);
    const resumed = clock.beginActive("action");
    advance(1_000);
    oldInference();
    expect(clock.snapshot().active).toBe(true);
    advance(1_000);
    resumed();
    expect(clock.snapshot().active_elapsed_ms).toBe(4_000);
  });

  it("requires five seconds from action completion while feedback waits overlap", () => {
    const { clock, advance } = clockFixture();
    clock.recordAgentAction();
    const action = clock.beginActive("action");
    advance(1_000);
    action();
    clock.actionFinished();
    const feedback = clock.beginActive("page-wait");
    const pacing = clock.beginActive("pacing");
    advance(1_000);
    feedback();
    expect(clock.decisionDelayMs()).toBe(4_000);
    advance(3_999);
    expect(clock.decisionDelayMs()).toBe(1);
    advance(1);
    expect(clock.decisionDelayMs()).toBe(0);
    pacing();
    expect(clock.snapshot().active_elapsed_ms).toBe(6_000);
  });

  it("expires on cumulative active time even when a late model result arrives", () => {
    const { clock, advance } = clockFixture();
    const first = clock.beginActive("page-wait");
    advance(299_999);
    first();
    clock.suspend();
    advance(120_000);
    clock.recordModelDispatch();
    const inference = clock.beginActive("inference");
    advance(1);
    expect(clock.remaining().deadline_ms).toBe(0);
    expect(() => clock.recordAgentAction()).toThrow(BrowserArticleBudgetError);
    inference();
    expect(() => clock.beginActive("action")).toThrow(
      BrowserArticleBudgetError,
    );
    expect(clock.snapshot().actions).toBe(0);
  });

  it("allows the thirtieth dispatched result to apply and rejects the next dispatch", () => {
    const { clock } = clockFixture();
    for (let call = 0; call < 30; call += 1) clock.recordModelDispatch();
    expect(clock.remaining().model_calls).toBe(0);
    expect(() => clock.recordAgentAction()).not.toThrow();
    expect(() => clock.recordModelDispatch()).toThrow(
      BrowserArticleBudgetError,
    );
    expect(clock.snapshot()).toMatchObject({ model_calls: 30, actions: 1 });
  });

  it("records default Agent actions without enforcing a separate action ceiling", () => {
    const { clock } = clockFixture();
    for (let action = 0; action < 30; action += 1) clock.recordAgentAction();
    expect(clock.remaining().actions).toBe(0);
    expect(() => clock.recordAgentAction()).not.toThrow();
    expect(clock.snapshot()).toMatchObject({ model_calls: 0, actions: 31 });
    expect(clock.remaining()).toMatchObject({ model_calls: 30, actions: 0 });
  });

  it("preserves an explicit legacy action ceiling without charging internal waits", () => {
    const clock = new BrowserArticleClock({
      budget: { ...DEFAULT_BROWSER_ARTICLE_BUDGET, max_actions: 200 },
    });
    const wait = clock.beginActive("page-wait");
    wait();
    for (let action = 0; action < 200; action += 1) clock.recordAgentAction();
    expect(clock.remaining().actions).toBe(0);
    expect(() => clock.recordAgentAction()).toThrow(BrowserArticleBudgetError);
    expect(clock.snapshot().actions).toBe(200);
  });

  it("keeps clocks independent and rejects a non-monotonic time source", () => {
    const a = clockFixture();
    const b = clockFixture();
    const activeA = a.clock.beginActive("inference");
    a.advance(5_000);
    activeA();
    a.clock.recordModelDispatch();
    b.advance(30_000);
    expect(b.clock.snapshot()).toMatchObject({
      active_elapsed_ms: 0,
      remaining_ms: 300_000,
      model_calls: 0,
    });
    a.advance(-1);
    expect(() => a.clock.remaining()).toThrow("must be monotonic");
  });

  it("excludes nested platform queues and resumes the retained active handles", () => {
    const { clock, advance } = clockFixture();
    const action = clock.beginActive("action");
    advance(1_000);
    const queue = clock.exclude();
    advance(30_000);
    const nestedQueue = clock.exclude();
    const feedback = clock.beginActive("page-wait");
    advance(40_000);
    queue();
    queue();
    expect(clock.snapshot().active).toBe(false);
    advance(10_000);
    nestedQueue();
    expect(clock.snapshot().active).toBe(true);
    advance(2_000);
    action();
    advance(1_000);
    feedback();
    expect(clock.snapshot()).toMatchObject({
      active_elapsed_ms: 4_000,
      remaining_ms: 296_000,
      active: false,
    });
  });

  it("never revives suspended activity when an old platform permit arrives", () => {
    const { clock, advance } = clockFixture();
    const states: boolean[] = [];
    const unsubscribe = clock.onActivityChanged(() =>
      states.push(clock.snapshot().active),
    );
    const inference = clock.beginActive("inference");
    advance(1_000);
    const queue = clock.exclude();
    advance(60_000);
    clock.suspend();
    queue();
    inference();
    expect(clock.snapshot()).toMatchObject({
      active_elapsed_ms: 1_000,
      active: false,
    });
    const resumed = clock.beginActive("action");
    advance(2_000);
    queue();
    expect(clock.snapshot().active).toBe(true);
    resumed();
    unsubscribe();
    expect(clock.snapshot().active_elapsed_ms).toBe(3_000);
    expect(states).toEqual([true, false, false, true, false]);
  });

  it("validates the budget and returns immutable projections", () => {
    expect(
      () =>
        new BrowserArticleClock({
          budget: { ...DEFAULT_BROWSER_ARTICLE_BUDGET, active_ms: 0 },
        }),
    ).toThrow(TypeError);
    expect(() => new BrowserArticleClock({ now: () => Number.NaN })).toThrow(
      TypeError,
    );
    const { clock } = clockFixture();
    expect(Object.isFrozen(clock.budget)).toBe(true);
    expect(Object.isFrozen(clock.remaining())).toBe(true);
    expect(Object.isFrozen(clock.snapshot())).toBe(true);
  });
});
