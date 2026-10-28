import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { DirectBrowserInput } from "@sciretriever/contracts";
import { useApi } from "../../data/query.js";
import { errorMessage } from "../../strings.js";
import { ProblemDetails, problemText } from "../sources/problem.js";
import {
  ScreencastClient,
  ScreencastInputError,
  type ScreencastState,
} from "./screencast-client.js";

export interface ScreencastStageHandle {
  readonly state: ScreencastState;
  /** Resolves once the server has re-observed and handed the page back to the Agent. */
  release(): Promise<void>;
}

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const modifiers = (e: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}) =>
  (e.altKey ? 1 : 0) |
  (e.ctrlKey ? 2 : 0) |
  (e.metaKey ? 4 : 0) |
  (e.shiftKey ? 8 : 0);
const buttons = ["left", "middle", "right"] as const;
const pageKinds: Record<string, string> = {
  pdf: "PDF 阅读器",
  html: "网页",
  other: "非网页内容",
};

/**
 * The live page: a canvas fed by the screencast and a hidden text field that carries
 * the person's keyboard, paste and input-method text to the page. Moving the pointer
 * only watches; the first press, scroll, key or text takes control and pauses the
 * Agent.
 */
export const ScreencastStage = forwardRef<
  ScreencastStageHandle,
  {
    sessionId: string;
    readOnly: boolean;
    /** Called on each input the person sends, to hold the idle return. */
    onActivity: () => void;
    onFeedback: (text: string) => void;
    onState?: (state: ScreencastState) => void;
    /** Overlays drawn in the same box as the picture, such as the Agent pointer. */
    children?: ReactNode;
  }
