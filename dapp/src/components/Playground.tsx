"use client";

import { useEffect, useState } from "react";

import { ConnectPanel } from "@/components/ConnectPanel";
import { EventLog } from "@/components/EventLog";
import { MethodPanel } from "@/components/MethodPanel";
import { NoWalletsEmptyState } from "@/components/NoWalletsEmptyState";
import { ProviderCard } from "@/components/ProviderCard";
import { SendPanel } from "@/components/SendPanel";
import { SignTypedDataPanel } from "@/components/SignTypedDataPanel";
import { WalletPicker } from "@/components/WalletPicker";
import { requestProviders, useProviders } from "@/hooks/useProviders";
import { useProviderEvents } from "@/hooks/useProviderEvents";
import { useWalletSession } from "@/hooks/useWalletSession";
import { CODECRYPTO_RDNS, type EIP6963ProviderDetail } from "@/types/eip1193";

/**
 * Discovery and the wallet picker. Everything that needs a chosen provider
 * lives in <Session>, below.
 *
 * 🇪🇸 NOTA: la separación no es estética. `useWalletSession` y
 * `useProviderEvents` necesitan un provider, y un hook no se puede llamar
 * condicionalmente — así que la rama "no hay wallet" tiene que salir antes de
 * que exista el componente que los usa.
 */
export function Playground() {
  const providers = useProviders();
  const [selectedRdns, setSelectedRdns] = useState<string | null>(null);

  /**
   * 🇪🇸 NOTA: la preselección se hace en un efecto y no durante el render. Las
   * wallets llegan de forma asíncrona, así que en el primer render la lista está
   * vacía y no hay nada que elegir.
   */
  useEffect(() => {
    if (selectedRdns !== null || providers.length === 0) return;

    const ours = providers.find((entry) => entry.info.rdns === CODECRYPTO_RDNS);
    setSelectedRdns((ours ?? providers[0]).info.rdns);
  }, [providers, selectedRdns]);

  if (providers.length === 0) {
    return (
      <section className="section">
        <NoWalletsEmptyState onLookAgain={requestProviders} />
      </section>
    );
  }

  const selected = providers.find((entry) => entry.info.rdns === selectedRdns) ?? null;

  return (
    <>
      <section className="section">
        <h2 className="section-title">1 · Discovered wallets (EIP-6963)</h2>
        <p className="section-note">
          Every wallet that answered the announcement request. This page never reads{" "}
          <code>window.ethereum</code> or <code>window.codecrypto</code> directly — that is
          the point of EIP-6963, and it is why several wallets can coexist here without
          fighting over a global.
        </p>
        <WalletPicker
          providers={providers}
          selectedRdns={selectedRdns}
          onSelect={setSelectedRdns}
          onLookAgain={requestProviders}
        />
      </section>

      {selected !== null && <Session key={selected.info.rdns} detail={selected} />}
    </>
  );
}

function Session({ detail }: { detail: EIP6963ProviderDetail }) {
  const events = useProviderEvents(detail.provider);

  /**
   * 🇪🇸 NOTA: cada evento de cuenta o de red hace que se relea la sesión. Es lo
   * que hace visible el modelo por origen: cambias la cuenta de este sitio desde
   * el popup y la página se actualiza sola, sin recargar y sin que la otra dApp
   * se entere de nada.
   */
  const revision = events.filter(
    (event) => event.name === "accountsChanged" || event.name === "chainChanged",
  ).length;

  const session = useWalletSession(detail.provider, revision);

  return (
    <>
      <section className="section">
        <h2 className="section-title">2 · Selected wallet</h2>
        <ProviderCard info={detail.info} />
      </section>

      <section className="section">
        <h2 className="section-title">3 · Connection</h2>
        <p className="section-note">
          <code>eth_requestAccounts</code> asks the wallet for permission. The account you
          approve is bound to <strong>this origin only</strong> — the same wallet can be on a
          different account for a different site, at the same time.
        </p>
        <ConnectPanel
          provider={detail.provider}
          account={session.account}
          onAccount={session.setAccount}
        />
      </section>

      <section className="section">
        <h2 className="section-title">4 · Send a transaction</h2>
        <p className="section-note">
          <code>eth_sendTransaction</code> opens an approval window. The wallet signs in its
          service worker — this page never sees a key, and the <code>from</code> it accepts
          is the account you granted to this origin and no other.
        </p>
        <SendPanel
          provider={detail.provider}
          account={session.account}
          chainId={session.chainId}
        />
      </section>

      <section className="section">
        <h2 className="section-title">5 · Sign a message (EIP-712)</h2>
        <p className="section-note">
          <code>eth_signTypedData_v4</code> signs structured data. It costs no gas and never
          touches the chain — which is exactly why it deserves reading before approving: a{" "}
          <code>Permit</code> is a signature, not a transaction. The result is verified here
          with <code>verifyTypedData</code>, which recovers the signer from the signature
          alone.
        </p>
        <SignTypedDataPanel provider={detail.provider} account={session.account} />
      </section>

      <section className="section">
        <h2 className="section-title">6 · Public methods (no permission required)</h2>
        <p className="section-note">
          These the wallet answers without any approval. Everything else answers{" "}
          <code>4200</code> until the phase that implements it.
        </p>
        <MethodPanel provider={detail.provider} accountsRevision={revision} />
      </section>

      <section className="section">
        <h2 className="section-title">7 · Provider events</h2>
        <p className="section-note">
          Live <code>accountsChanged</code>, <code>chainChanged</code>, <code>connect</code>{" "}
          and <code>disconnect</code>.
        </p>
        <EventLog events={events} />
      </section>

      <section className="section">
        <h2 className="section-title">8 · Injection inside an iframe</h2>
        <p className="section-note">
          The extension declares <code>all_frames</code> because plenty of dApps live inside
          an iframe, and a wallet that only injects into the top frame does not exist for
          them. This embeds <code>/frame</code> to check it.
        </p>
        <iframe
          className="frame-embed"
          src="/frame"
          title="Frame injection probe"
          data-testid="iframe"
        />
      </section>
    </>
  );
}
