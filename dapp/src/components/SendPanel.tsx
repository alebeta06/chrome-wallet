"use client";

import { useState } from "react";

import { describeProviderError, isUserRejection, type DisplayError } from "@/lib/errors";
import { looksLikeAddress, toWeiHex } from "@/lib/format";
import { explorerTxUrl } from "@/lib/networks";
import type { EIP1193Provider } from "@/types/eip1193";

/** Anvil's second dev account: somewhere to send to that always exists. */
const ANVIL_SECOND = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

interface Props {
  provider: EIP1193Provider;
  /** The account this origin is connected with, or null when it is not. */
  account: string | null;
  chainId: string | null;
}

type SendState =
  | { status: "idle" }
  | { status: "waiting" }
  | { status: "sent"; hash: string }
  | { status: "failed"; error: DisplayError };

export function SendPanel({ provider, account, chainId }: Props) {
  const [to, setTo] = useState(ANVIL_SECOND);
  const [amount, setAmount] = useState("1");
  const [state, setState] = useState<SendState>({ status: "idle" });

  const value = toWeiHex(amount);
  const toIsValid = looksLikeAddress(to);
  const amountIsValid = value !== null;
  const canSend = account !== null && toIsValid && amountIsValid && state.status !== "waiting";

  async function send(): Promise<void> {
    if (account === null || value === null) return;

    setState({ status: "waiting" });

    try {
      const hash = await provider.request({
        method: "eth_sendTransaction",
        params: [{ from: account, to: to.trim(), value }],
      });
      setState({ status: "sent", hash: String(hash) });
    } catch (cause) {
      /**
       * 🇪🇸 NOTA: rechazar no es un fallo. El usuario pulsó "Reject" y la wallet
       * hizo lo que le pidió — se vuelve al formulario y no se dice nada.
       *
       * Y lo importante: un fallo DESPUÉS de aprobar sí se enseña, porque no es
       * lo mismo. La wallet devuelve códigos distintos justo para que esta dApp
       * pueda distinguir "cancelaste" de "te faltan fondos", y confundirlos sería
       * decirle al usuario que canceló algo que sí aprobó.
       */
      if (isUserRejection(cause)) {
        setState({ status: "idle" });
        return;
      }
      setState({ status: "failed", error: describeProviderError(cause) });
    }
  }

  if (account === null) {
    return (
      <p className="muted" style={{ fontSize: 13 }} data-testid="send-disconnected">
        Connect the wallet first. A site that is not connected gets <code>4100</code> here,
        and no approval window opens.
      </p>
    );
  }

  const explorer = state.status === "sent" ? explorerTxUrl(chainId, state.hash) : null;

  return (
    <div data-testid="send-panel">
      <div className="row">
        <input
          className="field"
          value={to}
          spellCheck={false}
          aria-label="Destination address"
          aria-invalid={!toIsValid}
          data-testid="input-to"
          onChange={(event) => setTo(event.target.value)}
        />
        <input
          className="field"
          style={{ flex: "0 1 140px" }}
          value={amount}
          spellCheck={false}
          aria-label="Amount in ETH"
          aria-invalid={!amountIsValid}
          data-testid="input-amount"
          onChange={(event) => setAmount(event.target.value)}
        />
        <span className="muted">ETH</span>
        <button
          type="button"
          className="action primary"
          disabled={!canSend}
          data-testid="btn-send"
          onClick={() => void send()}
        >
          {state.status === "waiting" ? "Waiting for approval…" : "Send transaction"}
        </button>
      </div>

      {!toIsValid && (
        <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          That is not a 20-byte hex address.
        </p>
      )}
      {!amountIsValid && (
        <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          Enter an amount in ETH, like <code>0.5</code>.
        </p>
      )}

      {state.status === "sent" && (
        <p className="output ok" data-testid="send-result">
          <span className="output-label">Transaction sent</span>
          <span className="mono">{state.hash}</span>
          {explorer !== null && (
            <>
              {"\n"}
              <a href={explorer} target="_blank" rel="noreferrer" data-testid="send-explorer">
                View on the block explorer →
              </a>
            </>
          )}
        </p>
      )}

      {state.status === "failed" && (
        <p className="output bad" data-testid="send-error">
          <span className="output-label">The transaction was not sent</span>
          {state.error.title}
          {"\n"}
          <span className="error-code">
            {state.error.code === null ? "" : `code ${state.error.code} · `}
            {state.error.detail}
          </span>
        </p>
      )}
    </div>
  );
}
