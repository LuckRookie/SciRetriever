import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "./data/query.js";
import { Application } from "./shell/Application.js";
import "./styles/tokens.css";
import "./styles/font-faces.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/pages.css";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
createRoot(root).render(
  <QueryClientProvider client={createQueryClient()}>
    <Application />
  </QueryClientProvider>,
);
