import { useCallback, useEffect, useState } from "react";

import type { NetworkConfig, PendingAddChainRequest } from "@/types/messages";
import { originPatternFromRpcUrl } from "@/lib/permissions";
import { callBackground } from "@/ui/rpc";

/**
 * What the user is really being asked. Derived, not carried in the request.
 *
 * 🇪🇸 NOTA: los tres casos abren la misma ventana y persisten la misma
 * solicitud. Cuál es se deduce aquí comparando con `wallet_getState`, que ya
 * dice si la red existe, con qué RPC, y si su permiso falta. Meter un campo en
 * el contrato para algo que se puede derivar de lo que ya viaja sería añadirle
 * una obligación al ABI del proyecto a cambio de nada.
 */
type Intent = "add" | "overwrite" | "regrant";

interface Copy {
  eyebrow: string;
  action: string;
  warning: string | null;
}

const COPY: Record<Intent, Copy> = {
  add: {
    eyebrow: "A site wants to add a network",
    action: "Add network",
    warning: null,
  },
  overwrite: {
    eyebrow: "A site wants to CHANGE a network you already have",
    action: "Replace endpoint",
    /**
     * 🇪🇸 NOTA: éste es el caso peligroso y por eso es el único con banner rojo.
     * Reapuntar una red que ya usas a otro nodo no cambia nada visible: mismo
     * nombre, mismo símbolo, mismo chainId en el selector. Lo que cambia es
     * quién te dice tu saldo y por dónde salen tus transacciones.
     */
    warning:
      "You already have this network. Approving replaces the node it talks to — the same " +
      "network name, a different server deciding what you see and relaying what you send.",
  },
  regrant: {
    eyebrow: "A site wants to restore access to a network",
    action: "Restore access",
    warning: null,
  },
};

interface AddChainPromptProps {
  request: PendingAddChainRequest;
  onApprove(): void;
  onReject(reason: string): void;
}

