import { createPreviewServer } from "./preview-server.js";

const server = createPreviewServer();
server.on("error", (error: NodeJS.ErrnoException) => {
  process.stderr.write(
    error.code === "EADDRINUSE"
      ? "Preview port 4173 is already in use.\n"
      : "Preview server could not start.\n",
  );
  process.exitCode = 1;
});
server.listen(4173, "127.0.0.1", () => {
  process.stdout.write("SciRetriever Browser sample: http://127.0.0.1:4173\n");
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close());
}
