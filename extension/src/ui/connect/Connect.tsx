import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ProviderErrors,
  type DecisionMessage,
  type PendingConnectRequest,
  type RequestId,
} from "@/types/messages";
import { formatEther, shortenAddress } from "@/lib/format";
import { callBackground, toRpcError } from "@/ui/rpc";
import { useBalances } from "@/ui/hooks/useBalances";
import { useApprovalPort } from "./useApprovalPort";

/**
 * 🇪🇸 NOTA: el requestId viaja en la query de la URL porque es lo único que el
 * background puede pasarle a una ventana que abre con `chrome.windows.create`.
 * No es un secreto: quien puede leer esta URL es esta misma ventana.
 */
function readRequestId(): RequestId | null {
  const value = new URLSearchParams(window.location.search).get("requestId");
  return value !== null && value.length > 0 ? value : null;
}

type Phase =
  | { status: "loading" }
  | { status: "ready"; request: PendingConnectRequest }
  | { status: "gone"; message: string }
  | { status: "deciding" };

export function Connect() {
  const requestId = useMemo(readRequestId, []);
  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const [selected, setSelected] = useState<number | null>(null);

  // Opened first thing and held until the window dies. See the hook.
  useApprovalPort(requestId);

  useEffect(() => {
    if (requestId === null) {
      setPhase({ status: "gone", message: "This window was opened without a request." });
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const request = await callBackground("wallet_getPendingRequest", { requestId });
        if (cancelled) return;

        /**
         * 🇪🇸 NOTA: `null` aquí significa que la solicitud caducó o ya se
         * resolvió. Hay que decirlo en vez de enseñar una pantalla vacía: el
         * usuario ve una ventana abierta y necesita saber que ya no sirve de
         * nada aprobar en ella.
         */
        if (request === null || request.kind !== "connect") {
          setPhase({
            status: "gone",
            message: "This request is no longer waiting. It may have timed out.",
          });
          return;
        }

        setPhase({ status: "ready", request });
        setSelected(request.suggestedAccountIndex);
      } catch (cause) {
        if (!cancelled) setPhase({ status: "gone", message: toRpcError(cause).message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [requestId]);

  /**
   * 🇪🇸 NOTA: la ventana manda la decisión y NO se cierra a sí misma. La cierra
   * el background, después de resolver. Si se cerrara aquí, el `onDisconnect`
   * del puerto podría llegar ANTES que la decisión y un 4001 pisaría la
   * aprobación — aprobar y cancelar serían indistinguibles.
   */
  const decide = useCallback((decision: DecisionMessage) => {
    setPhase({ status: "deciding" });
    void chrome.runtime.sendMessage(decision).catch((cause: unknown) => {
      console.error("[codecrypto] could not deliver the decision:", cause);
    });
  }, []);

  if (phase.status === "loading") {
    return (
      <main className="approval">
        <p className="muted" data-testid="connect-loading">
          Loading…
        </p>
      </main>
    );
  }

  if (phase.status === "gone") {
    return (
      <main className="approval">
        <p className="banner banner--error" data-testid="connect-expired">
          {phase.message}
        </p>
        <button
          type="button"
          className="button--ghost"
          data-testid="connect-close"
          onClick={() => window.close()}
        >
          Close
        </button>
      </main>
    );
  }

  if (phase.status === "deciding") {
    return (
      <main className="approval">
        <p className="muted" data-testid="connect-deciding">
          Finishing…
        </p>
      </main>
    );
  }

  return (
    <ConnectPrompt
      request={phase.request}
      selected={selected ?? phase.request.suggestedAccountIndex}
      onSelect={setSelected}
      onApprove={(accountIndex) =>
        decide({
          type: "CODECRYPTO_DECISION",
          requestId: phase.request.id,
          kind: "connect",
          approved: true,
          accountIndex,
        })
      }
      onReject={() =>
        decide({
          type: "CODECRYPTO_DECISION",
          requestId: phase.request.id,
          kind: "connect",
          approved: false,
          error: ProviderErrors.userRejected(),
        })
      }
    />
  );
}

interface PromptProps {
  request: PendingConnectRequest;
  selected: number;
  onSelect(index: number): void;
  onApprove(accountIndex: number): void;
  onReject(): void;
}

function ConnectPrompt({ request, selected, onSelect, onApprove, onReject }: PromptProps) {
  const { balances, error: balanceError } = useBalances(request.accounts);

  return (
    <main className="approval" data-testid="connect-prompt">
      <header className="approval__header">
        <p className="approval__eyebrow">A site wants to connect</p>
        {/*
          🇪🇸 NOTA: el origen es lo PRIMERO y lo más grande de la ventana, y va en
          monoespaciada. El usuario está a punto de dar acceso a un sitio
          concreto, así que la pregunta que tiene que poder contestar de un
          vistazo es "¿de dónde viene esto?". Un dominio parecido al que espera
          es la forma más barata de phishing que hay, y enterrarlo en letra
          pequeña debajo de un logo bonito es exactamente cómo funciona.
        */}
        <p className="approval__origin" data-testid="connect-origin">
          {request.origin}
        </p>
      </header>

      <p className="approval__ask">
        Choose the account this site will see. It will not see your other accounts.
      </p>

      {/*
        🇪🇸 NOTA: sin saldos se avisa y se sigue. Conectar no depende de poder
        leer la cadena, y bloquear la conexión porque el nodo no responde
        convertiría un problema de red en "la wallet no funciona".
      */}
      {balanceError !== null && (
        <p className="banner banner--warn" data-testid="connect-balance-warning">
          Balances are unavailable right now. You can still connect.
        </p>
      )}

      <ul className="account-list" data-testid="connect-account-list">
        {request.accounts.map((address, index) => (
          <li key={address}>
            <button
              type="button"
              className={`account-row ${index === selected ? "account-row--selected" : ""}`}
              aria-pressed={index === selected}
              data-testid={`connect-account-${index}`}
              onClick={() => onSelect(index)}
            >
              <span className="account-row__address">{shortenAddress(address)}</span>
              <span className="account-row__balance">
                {balances[address] === undefined ? "—" : `${formatEther(balances[address])} ETH`}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="approval__actions">
        <button
          type="button"
          className="button--ghost"
          data-testid="connect-reject"
          onClick={onReject}
        >
          Reject
        </button>
        <button
          type="button"
          className="button--primary"
          data-testid="connect-approve"
          onClick={() => onApprove(selected)}
        >
          Connect
        </button>
      </div>
    </main>
  );
}
