import { useCallback, useEffect, useState } from "react";

import type { WalletSnapshot } from "@/types/messages";
import { callBackground, toRpcError, type RpcError } from "@/ui/rpc";

export interface WalletStateHook {
  snapshot: WalletSnapshot | null;
  error: RpcError | null;
  isLoading: boolean;
  refresh(): Promise<void>;
}

/**
 * The popup's single source of truth for accounts, chain and default index.
 *
 * 🇪🇸 NOTA: no hay polling aquí. El estado de la wallet solo cambia cuando el
 * usuario hace algo en este mismo popup, así que basta con volver a pedirlo
 * después de cada acción. Cuando en la Fase 5 haya cambios que vengan de fuera
 * (una dApp conectándose), el contrato ya tiene CODECRYPTO_STATE_CHANGED para
 * eso — y seguirá sin hacer falta polling.
 */
export function useWalletState(): WalletStateHook {
  const [snapshot, setSnapshot] = useState<WalletSnapshot | null>(null);
  const [error, setError] = useState<RpcError | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      setSnapshot(await callBackground("wallet_getState"));
      setError(null);
    } catch (cause) {
      setError(toRpcError(cause));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * ------------------------------------------------------------------------
   * EL POPUP SE ENTERA DE LO QUE PASA FUERA, SIN SONDEAR
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: hasta la Fase 8 el estado solo cambiaba por acciones del propio
   * popup, así que bastaba con volver a pedirlo después de cada una. Ya no: una
   * dApp puede llamar a `wallet_switchEthereumChain`, y perder el permiso de la
   * red activa la mueve sola. Sin esto, el popup abierto seguiría enseñando la
   * red anterior hasta que alguien lo cerrara y abriera.
   *
   * (Lo segundo hoy no se sabe provocar a mano: `chrome://extensions` no da
   * control por host. Ver la comprobación 80. Lo primero pasa igual, y basta
   * para justificar esto.)
   *
   * Se escucha `chrome.storage.onChanged` y no se añade un mensaje nuevo al
   * contrato: el cambio YA deja huella en storage —es la única fuente de verdad
   * del proyecto— y colgarse de ella cubre todos los caminos que puedan
   * escribirla, incluidos los que no existen todavía. Sigue sin haber sondeo.
   */
  useEffect(() => {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ): void => {
      if (areaName !== "local") return;
      if (changes["cc:chainId"] === undefined && changes["cc:networks"] === undefined) return;

      void refresh();
    };

    chrome.storage.onChanged.addListener(listener);
    return () => {
      chrome.storage.onChanged.removeListener(listener);
    };
  }, [refresh]);

  return { snapshot, error, isLoading, refresh };
}
