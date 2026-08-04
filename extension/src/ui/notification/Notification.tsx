import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ProviderErrors,
  type DecisionMessage,
  type PendingSignatureRequest,
  type RequestId,
} from "@/types/messages";
import { formatEther, shortenAddress } from "@/lib/format";
import { defaultNetworks } from "@/lib/networks";
import { functionSelector, isContractCall, type ParsedTransaction } from "@/lib/tx";
import { callBackground, toRpcError } from "@/ui/rpc";
import { useApprovalPort } from "@/ui/connect/useApprovalPort";

function readRequestId(): RequestId | null {
  const value = new URLSearchParams(window.location.search).get("requestId");
  return value !== null && value.length > 0 ? value : null;
}

type Phase =
  | { status: "loading" }
  | { status: "ready"; request: PendingSignatureRequest }
  | { status: "gone"; message: string }
  | { status: "deciding" };

export function Notification() {
  const requestId = useMemo(readRequestId, []);
  const [phase, setPhase] = useState<Phase>({ status: "loading" });

  // Same hook as connect.html: keeps the worker alive and reports the X.
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

        if (request === null || request.kind !== "signature") {
          setPhase({
            status: "gone",
            message: "This request is no longer waiting. It may have timed out.",
          });
          return;
        }

        setPhase({ status: "ready", request });
      } catch (cause) {
        if (!cancelled) setPhase({ status: "gone", message: toRpcError(cause).message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [requestId]);

  /**
   * 🇪🇸 NOTA: se manda la decisión y la ventana NO se cierra a sí misma — la
   * cierra el background después de resolver. Si se cerrara aquí, el
   * `onDisconnect` del puerto podría llegar antes que la decisión y un 4001
   * pisaría la aprobación.
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
        <p className="muted" data-testid="sign-loading">
          Loading…
        </p>
      </main>
    );
  }

  if (phase.status === "gone") {
    return (
      <main className="approval">
        <p className="banner banner--error" data-testid="sign-expired">
          {phase.message}
        </p>
        <button
          type="button"
          className="button--ghost"
          data-testid="sign-close"
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
        <p className="muted" data-testid="sign-deciding">
          Sending…
        </p>
      </main>
    );
  }

  return (
    <SignPrompt
      request={phase.request}
      onApprove={() =>
        decide({
          type: "CODECRYPTO_DECISION",
          requestId: phase.request.id,
          kind: "signature",
          approved: true,
        })
      }
      onReject={() =>
        decide({
          type: "CODECRYPTO_DECISION",
          requestId: phase.request.id,
          kind: "signature",
          approved: false,
          error: ProviderErrors.userRejected(),
        })
      }
    />
  );
}

interface PromptProps {
  request: PendingSignatureRequest;
  onApprove(): void;
  onReject(): void;
}

/** Wei * gas, as a hex-free ETH string. Returns null when either is unknown. */
function maxCost(transaction: ParsedTransaction): string | null {
  if (transaction.gas === undefined || transaction.maxFeePerGas === undefined) return null;

  const fee = BigInt(transaction.gas) * BigInt(transaction.maxFeePerGas);
  return formatEther(`0x${(fee + BigInt(transaction.value)).toString(16)}`);
}

function SignPrompt({ request, onApprove, onReject }: PromptProps) {
  const [showData, setShowData] = useState(false);

  /**
   * 🇪🇸 NOTA: el background guarda la transacción YA PARSEADA en `params[0]`, con
   * el `from` resuelto contra el permiso del origen. Esta ventana no vuelve a
   * mirar lo que dijo la dApp: enseña lo que se va a firmar.
   */
  const transaction = request.params[0] as ParsedTransaction;
  const network = defaultNetworks().find((entry) => entry.chainId === request.chainId);
  const contractCall = isContractCall(transaction);
  const total = maxCost(transaction);

  return (
    <main className="approval" data-testid="sign-prompt">
      <header className="approval__header">
        <p className="approval__eyebrow">A site wants you to sign</p>
        <p className="approval__origin" data-testid="sign-origin">
          {request.origin}
        </p>
      </header>

      {/*
        🇪🇸 NOTA: el aviso de llamada a contrato va ARRIBA del todo y en rojo, no
        como una fila más de la tabla. Una transferencia de ETH y una llamada a
        contrato se ven idénticas si solo enseñas destino y cantidad — y el caso
        peligroso es justo el que parece inofensivo: `value: 0` tranquiliza
        mientras el `data` aprueba a un tercero a vaciarte un token.

        Decir "no puedo saber qué hace" es más honesto que callarlo. La wallet no
        tiene el ABI del contrato y fingir que lo entiende sería peor.
      */}
      {contractCall && (
        <p className="banner banner--error" data-testid="sign-contract-warning">
          <strong>This is a contract call, not a plain transfer.</strong> This wallet cannot
          tell you what it will do. Only approve it if you trust {request.origin}.
        </p>
      )}

      <dl className="detail-list">
        <div className="detail-row">
          <dt>From</dt>
          <dd className="mono" data-testid="sign-from" title={transaction.from}>
            {shortenAddress(transaction.from)}
          </dd>
        </div>

        <div className="detail-row">
          <dt>To</dt>
          <dd className="mono" data-testid="sign-to" title={transaction.to}>
            {shortenAddress(transaction.to)}
          </dd>
        </div>

        <div className="detail-row">
          <dt>Amount</dt>
          {/*
            🇪🇸 NOTA: en ETH, nunca en wei ni en hex. "0xde0b6b3a7640000" no es
            una cantidad que nadie pueda juzgar antes de aprobar.
          */}
          <dd className="detail-value" data-testid="sign-value">
            {formatEther(transaction.value)} {network?.symbol ?? "ETH"}
          </dd>
        </div>

        <div className="detail-row">
          <dt>Network</dt>
          <dd data-testid="sign-network">
            {network?.name ?? request.chainId}
          </dd>
        </div>

        <div className="detail-row">
          <dt>Gas</dt>
          <dd className="mono" data-testid="sign-gas">
            {transaction.gas === undefined ? "—" : BigInt(transaction.gas).toString()}
          </dd>
        </div>

        <div className="detail-row">
          <dt>Max total</dt>
          <dd className="mono" data-testid="sign-max-cost">
            {total === null ? "—" : `${total} ${network?.symbol ?? "ETH"}`}
          </dd>
        </div>
      </dl>

      {/*
        🇪🇸 NOTA: si no se pudo estimar se DICE, y el botón de aprobar sigue
        activo. Mismo criterio que los saldos en connect.html: un problema de red
        no puede convertirse en "la wallet no deja operar". Si fue un parpadeo
        del nodo, el envío funciona igual; si no, la dApp recibe un 4901 y se
        entera de la causa real.
      */}
      {total === null && (
        <p className="banner banner--warn" data-testid="sign-fee-warning">
          The network fee could not be estimated — the node did not answer. You can still
          approve; the wallet will price it when it sends.
        </p>
      )}

      {contractCall && (
        <div className="calldata" data-testid="sign-calldata">
          <div className="row row--between">
            <span className="muted">
              Data{" "}
              {functionSelector(transaction) !== null && (
                <code data-testid="sign-selector">{functionSelector(transaction)}</code>
              )}
            </span>
            <button
              type="button"
              className="button--icon"
              data-testid="sign-toggle-data"
              onClick={() => setShowData((current) => !current)}
            >
              {showData ? "hide" : "show all"}
            </button>
          </div>
          <pre className="calldata__body">
            {showData ? transaction.data : `${transaction.data.slice(0, 34)}…`}
          </pre>
        </div>
      )}

      <div className="approval__actions">
        <button
          type="button"
          className="button--ghost"
          data-testid="sign-reject"
          onClick={onReject}
        >
          Reject
        </button>
        <button
          type="button"
          className="button--primary"
          data-testid="sign-approve"
          onClick={onApprove}
        >
          Approve
        </button>
      </div>
    </main>
  );
}