>(function ScreencastStage(
  { sessionId, readOnly, onActivity, onFeedback, onState, children },
  ref,
) {
  const api = useApi();
  const canvas = useRef<HTMLCanvasElement>(null),
    keyboard = useRef<HTMLTextAreaElement>(null),
    client = useRef<ScreencastClient | null>(null),
    composing = useRef(false),
    move = useRef<{
      x: number;
      y: number;
      buttons: number;
      modifiers: number;
    } | null>(null),
    pressed = useRef(false);
  const [state, setState] = useState<ScreencastState | null>(null);
  const report = useRef(onState);
  report.current = onState;
  useEffect(() => {
    const next = new ScreencastClient(
      sessionId,
      () => ({ clientId: api.clientId, csrf: api.csrf }),
      () => canvas.current,
    );
    client.current = next;
    const update = (value: ScreencastState) => {
      setState(value);
      report.current?.(value);
    };
    update(next.state);
    next.subscribe(update);
    next.connect();
    return () => {
      // Unmounting never hands control back by itself; the viewer closes through release().
      next.dispose();
      if (client.current === next) client.current = null;
    };
  }, [api, sessionId]);
  useImperativeHandle(
    ref,
    () => ({
      get state() {
        return client.current?.state ?? state!;
      },
      release: async () => {
        await client.current?.release();
      },
    }),
    [state],
  );
  const send = (input: DirectBrowserInput) => {
    const current = client.current;
    if (!current || readOnly) return;
    onActivity();
    void current.input(input).catch((error: unknown) => {
      onFeedback(
        error instanceof ScreencastInputError
          ? `页面没有接受这次操作：${problemText(error.problem?.display ?? "error")}`
          : errorMessage(error),
      );
    });
  };
  /** Pointer position in the frame's JPEG pixels, the coordinates the server expects. */
  const point = (event: { clientX: number; clientY: number }) => {
    const node = canvas.current,
      size = client.current?.frameSize;
    if (!node || !size) return null;
    const box = node.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    return {
      x: ((event.clientX - box.left) * size.width) / box.width,
      y: ((event.clientY - box.top) * size.height) / box.height,
    };
  };
  useEffect(() => {
    const node = canvas.current;
    if (!node) return;
    // Wheel must be non-passive so the page, not the dialog, scrolls.
    const wheel = (event: WheelEvent) => {
      const at = point(event);
      if (!at || readOnly) return;
      event.preventDefault();
      const clamp = (v: number) => Math.max(-2000, Math.min(2000, v));
      send({
        kind: "wheel",
        ...at,
        delta_x: clamp(event.deltaX),
        delta_y: clamp(event.deltaY),
        modifiers: modifiers(event),
      });
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  });
  const controlling = state?.control === "controlling";
  // Moves are coalesced to one per frame and only sent once the person has control.
  const flushMove = () => {
    const next = move.current;
    move.current = null;
    if (next && (controlling || pressed.current))
      send({
        kind: "mouse",
        action: "move",
        x: next.x,
        y: next.y,
        button: "none",
        buttons: next.buttons,
        click_count: 0,
        modifiers: next.modifiers,
      });
  };
  const status = !state
    ? "正在连接画面…"
    : state.status === "reconnecting"
      ? "连接中断，正在重新连接…"
      : state.status === "no-frame"
        ? `这个${pageKinds[state.pageKind ?? ""] ?? "页面"}暂时没有画面`
        : state.status === "closed"
          ? "会话已结束"
          : !state.painted
            ? "正在等待第一帧画面…"
            : "";
  return (
    <div
      className="browser-frame-wrap"
      data-status={state?.status}
      data-control={state?.control}
      data-painted={state?.painted || undefined}
    >
      <canvas
        ref={canvas}
        className="browser-frame"
        role="img"
        aria-label="Browser 页面实时画面"
        data-readonly={readOnly || undefined}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          const at = point(event);
          if (!at) return;
          if (readOnly) {
            onFeedback("流程已结束，画面只读。");
            return;
          }
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          pressed.current = true;
          keyboard.current?.focus({ preventScroll: true });
          send({
            kind: "mouse",
            action: "down",
            ...at,
            button: buttons[event.button] ?? "left",
            buttons: event.buttons,
            click_count: Math.max(1, event.detail),
            modifiers: modifiers(event),
          });
        }}
        onPointerMove={(event) => {
          const at = point(event);
          if (!at || readOnly) return;
          const pending = move.current;
          move.current = {
            ...at,
            buttons: event.buttons,
            modifiers: modifiers(event),
          };
          if (!pending) requestAnimationFrame(flushMove);
        }}
        onPointerUp={(event) => {
          const at = point(event);
          if (!at || !pressed.current) return;
          pressed.current = false;
          move.current = null;
          send({
            kind: "mouse",
            action: "up",
            ...at,
            button: buttons[event.button] ?? "left",
            buttons: event.buttons,
            click_count: Math.max(1, event.detail),
            modifiers: modifiers(event),
          });
        }}
      />
      <textarea
        ref={keyboard}
        className="browser-keyboard"
        aria-label="向页面输入"
        autoCapitalize="off"
        autoComplete="off"
        spellCheck={false}
        disabled={readOnly}
        onKeyDown={(event) => {
          // Printable characters arrive through input and composition; send the keys
          // that carry no text, and anything with a command modifier.
          if (composing.current || event.nativeEvent.isComposing) return;
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey)
            return;
          if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "v"
          )
            return;
          event.preventDefault();
          send({
            kind: "key",
            action: "down",
            key: event.key,
            code: event.code,
            key_code: event.keyCode,
            location: event.location,
            auto_repeat: event.repeat,
            modifiers: modifiers(event),
          });
        }}
        onKeyUp={(event) => {
          if (composing.current) return;
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey)
            return;
          send({
            kind: "key",
            action: "up",
            key: event.key,
            code: event.code,
            key_code: event.keyCode,
            location: event.location,
            auto_repeat: false,
            modifiers: modifiers(event),
          });
        }}
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain");
          if (text) send({ kind: "paste", text: text.slice(0, 8192) });
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionUpdate={(event) => {
          const node = event.currentTarget;
          send({
            kind: "composition",
            text: event.data,
            selection_start: Math.min(node.selectionStart, event.data.length),
            selection_end: Math.min(node.selectionEnd, event.data.length),
          });
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          if (event.data) send({ kind: "text", text: event.data });
          event.currentTarget.value = "";
        }}
        onInput={(event) => {
          if (composing.current) return;
          const node = event.currentTarget;
          if (node.value)
            send({ kind: "text", text: node.value.slice(0, 8192) });
          node.value = "";
        }}
      />
      {children}
      {status ? (
        <div className="browser-frame-status" role="status">
          <p>{status}</p>
          {state?.problem ? (
            <>
              {state.problem.display === "error" ? null : (
                <p>{problemText(state.problem.display)}</p>
              )}
              <ProblemDetails problem={state.problem} />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
