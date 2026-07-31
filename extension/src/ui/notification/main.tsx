import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../styles.css";
import { Notification } from "./Notification";

// Approval windows size themselves; the 360px popup width must not apply.
document.body.classList.add("surface-window");

const container = document.getElementById("root");
if (container === null) throw new Error("Missing #root in notification.html");

createRoot(container).render(
  <StrictMode>
    <Notification />
  </StrictMode>,
);
