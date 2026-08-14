import { useState } from "react";

import type { WalletSnapshot } from "@/types/messages";
import { useBalances } from "@/ui/hooks/useBalances";
import { callBackground, toRpcError } from "@/ui/rpc";
import { AccountRow } from "./AccountRow";
import { ActivityLog } from "./ActivityLog";
import { ActiveSiteBand } from "./ActiveSiteBand";
import { ConnectedSites } from "./ConnectedSites";
import { InternalTransfer } from "./InternalTransfer";
import { NetworkSelector } from "./NetworkSelector";
import { ResetButton } from "./ResetButton";

interface WalletViewProps {
  snapshot: WalletSnapshot;
  onChanged(): void;
}

export function WalletView({ snapshot, onChanged }: WalletViewProps) {
  const {
    balances,
    error: balanceError,
    isInitialLoad,
  } = useBalances(snapshot.accounts, snapshot.chainId);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Bumped so the connected-sites list re-reads after any change. */
  const [revision, setRevision] = useState(0);

  const network = snapshot.networks.find((entry) => entry.chainId === snapshot.chainId);
  const isOffline = balanceError !== null;
  const activeSite = snapshot.activeSite;

  function refreshAll(): void {
    setRevision((current) => current + 1);
    onChanged();
  }

  async function run(action: () => Promise<unknown>): Promise<void> {
    setActionError(null);
    try {
      await action();
      refreshAll();
    } catch (cause) {
      setActionError(toRpcError(cause).message);
    }
  }

  /**
   * 🇪🇸 NOTA: la lista de cuentas cambia SIEMPRE la cuenta por defecto, esté o
   * no el popup sobre un sitio conectado. La cuenta del sitio se cambia en la
   * banda de arriba, que tiene su propio control. Un mismo botón que hiciera una
   * cosa u otra según el contexto haría imposible saber qué va a pasar antes de
   * pulsarlo — y las dos cosas emiten (o no) eventos muy distintos.
   */
  async function selectAccount(accountIndex: number): Promise<void> {
    if (accountIndex === snapshot.defaultAccountIndex) return;
    await run(() => callBackground("wallet_setDefaultAccount", { accountIndex }));
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

      {activeSite !== null && (
        <ActiveSiteBand
          site={activeSite}
          accounts={snapshot.accounts}
          onSelectAccount={(accountIndex) =>
            void run(() =>
              callBackground("wallet_setSiteAccount", { origin: activeSite.origin, accountIndex }),
            )
          }
          onDisconnect={() =>
            void run(() => callBackground("wallet_disconnectSite", { origin: activeSite.origin }))
          }
        />
      )}

      <ul className="account-list" data-testid="account-list">
        {snapshot.accounts.map((address, index) => (
          <AccountRow
            key={address}
            index={index}
            address={address}
            balance={balances[address]}
            isDefault={index === snapshot.defaultAccountIndex}
            isActiveSite={activeSite !== null && activeSite.accountIndex === index}
            isInitialLoad={isInitialLoad}
            onSelect={(selected) => void selectAccount(selected)}
          />
        ))}
      </ul>

      <InternalTransfer
        accounts={snapshot.accounts}
        fromIndex={snapshot.defaultAccountIndex}
        balances={balances}
        onSent={refreshAll}
      />

      <NetworkSelector
        networks={snapshot.networks}
        chainId={snapshot.chainId}
        unusableChainIds={snapshot.unusableChainIds}
        onChanged={refreshAll}
      />

      <ConnectedSites
        accounts={snapshot.accounts}
        revision={revision}
        onChanged={refreshAll}
      />

      {/*
        🇪🇸 NOTA: el panel NO recibe `revision` ni `onChanged`, a diferencia de la
        lista de sitios. Se entera solo, por `chrome.storage.onChanged`, y ésa es
        la diferencia que importa: casi todo lo que acaba en el registro pasa con
        el popup cerrado o sin que el popup haya hecho nada — una dApp firmando,
        un evento saliendo. Colgarlo de las acciones del popup lo dejaría
        enseñando un registro viejo justo cuando hay algo nuevo que ver.
      */}
      <ActivityLog />

      <ResetButton onReset={refreshAll} />
    </div>
  );
}
