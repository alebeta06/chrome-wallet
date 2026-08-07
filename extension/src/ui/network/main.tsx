import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../styles.css";
import { NetworkForm } from "./NetworkForm";

/**
 * 🇪🇸 NOTA: superficie propia y no una pestaña del popup, y no es cosmético.
 *
 * El spike del GATE 2 midió que `chrome.permissions.request()` desde el popup de
 * la acción MATA su contexto: el diálogo nativo aparece, el popup se cierra, y
 * el `await` no vuelve nunca — el permiso se concede y el código no se entera.
 * Una ventana `chrome.windows.create({type:'popup'})` sí sobrevive.
 *
 * Y hay una segunda razón que no viene del spike: el popup de la acción se
 * cierra al hacer clic fuera. Un formulario de cinco campos ahí pierde lo
 * escrito con un despiste.
 */
document.body.classList.add("surface-window");

const container = document.getElementById("root");
if (container === null) throw new Error("Missing #root in network.html");

createRoot(container).render(
  <StrictMode>
    <NetworkForm />
  </StrictMode>,
);
