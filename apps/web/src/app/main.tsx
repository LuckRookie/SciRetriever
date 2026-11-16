// Styles first: `tokens.css` opens with the layer order, and the bundle keeps
// the order in which CSS is first imported. A page's CSS reached through the
// application before it would declare `pages` first and make it the lowest
// layer.
import "./styles/tokens.css";
import "./styles/font-faces.css";
import "./styles/font-faces-cjk.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/pages.css";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "./data/query.js";
import { Application } from "./shell/Application.js";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");
createRoot(root).render(
  <QueryClientProvider client={createQueryClient()}>
    <Application />
  </QueryClientProvider>,
);
