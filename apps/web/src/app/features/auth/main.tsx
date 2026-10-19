import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, IconButton } from "../../components/actions.js";
import { MotionProvider } from "../../motion/index.js";
import { loginDestination, loginStatus, signIn } from "../../data/auth.js";
import { readTheme, bindTheme } from "../../data/preferences.js";
import "../../styles/tokens.css";
import "../../styles/base.css";
import "../../styles/components.css";
import "./auth.css";
import "../../../../entry/public/react-aria.css";

function Login() {
  const [password, setPassword] = useState(""),
    [show, setShow] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null),
    busy = useRef(false),
    controller = useRef(new AbortController());
  useEffect(() => {
    const unbindTheme = bindTheme(readTheme());
    const stop = controller.current;
    void loginStatus(stop.signal)
      .then((authenticated) => {
        if (authenticated && !stop.signal.aborted)
          location.replace(loginDestination(location.search, location.origin));
      })
      .catch(() => {
        /* Explicit sign-in presents connection errors without hiding the form. */
      });
    return () => {
      unbindTheme();
      stop.abort();
    };
  }, []);
  return (
    <div className="auth-page">
      <header className="auth-brand">
        <span aria-hidden="true" className="auth-logo">
          S
        </span>
        SciRetriever
      </header>
      <main className="auth-main">
        <h1>打开你的文献库</h1>
        <p className="auth-intro">
          输入访问密码，或启动终端显示的 API key，继续阅读与处理文献。
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (busy.current || !password) return;
            busy.current = true;
            setPending(true);
            setError("");
            void signIn(password, controller.current.signal)
              .then(() => {
                setPassword("");
                location.replace(
                  loginDestination(location.search, location.origin),
                );
              })
              .catch((failure) => {
                if (!controller.current.signal.aborted) {
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : "登录失败，请重试。",
                  );
                  input.current?.focus();
                  input.current?.select();
                }
              })
              .finally(() => {
                busy.current = false;
                setPending(false);
              });
          }}
        >
          <label className="ui-label" htmlFor="access-password">
            密码或 API key
          </label>
          <div className="auth-input">
            <input
              ref={input}
              id="access-password"
              name="password"
              type={show ? "text" : "password"}
              autoComplete="current-password"
              required
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-describedby="login-error"
              aria-invalid={!!error}
            />
            <IconButton
              aria-label={show ? "隐藏密码" : "显示密码"}
              aria-pressed={show}
              variant="text"
              type="button"
              onPress={() => setShow((value) => !value)}
            >
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
                <circle cx="12" cy="12" r="3" />
                {show ? <path d="M3 3 21 21" /> : null}
              </svg>
            </IconButton>
          </div>
          <p
            id="login-error"
            className="auth-error"
            role="alert"
            aria-live="polite"
          >
            {error}
          </p>
          <Button
            id="login-submit"
            type="submit"
            variant="primary"
            isPending={pending}
          >
            {pending ? "正在登录…" : "进入文献库"}
          </Button>
        </form>
        <p className="auth-note">
          文献与任务保存在服务器上。登录有效期为 12 小时，可在设置中退出。
        </p>
      </main>
    </div>
  );
}
const root = document.getElementById("auth-root");
if (!root) throw new Error("Authentication root is missing");
createRoot(root).render(
  <MotionProvider>
    <Login />
  </MotionProvider>,
);