export function AddChainPrompt({ request, onApprove, onReject }: AddChainPromptProps) {
  const chain = request.chain;
  const rpcUrl = chain.rpcUrls[0] ?? "";
  const explorer = chain.blockExplorerUrls?.[0] ?? null;

  const [intent, setIntent] = useState<Intent>("add");
  const [existing, setExisting] = useState<NetworkConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const snapshot = await callBackground("wallet_getState");
        if (cancelled) return;

        const known = snapshot.networks.find((entry) => entry.chainId === chain.chainId) ?? null;
        setExisting(known);

        if (known === null) setIntent("add");
        else if (known.rpcUrl !== rpcUrl) setIntent("overwrite");
        else setIntent("regrant");
      } catch {
        // The window still works: "add" is the safest thing to claim, because
        // it promises the least about what already exists.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chain.chainId, rpcUrl]);

  /**
   * ------------------------------------------------------------------------
   * THE PERMISSION IS REQUESTED HERE, FROM THE CLICK
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: `chrome.permissions.request()` exige un gesto de usuario, así que
   * NO puede vivir en el service worker. Tiene que salir de un `onClick`, y de
   * uno que esté en una ventana que Chrome acepte como contexto de gesto.
   *
   * Que ésta lo sea está MEDIDO, no supuesto: el spike del GATE 2 comprobó que
   * una ventana `chrome.windows.create({type:'popup'})` sirve, y que el popup de
   * la acción NO — ahí el diálogo mata el contexto y el `await` no vuelve nunca.
   * Por eso el formulario de alta manual del popup abre su propia ventana en vez
   * de pedir el permiso donde está.
   *
   * Denegar es un 4001 y no un error: el usuario dijo que no, igual que si
   * hubiera pulsado Reject. La dApp no tiene por qué distinguir en cuál de las
   * dos pantallas dijo que no.
   */
  const approve = useCallback(async () => {
    const pattern = originPatternFromRpcUrl(rpcUrl);

    if (pattern === null) {
      // The background validated this already; reaching here means the two
      // disagree, and approving would ask Chrome for a pattern it will refuse.
      setError("This RPC endpoint cannot be used by the wallet.");
      return;
    }

    setBusy(true);
    setError(null);

    let granted: boolean;
    try {
      granted = await chrome.permissions.request({ origins: [pattern] });
    } catch (cause) {
      console.error("[codecrypto] the permission request failed:", cause);
      setBusy(false);
      setError("Chrome refused to ask for permission to reach that endpoint.");
      return;
    }

    if (!granted) {
      onReject("Permission to reach that RPC endpoint was denied.");
      return;
    }

    onApprove();
  }, [rpcUrl, onApprove, onReject]);

  const copy = COPY[intent];

  return (
    <main className="approval" data-testid="add-chain-prompt">
      <header className="approval__header">
        <p className="approval__eyebrow" data-testid="add-chain-intent">
          {copy.eyebrow}
        </p>
        <p className="approval__origin" data-testid="add-chain-origin">
          {request.origin}
        </p>
      </header>

      {copy.warning !== null && (
        <p className="banner banner--error" data-testid="add-chain-overwrite-warning">
          <strong>{copy.warning}</strong>
        </p>
      )}

      <dl className="detail-list">
        <div className="detail-row">
          <dt>Network</dt>
          <dd data-testid="add-chain-name">{chain.chainName}</dd>
        </div>

        <div className="detail-row">
          <dt>Chain ID</dt>
          <dd className="mono" data-testid="add-chain-id">
            {chain.chainId} ({BigInt(chain.chainId).toString()})
          </dd>
        </div>

        {/*
          🇪🇸 NOTA: la URL entera y sin acortar, y en `mono`. Es el dato que el
          usuario tiene que poder juzgar: un `polygon-rpc.com` y un
          `polygon-rpc.com.evil.io` se distinguen por el final, que es justo lo
          que se pierde al truncar. Aquí no se acorta nada.
        */}
        <div className="detail-row">
          <dt>RPC endpoint</dt>
          <dd className="mono" data-testid="add-chain-rpc">
            {rpcUrl}
          </dd>
        </div>

        {intent === "overwrite" && existing !== null && (
          <div className="detail-row">
            <dt>Replacing</dt>
            <dd className="mono" data-testid="add-chain-previous-rpc">
              {existing.rpcUrl}
            </dd>
          </div>
        )}

        <div className="detail-row">
          <dt>Currency</dt>
          <dd data-testid="add-chain-currency">
            {chain.nativeCurrency.symbol} ({chain.nativeCurrency.decimals} decimals)
          </dd>
        </div>

        {explorer !== null && (
          <div className="detail-row">
            <dt>Explorer</dt>
            <dd className="mono" data-testid="add-chain-explorer">
              {explorer}
            </dd>
          </div>
        )}
      </dl>

      {/*
        🇪🇸 NOTA: se avisa de que Chrome va a preguntar aparte. Sin esto, el
        diálogo nativo aparece encima de la ventana de la wallet sin explicación
        y parece otra cosa — y un diálogo de permisos que sorprende es un
        diálogo que se acepta sin leer.
      */}
      <p className="muted" data-testid="add-chain-permission-hint">
        Chrome will ask separately for permission to reach that endpoint. The wallet then checks
        that the endpoint really serves chain {chain.chainId} before saving anything.
      </p>

      {error !== null && (
        <p className="banner banner--error" data-testid="add-chain-error">
          {error}
        </p>
      )}

      <div className="approval__actions">
        <button
          type="button"
          className="button--ghost"
          data-testid="add-chain-reject"
          disabled={busy}
          onClick={() => onReject("User rejected the request.")}
        >
          Reject
        </button>
        <button
          type="button"
          className="button--primary"
          data-testid="add-chain-approve"
          disabled={busy}
          onClick={() => void approve()}
        >
          {busy ? "Waiting for Chrome…" : copy.action}
        </button>
      </div>
    </main>
  );
}
