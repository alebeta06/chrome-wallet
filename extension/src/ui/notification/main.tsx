import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Notification } from "./Notification";

const container = document.getElementById("root");
if (container === null) throw new Error("Missing #root in notification.html");

createRoot(container).render(
  <StrictMode>
    <Notification />
  </StrictMode>,
);
