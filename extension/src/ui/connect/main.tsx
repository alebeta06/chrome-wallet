import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Connect } from "./Connect";

const container = document.getElementById("root");
if (container === null) throw new Error("Missing #root in connect.html");

createRoot(container).render(
  <StrictMode>
    <Connect />
  </StrictMode>,
);
