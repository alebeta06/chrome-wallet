import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Popup } from "./Popup";

const container = document.getElementById("root");
if (container === null) throw new Error("Missing #root in index.html");

createRoot(container).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
