import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { request } from "node:http";

const target =
  process.env.SCIRETRIEVER_WEB_API_ORIGIN ?? "http://127.0.0.1:4174";
const api = new URL(target);
if (
  api.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(api.hostname) ||
  api.username ||
  api.password ||
  api.pathname !== "/" ||
  api.search ||
  api.hash
)
  throw new Error("SCIRETRIEVER_WEB_API_ORIGIN must be a loopback HTTP origin");

export default defineConfig({
  root: fileURLToPath(new URL("./entry/", import.meta.url)),
  base: "/",
  appType: "mpa",
  plugins: [
    {
      name: "sciretriever-authenticated-development-entry",
      apply: "serve",
      configureServer(server) {
        server.middlewares.use((incoming, response, next) => {
          const path = new URL(incoming.url ?? "/", "http://localhost");
          if (
            incoming.method !== "GET" ||
            !["/", "/index.html"].includes(path.pathname)
          )
            return next();
          // The normal HTML route verifies login and issues the workbench
          // cookie. Vite supplies only the development HTML after that check.
          const upstream = request(
            new URL(`/${path.search}`, api),
            { method: "GET", headers: incoming.headers },
            (reply) => {
              if (reply.statusCode !== 200) {
                response.writeHead(reply.statusCode ?? 502, reply.headers);
                reply.pipe(response);
                return;
              }
              if (reply.headers["set-cookie"])
                response.setHeader("Set-Cookie", reply.headers["set-cookie"]);
              reply.resume();
              reply.on("end", next);
            },
          );
          upstream.on("error", next);
          response.on("close", () => upstream.destroy());
          upstream.end();
        });
      },
    },
    react(),
  ],
  resolve: {
    alias: { "/src": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    host: "127.0.0.1",
    proxy: Object.fromEntries(
      ["/api/", "/auth", "/reader/"].map((path) => [
        path,
        { target: api.origin, changeOrigin: false, ws: true },
      ]),
    ),
  },
  build: {
    target: "chrome140",
    outDir: fileURLToPath(new URL("./dist/react/", import.meta.url)),
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
  },
});
