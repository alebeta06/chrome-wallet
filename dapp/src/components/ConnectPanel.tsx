"use client";

import { useState } from "react";

import { describeProviderError, isUserRejection, type DisplayError } from "@/lib/errors";
import { shortenAddress } from "@/lib/format";
import type { EIP1193Provider } from "@/types/eip1193";

interface Props {
  provider: EIP1193Provider;
  account: string | null;
  onAccount(account: string | null): void;
}

export function ConnectPanel({ provider, account, onAccount }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError | null>(null);

  async function connect(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const result = await provider.request({ method: "eth_requestAccounts" });
      onAccount(Array.isArray(result) && result.length > 0 ? String(result[0]) : null);
    } catch (cause) {
      /**
       * 🇪🇸 NOTA: rechazar no es un error. El usuario pulsó "reject" y la wallet
       * hizo lo que le pidió; enseñar un banner rojo por eso es culparle de
       * haberla usado bien. Se vuelve al botón de conectar y ya está.
       */
      if (!isUserRejection(cause)) setError(describeProviderError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      await provider.request({ method: "wallet_revokePermissions" });
      onAccount(null);
    } catch (cause) {
      setError(describeProviderError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="connect-panel">
      <div className="row">
        {account === null ? (
          <button
            type="button"
            className="action primary"
            disabled={busy}
            data-testid="btn-connect"
            onClick={() => void connect()}
          >
            {busy ? "Waiting for the wallet…" : "Connect wallet"}
          </button>
        ) : (
          <>
            <span className="connected-pill" data-testid="connected-account" title={account}>
              {shortenAddress(account)}
            </span>
            <button
              type="button"
              className="action"
              disabled={busy}
              data-testid="btn-disconnect"
              onClick={() => void disconnect()}
            >
              Disconnect
            </button>
          </>
        )}
      </div>

      {error !== null && (
        <p className="bad" style={{ fontSize: 13 }} data-testid="connect-error">
          {error.title}{" "}
          <span className="error-code">
            {error.code === null ? "" : `(code ${error.code})`}
          </span>
        </p>
      )}

      {/*
        🇪🇸 NOTA: 4100 y 4001 se tratan distinto a propósito. "No tienes wallet
        configurada" pide una acción concreta; "has cancelado" no pide nada. Que
        la wallet devuelva códigos distintos es lo que permite esta diferencia.
      */}
      {error?.code === 4100 && (
        <p className="muted" style={{ fontSize: 13 }} data-testid="connect-setup-hint">
          Open the extension and create or import a wallet first, then try again.
        </p>
      )}
    </div>
  );
}
