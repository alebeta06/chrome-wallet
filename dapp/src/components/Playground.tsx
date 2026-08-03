"use client";

import { useEffect, useState } from "react";

import { EventLog } from "@/components/EventLog";
import { ConnectPanel } from "@/components/ConnectPanel";
import { MethodPanel } from "@/components/MethodPanel";
import { NoWalletsEmptyState } from "@/components/NoWalletsEmptyState";
import { ProviderCard } from "@/components/ProviderCard";
import { WalletPicker } from "@/components/WalletPicker";
import { requestProviders, useProviders } from "@/hooks/useProviders";
import { useProviderEvents } from "@/hooks/useProviderEvents";
import { CODECRYPTO_RDNS } from "@/types/eip1193";

/**
 * Everything that needs a browser lives under here.
 *
 * 🇪🇸 NOTA: `page.tsx` se queda como componente de servidor con el texto de la
 * cabecera, y solo esto es cliente. Así la página tiene HTML real antes de que
 * hidrate: quien la abra sin JavaScript, o mientras carga, ve de qué va en vez
 * de un hueco en blanco.
 */
export function Playground() {
  const providers = useProviders();
  const [selectedRdns, setSelectedRdns] = useState<string | null>(null);

  /**
   * 🇪🇸 NOTA: la preselección se hace en un efecto y no durante el render. Las
   * wallets llegan de forma asíncrona (el anuncio de EIP-6963 puede tardar unos
   * milisegundos), así que en el primer render la lista está vacía y no hay
   * nada que elegir. Elegir durante el render sería además un `setState` en
   * render, que React castiga con un aviso.
   *
   * Se prefiere CodeCrypto si está: es la wallet de este proyecto y la página
   * existe para probarla. Si no, la primera que haya anunciado.
   */
  useEffect(() => {
    if (selectedRdns !== null || providers.length === 0) return;

    const ours = providers.find((entry) => entry.info.rdns === CODECRYPTO_RDNS);
    setSelectedRdns((ours ?? providers[0]).info.rdns);
  }, [providers, selectedRdns]);

  const selected = providers.find((entry) => entry.info.rdns === selectedRdns) ?? null;
  const events = useProviderEvents(selected?.provider ?? null);

  /**
   * 🇪🇸 NOTA: cada `accountsChanged` que llega hace que el panel de conexión
   * relea `eth_accounts`. Es lo que hace visible el modelo por origen: cambias
   * la cuenta de este sitio desde el popup y la página se actualiza sola, sin
   * recargar y sin que la otra dApp se entere de nada.
   */
  const accountsRevision = events.filter((event) => event.name === "accountsChanged").length;

  if (providers.length === 0) {
    return (
      <section className="section">
        <NoWalletsEmptyState onLookAgain={requestProviders} />
      </section>
    );
  }

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

      {selected !== null && (
        <>
          <section className="section">
            <h2 className="section-title">2 · Selected wallet</h2>
            <ProviderCard info={selected.info} />
          </section>

          <section className="section">
            <h2 className="section-title">3 · Connection</h2>
            <p className="section-note">
              <code>eth_requestAccounts</code> asks the wallet for permission. The account
              you approve is bound to <strong>this origin only</strong> — the same wallet
              can be on a different account for a different site, at the same time.
            </p>
            <ConnectPanel provider={selected.provider} accountsRevision={accountsRevision} />
          </section>

          <section className="section">
            <h2 className="section-title">4 · Public methods (no permission required)</h2>
            <p className="section-note">
              These the wallet answers without any approval. Everything else answers{" "}
              <code>4200</code> until the phase that implements it.
            </p>
            <MethodPanel provider={selected.provider} accountsRevision={accountsRevision} />
          </section>

          <section className="section">
            <h2 className="section-title">5 · Provider events</h2>
            <p className="section-note">
              Live <code>accountsChanged</code>, <code>chainChanged</code>,{" "}
              <code>connect</code> and <code>disconnect</code>, wired now so the channel is
              tested before there is anything to send down it.
            </p>
            <EventLog events={events} />
          </section>

          <section className="section">
            <h2 className="section-title">6 · Injection inside an iframe</h2>
            <p className="section-note">
              The extension declares <code>all_frames</code> because plenty of dApps live
              inside an iframe, and a wallet that only injects into the top frame does not
              exist for them. This embeds <code>/frame</code> to check it.
            </p>
            <iframe className="frame-embed" src="/frame" title="Frame injection probe" data-testid="iframe" />
          </section>
        </>
      )}
    </>
  );
}
