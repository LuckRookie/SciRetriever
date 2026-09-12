import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";

/** Local sample assets only. No application, configuration or Browser Host. */
export function createPreviewServer(): Server {
  const assets = new Map<string, { file: URL; type: string }>([
    [
      "/",
      {
        file: new URL("../public/index.html", import.meta.url),
        type: "text/html; charset=utf-8",
      },
    ],
    [
      "/styles.css",
      {
        file: new URL("../public/styles.css", import.meta.url),
        type: "text/css; charset=utf-8",
      },
    ],
    ...["main", "demo", "icons"].map(
      (name): [string, { file: URL; type: string }] => [
        `/${name}.js`,
        {
          file: new URL(`../dist/${name}.js`, import.meta.url),
          type: "text/javascript; charset=utf-8",
        },
      ],
    ),
  ]);
  return createServer((request, response) => {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    const asset = assets.get(request.url ?? "");
    if (!asset) {
      response.writeHead(404);
      response.end();
      return;
    }
    void readFile(asset.file)
      .then((bytes) => {
        response.writeHead(200, { "Content-Type": asset.type });
        response.end(request.method === "HEAD" ? undefined : bytes);
      })
      .catch(() => {
        response.writeHead(500);
        response.end("Preview asset unavailable. Build the web sample first.");
      });
  });
}
