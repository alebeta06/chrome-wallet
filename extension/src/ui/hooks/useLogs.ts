import { useCallback, useEffect, useState } from "react";

import type { LogEntry } from "@/types/messages";
import { affectsLogs } from "./log-view";

export interface LogsHook {
  entries: LogEntry[];
  error: string | null;
  refresh(): Promise<void>;
}

/**
 * Reads `cc:logs` straight from storage, and re-reads when it changes.
 *
 * ---------------------------------------------------------------------------
 * NO NEW MESSAGE TYPE FOR THIS
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: no hay `wallet_getLogs` en el contrato y no se añade. El popup es una
 * página de la extensión, así que puede leer `chrome.storage.local` directamente
 * — y el registro ya vive ahí, que es la única fuente de verdad del proyecto.
 * Un método RPC nuevo sería una segunda forma de leer lo mismo, y `messages.ts`
 * es el ABI: no se amplía sin necesidad.
 *
 * Leer no es escribir. El popup NUNCA escribe en `cc:logs`: el único escritor es
 * el service worker, y por eso el orden del array es fiable.
 */
export function useLogs(): LogsHook {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const stored = await chrome.storage.local.get(["cc:logs"]);
      // A wallet installed a minute ago has no key at all, and that is not an
      // error state: it is an empty log.
      setEntries((stored["cc:logs"] as LogEntry[] | undefined) ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the activity log.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 🇪🇸 NOTA: misma forma que la suscripción de `useWalletState` — filtrar el
   * área, filtrar la clave, y quitar el listener al desmontar. Sin quitarlo, cada
   * apertura del popup dejaría uno más colgado del mismo evento.
   */
  useEffect(() => {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (!affectsLogs(changes, areaName)) return;
      void refresh();
    };

    chrome.storage.onChanged.addListener(listener);
    return () => {
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [refresh]);

  return { entries, error, refresh };
}
