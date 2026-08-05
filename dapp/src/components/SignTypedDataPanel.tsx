"use client";

import { useState } from "react";
import { verifyTypedData } from "ethers";

import { describeProviderError, isUserRejection, type DisplayError } from "@/lib/errors";
import { shortenAddress } from "@/lib/format";
import { DEFAULT_EXAMPLE, TYPED_DATA_EXAMPLES } from "@/lib/typed-data-examples";
import type { EIP1193Provider } from "@/types/eip1193";

interface Props {
  provider: EIP1193Provider;
  account: string | null;
}

interface Verified {
  signature: string;
  /** Who actually signed, recovered from the signature alone. */
  recovered: string;
  expected: string;
  matches: boolean;
}

type SignState =
  | { status: "idle" }
  | { status: "waiting" }
  | { status: "signed"; result: Verified }
  | { status: "failed"; error: DisplayError }
  | { status: "invalid"; message: string };

export function SignTypedDataPanel({ provider, account }: Props) {
  const [json, setJson] = useState(DEFAULT_EXAMPLE.json);
  const [state, setState] = useState<SignState>({ status: "idle" });

  async function sign(): Promise<void> {
    if (account === null) return;

    let payload: { domain: unknown; types: Record<string, unknown>; message: unknown };
    try {
      payload = JSON.parse(json);
    } catch (cause) {
      setState({
        status: "invalid",
        message: cause instanceof Error ? cause.message : "That is not valid JSON.",
      });
      return;
    }

    setState({ status: "waiting" });

    try {
      const signature = await provider.request({
        method: "eth_signTypedData_v4",
        params: [account, json],
      });

      /**
       * ------------------------------------------------------------------------
       * THE VERIFICATION IS THE POINT OF THIS PANEL
       * ------------------------------------------------------------------------
       * 🇪🇸 NOTA: `verifyTypedData` recalcula el hash EIP-712 desde cero —dominio,
       * tipos, mensaje— y recupera QUIÉN firmó, usando solo la firma. Si la
       * wallet hubiera construido mal el separador de dominio, o hubiera
       * codificado los tipos de otra forma, la dirección recuperada sería otra.
       *
       * Es la diferencia entre "la wallet devolvió una firma" y "la wallet
       * devolvió una firma que un contrato aceptaría". Una firma mal construida
       * verifica perfectamente contra su propio código equivocado.
       */
      const { EIP712Domain: _ignored, ...types } = payload.types;
      const recovered = verifyTypedData(
        payload.domain as Parameters<typeof verifyTypedData>[0],
        types as Parameters<typeof verifyTypedData>[1],
        payload.message as Record<string, unknown>,
        String(signature),
      );

      setState({
        status: "signed",
        result: {
          signature: String(signature),
          recovered,
          expected: account,
          matches: recovered.toLowerCase() === account.toLowerCase(),
        },
      });
    } catch (cause) {
      if (isUserRejection(cause)) {
        setState({ status: "idle" });
        return;
      }
      setState({ status: "failed", error: describeProviderError(cause) });
    }
  }

  if (account === null) {
    return (
      <p className="muted" style={{ fontSize: 13 }} data-testid="sign-disconnected">
        Connect the wallet first. Signing needs the same per-origin permission as sending.
      </p>
    );
  }

  return (
    <div data-testid="sign-typed-panel">
      <div className="row" style={{ marginBottom: "var(--space-2)" }}>
        {TYPED_DATA_EXAMPLES.map((example) => (
          <button
            key={example.id}
            type="button"
            className="action"
            title={example.hint}
            data-testid={`btn-example-${example.id}`}
            onClick={() => {
              setJson(example.json);
              setState({ status: "idle" });
            }}
          >
            {example.label}
          </button>
        ))}
      </div>

      <textarea
        className="field code-area"
        value={json}
        spellCheck={false}
        rows={14}
        aria-label="EIP-712 typed data"
        data-testid="input-typed-data"
        onChange={(event) => {
          setJson(event.target.value);
          setState({ status: "idle" });
        }}
      />

      <div className="row" style={{ marginTop: "var(--space-2)" }}>
        <button
          type="button"
          className="action primary"
          disabled={state.status === "waiting"}
          data-testid="btn-sign-typed"
          onClick={() => void sign()}
        >
          {state.status === "waiting" ? "Waiting for approval…" : "Sign typed data"}
        </button>
        <span className="muted" style={{ fontSize: 13 }}>
          Signing costs no gas and never touches the chain.
        </span>
      </div>

      {state.status === "invalid" && (
        <p className="output bad" data-testid="sign-typed-invalid">
          <span className="output-label">That JSON does not parse</span>
          {state.message}
        </p>
      )}

      {state.status === "failed" && (
        <p className="output bad" data-testid="sign-typed-error">
          <span className="output-label">The message was not signed</span>
          {state.error.title}
          {"\n"}
          <span className="error-code">
            {state.error.code === null ? "" : `code ${state.error.code} · `}
            {state.error.detail}
          </span>
        </p>
      )}

      {state.status === "signed" && (
        <div className="output" data-testid="sign-typed-result">
          <span className="output-label">Signature</span>
          <span className="mono" style={{ fontSize: 12 }} data-testid="typed-signature">
            {state.result.signature}
          </span>

          <div className="verify-row" data-testid="typed-verification">
            <span className={state.result.matches ? "ok" : "bad"}>
              {state.result.matches ? "✓ verified" : "✗ mismatch"}
            </span>
            <span className="muted">
              recovered <code>{shortenAddress(state.result.recovered)}</code>, expected{" "}
              <code>{shortenAddress(state.result.expected)}</code>
            </span>
          </div>

          <p className="muted" style={{ fontSize: 12, margin: "var(--space-2) 0 0" }}>
            <code>verifyTypedData</code> recomputed the EIP-712 hash from the domain, the types
            and the message, and recovered the signer from the signature alone. A different
            address here would mean the wallet built the hash differently from the standard.
          </p>
        </div>
      )}
    </div>
  );
}
