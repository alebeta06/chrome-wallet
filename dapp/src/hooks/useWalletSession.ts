"use client";

import { useCallback, useEffect, useState } from "react";

import { describeProviderError, type DisplayError } from "@/lib/errors";
import type { EIP1193Provider } from "@/types/eip1193";

export interface WalletSession {
  /** The account this origin is connected with, or null when it is not. */
  account: string | null;
  chainId: string | null;
  error: DisplayError | null;
  /** Re-reads both. Called after connecting, disconnecting, or an event. */
  refresh(): Promise<void>;
  setAccount(account: string | null): void;
}

/**
 * What this origin currently is, as far as the wallet is concerned.
 *
 * 🇪🇸 NOTA: se relee en cada `accountsChanged` y `chainChanged`, y también al
 * montar. Lo de montar es lo que hace que recargar una dApp ya conectada la
 * muestre conectada sin pedir nada: el permiso vive en la wallet, no en el
 * estado de esta página.
 */
export function useWalletSession(
  provider: EIP1193Provider,
  revision: number,
): WalletSession {
  const [account, setAccount] = useState<string | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [accounts, chain] = await Promise.all([
        provider.request({ method: "eth_accounts" }),
        provider.request({ method: "eth_chainId" }),
      ]);

      setAccount(Array.isArray(accounts) && accounts.length > 0 ? String(accounts[0]) : null);
      setChainId(typeof chain === "string" ? chain : null);
      setError(null);
    } catch (cause) {
      setError(describeProviderError(cause));
    }
  }, [provider]);

  useEffect(() => {
    void refresh();
  }, [refresh, revision]);

  return { account, chainId, error, refresh, setAccount };
}
