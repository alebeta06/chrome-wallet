import { useState } from "react";

import type { WalletSnapshot } from "@/types/messages";
import { useBalances } from "@/ui/hooks/useBalances";
import { callBackground, toRpcError } from "@/ui/rpc";
import { AccountRow } from "./AccountRow";
import { ResetButton } from "./ResetButton";

interface WalletViewProps {
  snapshot: WalletSnapshot;
  onChanged(): void;
}

export function WalletView({ snapshot, onChanged }: WalletViewProps) {
  const { balances, error: balanceError, isInitialLoad } = useBalances(snapshot.accounts);
  const [actionError, setActionError] = useState<string | null>(null);

  const network = snapshot.networks.find((entry) => entry.chainId === snapshot.chainId);
  const isOffline = balanceError !== null;

  async function selectAccount(accountIndex: number): Promise<void> {
    if (accountIndex === snapshot.defaultAccountIndex) return;

    setActionError(null);
    try {
      await callBackground("wallet_setDefaultAccount", { accountIndex });
      onChanged();
    } catch (cause) {
      setActionError(toRpcError(cause).message);
    }
  }

  return (
    <div className="stack" data-testid="wallet-view">
      <div className="row row--between">
        <h2>Accounts</h2>
        <span className="network-badge" data-testid="network-badge">
          <span className={`network-badge__dot ${isOffline ? "network-badge__dot--offline" : ""}`} />
          {network?.name ?? snapshot.chainId}
        </span>
      </div>

      {/*
        🇪🇸 NOTA: el aviso de red se muestra JUNTO a la lista, no en vez de ella.
        Con Anvil apagado la wallet sigue siendo perfectamente usable: las
        direcciones son correctas, se pueden copiar y se puede cambiar la cuenta
        por defecto. Lo único que falta son los saldos.
      */}
      {balanceError !== null && (
        <p className="banner banner--error" data-testid="balance-error-banner">
          {balanceError.isChainUnreachable
            ? `Cannot reach ${network?.name ?? "the network"}. Balances may be out of date.`
            : balanceError.message}
        </p>
      )}

      {actionError !== null && (
        <p className="banner banner--error" data-testid="wallet-error-banner">
          {actionError}
        </p>
      )}

      <ul className="account-list" data-testid="account-list">
        {snapshot.accounts.map((address, index) => (
          <AccountRow
            key={address}
            index={index}
            address={address}
            balance={balances[address]}
            isDefault={index === snapshot.defaultAccountIndex}
            isInitialLoad={isInitialLoad}
            onSelect={(selected) => void selectAccount(selected)}
          />
        ))}
      </ul>

      <ResetButton onReset={onChanged} />
    </div>
  );
}
