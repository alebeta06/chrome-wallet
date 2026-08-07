import { useState } from "react";

import type { Hex, NetworkConfig } from "@/types/messages";
import { callBackground, toRpcError } from "@/ui/rpc";

const WINDOW = { width: 460, height: 720 } as const;

/**
 * Opens the network window. The form lives there and nowhere else.
 *
 * 🇪🇸 NOTA: no es una preferencia de diseño. El spike del GATE 2 midió que
 * `chrome.permissions.request()` desde el popup de la acción mata su contexto —
 * el diálogo aparece, el popup se cierra y el `await` no vuelve—, así que el
 * formulario TIENE que vivir en una ventana `type: "popup"`. Ver la NOTA de
 * `src/ui/network/main.tsx`.
 */
function openNetworkWindow(chainId?: Hex): void {
  const base = chrome.runtime.getURL("network.html");
  const url = chainId === undefined ? base : `${base}?chainId=${encodeURIComponent(chainId)}`;

  void chrome.windows.create({ url, type: "popup", focused: true, ...WINDOW });
}

interface NetworkSelectorProps {
  networks: NetworkConfig[];
  chainId: Hex;
  unusableChainIds: Hex[];
  onChanged(): void;
}

export function NetworkSelector({
  networks,
  chainId,
  unusableChainIds,
  onChanged,
}: NetworkSelectorProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const unusable = new Set(unusableChainIds);
  const active = networks.find((entry) => entry.chainId === chainId);

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (cause) {
      setError(toRpcError(cause).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack" data-testid="network-selector">
      <div className="row row--between">
        <h3>Network</h3>
        <button
          type="button"
          className="button--ghost"
          data-testid="network-add"
          onClick={() => openNetworkWindow()}
        >
          + Add network
        </button>
      </div>

      {/*
        🇪🇸 NOTA: la red activa inalcanzable se avisa ARRIBA y aparte. Es el único
        caso en el que la wallet no puede hacer nada —ni saldos, ni enviar— y el
        banner de saldos por sí solo diría "no se puede alcanzar la red" sin
        explicar que lo que falta es un permiso, que tiene arreglo de un clic.
      */}
      {active !== undefined && unusable.has(active.chainId) && (
        <p className="banner banner--error" data-testid="network-active-unusable">
          The wallet is no longer allowed to reach <strong>{active.name}</strong>. Restore its
          permission to use it again.
        </p>
      )}

      {error !== null && (
        <p className="banner banner--error" data-testid="network-error">
          {error}
        </p>
      )}

      <ul className="network-list" data-testid="network-list">
        {networks.map((network) => {
          const isActive = network.chainId === chainId;
          const isUnusable = unusable.has(network.chainId);

          return (
            <li
              key={network.chainId}
              className={`network-row ${isActive ? "network-row--active" : ""} ${
                isUnusable ? "network-row--unusable" : ""
              }`}
              data-testid={`network-row-${network.chainId}`}
            >
              <button
                type="button"
                className="network-row__pick"
                data-testid={`network-pick-${network.chainId}`}
                disabled={busy || isActive}
                onClick={() =>
                  void run(() =>
                    callBackground("wallet_setActiveNetwork", { chainId: network.chainId }),
                  )
                }
              >
                <span className="network-row__name">{network.name}</span>
                <span className="muted">{network.symbol}</span>
              </button>

              {/*
                🇪🇸 NOTA: la red no usable se ENSEÑA, marcada. Esconderla haría
                creer que desapareció y el usuario iría a añadirla otra vez — que
                es la acción equivocada, porque ya la tiene.
              */}
              {isUnusable && (
                <span className="network-row__chip" data-testid={`network-unusable-${network.chainId}`}>
                  no access
                </span>
              )}

              {/*
                🇪🇸 NOTA: "Restore" abre la MISMA ventana del alta, en modo
                reconcesión y sembrada con los datos guardados. Es literalmente
                el camino `regrant` del bloque D — el que existe porque el atajo
                idempotente lo cerraba— así que no hay callejón: pide el permiso,
                verifica el chainId, y la red vuelve a ser usable.
              */}
              {isUnusable && (
                <button
                  type="button"
                  className="button--ghost"
                  data-testid={`network-restore-${network.chainId}`}
                  onClick={() => openNetworkWindow(network.chainId)}
                >
                  Restore
                </button>
              )}

              {!network.builtIn && (
                <button
                  type="button"
                  className="button--icon"
                  title={`Remove ${network.name}`}
                  data-testid={`network-remove-${network.chainId}`}
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      callBackground("wallet_removeNetwork", { chainId: network.chainId }),
                    )
                  }
                >
                  ✕
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
