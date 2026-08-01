"use client";

const REPO_README = "https://github.com/alebeta06/chrome-wallet#instalar-la-extensión";

interface Props {
  onLookAgain: () => void;
}

/**
 * What the page shows when no wallet announced itself.
 *
 * 🇪🇸 NOTA: éste es el estado que decide si la página parece rota o parece
 * terminada. Sin wallet, una dApp mal hecha se queda en blanco o revienta con
 * un `cannot read property of undefined` — y quien la abre no sabe si le falta
 * algo a él o a la web. Aquí se dice exactamente qué falta y qué hacer.
 *
 * También cubre el caso real de que la extensión esté instalada pero la página
 * se abriera antes de que el content script inyectara el provider: por eso el
 * botón de volver a preguntar, que redispara `eip6963:requestProvider`.
 */
export function NoWalletsEmptyState({ onLookAgain }: Props) {
  return (
    <div className="empty" data-testid="empty-state">
      <h2>No wallet announced itself</h2>
      <p>
        This page discovers wallets through EIP-6963 — it never reads{" "}
        <code>window.codecrypto</code> or <code>window.ethereum</code> directly. Nothing
        answered the announcement request, so either no wallet extension is installed or
        it has not injected its provider into this tab yet.
      </p>

      <ol>
        <li>
          Build the extension: <code>cd extension &amp;&amp; pnpm build</code>
        </li>
        <li>
          Open <code>chrome://extensions</code>, enable Developer mode
        </li>
        <li>
          <strong>Load unpacked</strong> → pick <code>extension/dist/</code>
        </li>
        <li>Reload this page</li>
      </ol>

      <div className="row" style={{ justifyContent: "center" }}>
        <button
          type="button"
          className="action primary"
          data-testid="btn-look-again"
          onClick={onLookAgain}
        >
          Look again
        </button>
        <a className="action" href={REPO_README} target="_blank" rel="noreferrer">
          Full instructions
        </a>
      </div>
    </div>
  );
}
