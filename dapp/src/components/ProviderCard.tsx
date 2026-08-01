"use client";

import type { EIP6963ProviderInfo } from "@/types/eip1193";

interface Props {
  info: EIP6963ProviderInfo;
}

/**
 * The identity of the selected wallet, uuid included.
 *
 * 🇪🇸 NOTA: el uuid se muestra a propósito, aunque a un usuario no le diga
 * nada. Es el único sitio donde se puede comprobar a ojo que EIP-6963 está bien
 * implementado: tiene que ser el MISMO después de recargar la página. Uno nuevo
 * en cada carga significa que la wallet lo genera al vuelo, y entonces un
 * selector multi-wallet acumula entradas duplicadas de la misma extensión.
 */
export function ProviderCard({ info }: Props) {
  return (
    <div className="card" data-testid="provider-card">
      <div className="row" style={{ gap: "var(--space-3)", flexWrap: "nowrap" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- data URI from the announcement */}
        <img className="wallet-icon" src={info.icon} alt="" />
        <div className="wallet-meta">
          <div className="wallet-name" data-testid="selected-name">
            {info.name}
          </div>
          <div className="wallet-rdns" data-testid="selected-rdns">
            {info.rdns}
          </div>
          <div className="wallet-uuid" data-testid="selected-uuid">
            uuid {info.uuid}
          </div>
        </div>
      </div>
    </div>
  );
}
