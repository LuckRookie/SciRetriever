import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
/** Isolated component gallery: real libraries and CSP, no application/database/network services. */
export async function componentFixture(kind: "gallery" | "lab" = "gallery") {
  const result = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Gallery from './src/app/features/lab/${kind === "lab" ? "Lab" : "Gallery"}.tsx'; import {MotionProvider} from './src/app/motion/index.tsx'; import {ToastProvider} from './src/app/components/index.tsx'; import './src/app/styles/tokens.css'; import './src/app/styles/font-faces.css'; import './src/app/styles/font-faces-cjk.css'; import './src/app/styles/base.css'; import './src/app/styles/components.css'; import './src/app/styles/pages.css'; createRoot(document.getElementById('root')).render(<MotionProvider><ToastProvider><Gallery/></ToastProvider></MotionProvider>);`,
      resolveDir: new URL("..", import.meta.url).pathname,
      loader: "tsx",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome140",
    minify: true,
    write: false,
    outdir: "/tmp/sciretriever-components-build",
    entryNames: "gallery",
    assetNames: "[name]-[hash]",
    loader: { ".woff2": "file" },
  });
  const assets = new Map(
    result.outputFiles.map((file) => [
      `/${basename(file.path)}`,
      file.contents,
    ]),
  );
  assets.set(
    "/react-aria.css",
    await readFile(new URL("../entry/public/react-aria.css", import.meta.url)),
  );
  const html =
    '<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link id="react-aria-pressable-style" rel="stylesheet" href="/react-aria.css"><link rel="stylesheet" href="/gallery.css"><script type="module" src="/gallery.js"></script></head><body><div id="root"></div></body></html>';
  assets.set("/", new TextEncoder().encode(html));
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const asset = assets.get(path);
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; img-src 'self' blob: data:; connect-src 'none'; object-src 'none'; base-uri 'none'",
    );
    response.setHeader("Cache-Control", "no-store");
    if (!asset) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader(
      "Content-Type",
      path === "/"
        ? "text/html; charset=utf-8"
        : path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".woff2")
            ? "font/woff2"
            : "text/javascript",
    );
    response.end(asset);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Component fixture did not bind");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({
    ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
      ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
      : {}),
    headless: true,
  });
  const page = await browser.newPage({
    ...(process.env.SCIRETRIEVER_REDUCED_MOTION === "reduce"
      ? { reducedMotion: "reduce" as const }
      : {}),
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(20_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  await page.goto(origin);
  return {
    page,
    browser,
    origin,
    errors,
    close: async () => {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
