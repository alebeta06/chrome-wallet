"use client";

import { CODECRYPTO_RDNS, type EIP6963ProviderDetail } from "@/types/eip1193";

interface Props {
  providers: EIP6963ProviderDetail[];
  selectedRdns: string | null;
  onSelect: (rdns: string) => void;
  onLookAgain: () => void;
}

/**
 * Lists every announced wallet and lets the user pick one.
 *
 * 🇪🇸 NOTA: se listan TODAS, no solo CodeCrypto. Filtrar las demás sería
 * cómodo para la demo y falso como dApp: lo que EIP-6963 resuelve es
 * precisamente que varias wallets convivan sin pelearse por `window.ethereum`,
 * y una página que solo enseña la suya no demuestra nada de eso.
 *
 * El icono va en un <img> con el data URI tal cual llega en el anuncio. Si
 * estuviera mal formado se vería roto — que es exactamente lo que se quiere
 * ver, y en la misma pantalla donde un usuario elegiría wallet.
 */
export function WalletPicker({ providers, selectedRdns, onSelect, onLookAgain }: Props) {
  return (
    <div data-testid="wallet-picker">
      <div className="grid grid-2">
        {providers.map((entry) => {
          const isOurs = entry.info.rdns === CODECRYPTO_RDNS;

          return (
            <button
              key={entry.info.rdns}
              type="button"
              className="wallet-card"
              aria-pressed={entry.info.rdns === selectedRdns}
              data-testid={`wallet-${entry.info.rdns}`}
              onClick={() => onSelect(entry.info.rdns)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- data URI from the announcement, nothing to optimise */}
              <img className="wallet-icon" src={entry.info.icon} alt="" />
              <span className="wallet-meta">
                <span className="wallet-name">
                  {entry.info.name}
                  {isOurs && <span className="badge">this project</span>}
                </span>
                <span className="wallet-rdns" style={{ display: "block" }}>
                  {entry.info.rdns}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="row" style={{ marginTop: "var(--space-3)" }}>
        <button
          type="button"
          className="action"
          data-testid="btn-look-again"
          onClick={onLookAgain}
        >
          Re-dispatch eip6963:requestProvider
        </button>
        <span className="muted" data-testid="wallet-count">
          {providers.length} wallet{providers.length === 1 ? "" : "s"} announced
        </span>
      </div>
    </div>
  );
}
