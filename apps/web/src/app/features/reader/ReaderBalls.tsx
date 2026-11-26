import { useRef } from "react";
import {
  ballLabel,
  pressBall,
  togglePair,
  type BallPress,
  type BallState,
} from "./input/balls.js";

/**
 * One of the reader's floating balls (reading-experience 1.9, ADR 0071).
 * `names` are the pair it minds, the starting one first: 原 and 译, or 看
 * and 读.
 */
export interface ReaderBall {
  id: "read" | "translate";
  names: readonly [string, string];
  state: BallState;
  onChange(state: BallState): void;
  /** What the pair is, for the hint and assistive technology. */
  what: string;
  /** Why it cannot be pressed (no translation yet), or null. */
  disabled?: string | null | undefined;
  /** The pair: offered, or why not; absent where the ball has none. */
  pair?: { reason: string | null } | undefined;
  /** The keys that do the same, shown in the hint. */
  keys?: string;
  /** What is going on behind it (the translated pages being read), with a way to try again. */
  status?:
    | { text: string; action?: { label: string; run(): void } | undefined }
    | null
    | undefined;
}

function Ball({ ball }: { ball: ReaderBall }) {
  const last = useRef<BallPress | null>(null);
  const canPair = !!ball.pair && ball.pair.reason === null;
  const active = ball.state.paired || ball.state.side === "second";
  const label = ballLabel(ball.state, ball.names);
  return (
    <div className="reader-ball-row" data-ball={ball.id}>
      {ball.status ? (
        <span className="reader-ball-status" role="status" aria-live="polite">
          {ball.status.text}
          {ball.status.action ? (
            <button type="button" onClick={ball.status.action.run}>
              {ball.status.action.label}
            </button>
          ) : null}
        </span>
      ) : null}
      {ball.pair ? (
        <button
          type="button"
          className="reader-ball-pair"
          disabled={!canPair || !!ball.disabled}
          title={ball.pair.reason ?? undefined}
          onClick={() => {
            last.current = null;
            ball.onChange(togglePair(ball.state));
          }}
        >
          {ball.state.paired ? "收回" : (ball.pair.reason ?? "并排")}
        </button>
      ) : null}
      <button
        type="button"
        className="reader-ball"
        data-active={active ? "true" : undefined}
        data-paired={ball.state.paired ? "true" : undefined}
        aria-label={`${ball.what}：${ball.state.paired ? "两样并排" : `换到${label}`}`}
        aria-disabled={ball.disabled ? true : undefined}
        title={
          ball.disabled ??
          `${ball.what}：单击换，双击并排${ball.keys ? `（${ball.keys}）` : ""}`
        }
        onClick={(event) => {
          if (ball.disabled) return;
          const next = pressBall(
            ball.state,
            performance.now(),
            last.current,
            canPair,
          );
          last.current = next.press;
          // When the last press was, for tests that must not make a double click.
          event.currentTarget.dataset.pressed = String(
            Math.round(performance.now()),
          );
          ball.onChange(next.state);
        }}
      >
        {label}
      </button>
    </div>
  );
}

/** The balls at the desk's lower right: 读 above 译. */
export function ReaderBalls({ balls }: { balls: readonly ReaderBall[] }) {
  if (!balls.length) return null;
  return (
    <div className="reader-balls" role="group" aria-label="原件、译文与读本">
      {balls.map((ball) => (
        <Ball key={ball.id} ball={ball} />
      ))}
    </div>
  );
}
