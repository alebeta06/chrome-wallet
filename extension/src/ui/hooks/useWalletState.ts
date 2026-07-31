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

  return { snapshot, error, isLoading, refresh };
}
