import { useEffect } from "react";

import { approvalPortName, type RequestId } from "@/types/messages";

/**
 * Holds the keep-alive port open for as long as this window exists.
 *
 * ---------------------------------------------------------------------------
 * THIS HOOK IS NOT OPTIONAL DECORATION
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: hace dos trabajos, y los dos sostienen la fase entera.
 *
 *   1. Un puerto conectado mantiene vivo el service worker. Sin él, Chrome lo
 *      suspende a los ~30 s y se lleva por delante la promesa que está
 *      esperando la decisión — justo mientras el usuario piensa, que es
 *      exactamente cuando más tarda. La dApp se quedaría colgada.
 *
 *   2. Cuando esta ventana se cierra con la X, el puerto cae y el background se
 *      entera. Es más fiable que `chrome.windows.onRemoved` porque cubre además
 *      que la página crashee o navegue: en los tres casos el puerto muere.
 *
 * No se manda nada por el puerto. Su valor es existir.
 */
export function useApprovalPort(requestId: RequestId | null): void {
  useEffect(() => {
    if (requestId === null) return;

    try {
      chrome.runtime.connect({ name: approvalPortName(requestId) });
    } catch (cause) {
      // The extension is reloading. The request times out on its own.
      console.error("[codecrypto] could not open the keep-alive port:", cause);
    }

    /**
     * ------------------------------------------------------------------------
     * NO CLEANUP, AND ESO ES LO CORRECTO
     * ------------------------------------------------------------------------
     * 🇪🇸 NOTA: la tentación es devolver `() => port.disconnect()`. Sería un bug.
     *
     * El background trata la caída del puerto como "el usuario cerró la
     * ventana" y rechaza la solicitud con 4001. React en StrictMode monta,
     * desmonta y vuelve a montar, así que ese cleanup rechazaría una solicitud
     * que el usuario TIENE DELANTE en la pantalla — y el segundo puerto llegaría
     * tarde, cuando la dApp ya recibió su 4001.
     *
     * La semántica que se quiere es "el puerto vive lo que vive la ventana", y
     * eso es justo lo que hace Chrome solo cuando la ventana se destruye. Un
     * puerto de más en desarrollo no molesta: al cerrar, los dos caen y el
     * rechazo es idempotente.
     */
  }, [requestId]);
}
