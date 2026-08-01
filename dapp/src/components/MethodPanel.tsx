"use client";

import { useState } from "react";

import { describeProviderError, type DisplayError } from "@/lib/errors";
import { formatEther, isHexQuantity, looksLikeAddress } from "@/lib/format";
import { describeChain } from "@/lib/networks";
import type { EIP1193Provider } from "@/types/eip1193";

/** Anvil's first dev account. A sensible default that always has a balance. */
const ANVIL_FIRST = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

interface Result {
  method: string;
  label: string;
  value: string;
  raw: unknown;
}

type CallState =
  | { status: "idle" }
  | { status: "pending"; method: string }
  | { status: "ok"; result: Result }
  | { status: "error"; method: string; error: DisplayError };

interface Props {
  provider: EIP1193Provider;
}

export function MethodPanel({ provider }: Props) {
  const [state, setState] = useState<CallState>({ status: "idle" });
  const [address, setAddress] = useState(ANVIL_FIRST);

  const addressIsValid = looksLikeAddress(address);
  const busy = state.status === "pending";

  async function call(method: string, params: unknown[], present: (raw: unknown) => Omit<Result, "method" | "raw">) {
    setState({ status: "pending", method });

    try {
      const raw = await provider.request({ method, params });
      setState({ status: "ok", result: { method, raw, ...present(raw) } });
    } catch (cause) {
      /**
       * 🇪🇸 NOTA: se captura `unknown` y lo interpreta `describeProviderError`.
       * Una dApp no puede dar por hecho que toda wallet rechaza con un Error
       * bien formado; lo único que el estándar garantiza es el `code` numérico.
       */
      setState({ status: "error", method, error: describeProviderError(cause) });
    }
  }

  return (
    <div data-testid="method-panel">
      <div className="row">
        <button
          type="button"
          className="action"
          disabled={busy}
          data-testid="btn-chainid"
          onClick={() =>
            call("eth_chainId", [], (raw) => {
              const chain = describeChain(raw);
              return {
                label: "Active network",
                value: chain.decimal === null
                  ? chain.chainId
                  : `${chain.name} · ${chain.decimal} · ${chain.chainId}`,
              };
            })
          }
        >
          eth_chainId
        </button>

        <button
          type="button"
          className="action"
          disabled={busy}
          data-testid="btn-accounts"
          onClick={() =>
            call("eth_accounts", [], (raw) => {
              const accounts = Array.isArray(raw) ? raw : [];
              return {
                label: "Exposed accounts",
                value: accounts.length === 0 ? "[]  (none — see below)" : accounts.join("\n"),
              };
            })
          }
        >
          eth_accounts
        </button>

        <button
          type="button"
          className="action"
          disabled={busy}
          data-testid="btn-request-accounts"
          onClick={() => call("eth_requestAccounts", [], () => ({ label: "Accounts", value: "" }))}
        >
          eth_requestAccounts
        </button>
      </div>

      <div className="row" style={{ marginTop: "var(--space-3)" }}>
        <input
          className="field"
          value={address}
          spellCheck={false}
          aria-label="Address to read the balance of"
          aria-invalid={!addressIsValid}
          data-testid="input-address"
          onChange={(event) => setAddress(event.target.value)}
        />
        <button
          type="button"
          className="action"
          disabled={busy || !addressIsValid}
          data-testid="btn-balance"
          onClick={() =>
            call("eth_getBalance", [address.trim(), "latest"], (raw) => ({
              label: "Balance",
              /**
               * 🇪🇸 NOTA: se comprueba la forma antes de convertir. `BigInt()`
               * sobre algo que no es una cantidad hex lanza un SyntaxError que
               * no tiene nada que ver con el provider, y acabaría mostrado como
               * si fuera un error de la wallet.
               */
              value: isHexQuantity(raw) ? `${formatEther(raw)} ETH` : String(raw),
            }))
          }
        >
          eth_getBalance
        </button>
      </div>

      {!addressIsValid && (
        <p className="muted" style={{ fontSize: 13, margin: "var(--space-2) 0 0" }}>
          That is not a 20-byte hex address, so there is nothing worth asking the wallet.
        </p>
      )}

      <Output state={state} />

      <div className="callout" data-testid="accounts-explainer">
        <strong>Why eth_accounts answers []</strong> — this origin has not been granted
        permission, and an unconnected site gets an empty array by design. Returning the
        active account would turn the wallet into a fingerprint: any page you visit would
        learn a permanent identifier with your whole transaction history attached, without
        a prompt and without you noticing. Accounts arrive behind{" "}
        <code>eth_requestAccounts</code> and an approval window — which is why that button
        answers <code>4200</code> today.
      </div>

      <div className="row" style={{ marginTop: "var(--space-4)" }}>
        <button type="button" className="action primary" disabled data-testid="btn-connect">
          Connect wallet
        </button>
        <span className="muted" style={{ fontSize: 13 }}>
          Disabled until phase 5, which adds per-origin permissions and the approval window.
        </span>
      </div>
    </div>
  );
}

function Output({ state }: { state: CallState }) {
  if (state.status === "idle") {
    return (
      <pre className="output muted" data-testid="output">
        No call yet.
      </pre>
    );
  }

  if (state.status === "pending") {
    return (
      <pre className="output muted" data-testid="output">
        {state.method}…
      </pre>
    );
  }

  if (state.status === "error") {
    return (
      <pre className="output" data-testid="output">
        <span className="output-label">{state.method}</span>
        <span className="bad output-value">{state.error.title}</span>
        {"\n"}
        <span className="error-code">
          {state.error.code === null ? "no error code" : `code ${state.error.code}`} ·{" "}
          {state.error.detail}
        </span>
      </pre>
    );
  }

  return (
    <pre className="output" data-testid="output">
      <span className="output-label">
        {state.result.method} · {state.result.label}
      </span>
      <span className="ok output-value">{state.result.value}</span>
      {"\n"}
      <span className="error-code">raw: {JSON.stringify(state.result.raw)}</span>
    </pre>
  );
}
