import { useCallback, useEffect, useMemo, useState } from "react";

import type { AddEthereumChainParameter, NetworkConfig } from "@/types/messages";
import { canonicalChainId } from "@/lib/networks";
import { isRpcUrlAllowed, originPatternFromRpcUrl } from "@/lib/permissions";
import { callBackground, toRpcError } from "@/ui/rpc";

/**
 * Seeded from `?chainId=` when the popup sends the user here to restore access.
 *
 * 🇪🇸 NOTA: solo viaja el chainId, no la red entera. Los valores se leen del
 * catálogo al abrir, así que lo que se reconcede es lo que la wallet tiene
 * guardado — no lo que alguien pudiera meter en la URL de la ventana.
 */
function readSeed(): string | null {
  return new URLSearchParams(window.location.search).get("chainId");
}

interface Fields {
  name: string;
  rpcUrl: string;
  chainId: string;
  symbol: string;
  decimals: string;
  explorerUrl: string;
}

const EMPTY: Fields = {
  name: "",
  rpcUrl: "",
  chainId: "",
  symbol: "",
  decimals: "18",
  explorerUrl: "",
};

function fromNetwork(network: NetworkConfig): Fields {
  return {
    name: network.name,
    rpcUrl: network.rpcUrl,
    chainId: network.chainId,
    symbol: network.nativeCurrency?.symbol ?? network.symbol,
    decimals: String(network.nativeCurrency?.decimals ?? 18),
    explorerUrl: network.explorerUrl ?? "",
  };
}

/** Field-level problems, so the message sits next to the input that caused it. */
function validate(fields: Fields): Partial<Record<keyof Fields, string>> {
  const problems: Partial<Record<keyof Fields, string>> = {};

  if (fields.name.trim().length === 0) problems.name = "A name is required.";

  if (fields.rpcUrl.trim().length === 0) {
    problems.rpcUrl = "An RPC endpoint is required.";
  } else if (!isRpcUrlAllowed(fields.rpcUrl.trim())) {
    /**
     * 🇪🇸 NOTA: el mismo `isRpcUrlAllowed` que usa el background, importado
     * porque es puro. No es una segunda validación "por si acaso": el background
     * valida igual y es quien manda. Ésta existe para que el error salga MIENTRAS
     * se escribe y junto al campo, en vez de después de abrir un diálogo de
     * permisos que iba a fallar.
     */
    problems.rpcUrl = "Must be https, or plain http only on localhost or 127.0.0.1.";
  }

  if (canonicalChainId(fields.chainId.trim()) === null) {
    problems.chainId = 'A hex chain ID like "0x89".';
  }

  if (fields.symbol.trim().length === 0) problems.symbol = "A currency symbol is required.";

  const decimals = Number(fields.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    problems.decimals = "A whole number between 0 and 36.";
  }

  return problems;
}

function toParameter(fields: Fields): AddEthereumChainParameter {
  const explorer = fields.explorerUrl.trim();

  return {
    chainId: canonicalChainId(fields.chainId.trim()) as `0x${string}`,
    chainName: fields.name.trim(),
    rpcUrls: [fields.rpcUrl.trim()],
    nativeCurrency: {
      name: fields.symbol.trim(),
      symbol: fields.symbol.trim(),
      decimals: Number(fields.decimals),
    },
    ...(explorer.length === 0 ? {} : { blockExplorerUrls: [explorer] }),
  };
}

type Phase = { status: "editing" } | { status: "working" } | { status: "done"; name: string };

export function NetworkForm() {
  const seed = useMemo(readSeed, []);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [restoring, setRestoring] = useState(false);
  const [phase, setPhase] = useState<Phase>({ status: "editing" });
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (seed === null) return;
    let cancelled = false;

    void (async () => {
      try {
        const snapshot = await callBackground("wallet_getState");
        if (cancelled) return;

        const known = snapshot.networks.find((entry) => entry.chainId === seed);
        if (known === undefined) return;

        setFields(fromNetwork(known));
        setRestoring(true);
      } catch {
        // An empty form is still usable; the user can type the values again.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [seed]);

  const problems = validate(fields);
  const isValid = Object.keys(problems).length === 0;

  function set<K extends keyof Fields>(key: K, value: string): void {
    setFields((current) => ({ ...current, [key]: value }));
    setError(null);
  }

  /**
   * ------------------------------------------------------------------------
   * THE PERMISSION IS REQUESTED HERE, AND THERE IS NO APPROVAL WINDOW
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: no falta una ventana de aprobación, sobra. Cuando quien pide es
   * una dApp, la ventana existe para nombrar a un tercero y dar la opción de
   * decir que no. Aquí no hay tercero y no hay nada que el usuario no sepa: la
   * respuesta es sí por construcción, y una aprobación que no puede acabar en
   * "no" solo enseña a pulsar sin leer.
   *
   * Lo que sí es obligatorio sigue estando: el permiso —que necesita este gesto,
   * en esta ventana— y la verificación del `eth_chainId`, que hace el background
   * en `finaliseAdd`, la misma función por la que pasa el alta de una dApp.
   */
  const submit = useCallback(async () => {
    setTouched(true);
    if (!isValid) return;

    const parameter = toParameter(fields);
    const pattern = originPatternFromRpcUrl(parameter.rpcUrls[0]);
    if (pattern === null) {
      setError("That RPC endpoint cannot be used by the wallet.");
      return;
    }

    setPhase({ status: "working" });
    setError(null);

    let granted: boolean;
    try {
      granted = await chrome.permissions.request({ origins: [pattern] });
    } catch (cause) {
      console.error("[codecrypto] the permission request failed:", cause);
      setPhase({ status: "editing" });
      setError("Chrome refused to ask for permission to reach that endpoint.");
      return;
    }

    if (!granted) {
      setPhase({ status: "editing" });
      setError("Without permission to reach that endpoint the wallet cannot use this network.");
      return;
    }

    try {
      await callBackground("wallet_addNetwork", parameter);
      setPhase({ status: "done", name: parameter.chainName });
    } catch (cause) {
      setPhase({ status: "editing" });
      setError(toRpcError(cause).message);
    }
  }, [fields, isValid]);

  if (phase.status === "done") {
    return (
      <main className="approval" data-testid="network-form-done">
        <p className="banner" data-testid="network-form-success">
          <strong>{phase.name}</strong> is ready to use. Pick it in the wallet&apos;s network
          selector.
        </p>
        <button
          type="button"
          className="button--primary"
          data-testid="network-form-close"
          onClick={() => window.close()}
        >
          Close
        </button>
      </main>
    );
  }

  const busy = phase.status === "working";

  return (
    <main className="approval" data-testid="network-form">
      <header className="approval__header">
        <p className="approval__eyebrow" data-testid="network-form-title">
          {restoring ? "Restore access to a network" : "Add a network"}
        </p>
      </header>

      {restoring && (
        <p className="banner banner--warn" data-testid="network-form-restoring">
          The wallet still has this network but is no longer allowed to reach its RPC endpoint.
          Granting it again is all it needs.
        </p>
      )}

      <div className="stack">
        <Field
          id="name"
          label="Name"
          value={fields.name}
          problem={touched ? problems.name : undefined}
          disabled={busy || restoring}
          onChange={(value) => set("name", value)}
        />
        {/*
          🇪🇸 NOTA: la URL en monoespaciada, como en la ventana de alta de una
          dApp. Un `polygon-rpc.com` y un `polygon-rpc.com.evil.io` se distinguen
          por el final, y la proporcional los disimula.
        */}
        <Field
          id="rpc-url"
          label="RPC endpoint"
          value={fields.rpcUrl}
          mono
          problem={touched ? problems.rpcUrl : undefined}
          disabled={busy || restoring}
          onChange={(value) => set("rpcUrl", value)}
        />
        <Field
          id="chain-id"
          label="Chain ID"
          value={fields.chainId}
          mono
          problem={touched ? problems.chainId : undefined}
          disabled={busy || restoring}
          onChange={(value) => set("chainId", value)}
        />
        <Field
          id="symbol"
          label="Currency symbol"
          value={fields.symbol}
          problem={touched ? problems.symbol : undefined}
          disabled={busy || restoring}
          onChange={(value) => set("symbol", value)}
        />
        <Field
          id="decimals"
          label="Decimals"
          value={fields.decimals}
          problem={touched ? problems.decimals : undefined}
          disabled={busy || restoring}
          onChange={(value) => set("decimals", value)}
        />
        <Field
          id="explorer-url"
          label="Block explorer (optional)"
          value={fields.explorerUrl}
          mono
          disabled={busy || restoring}
          onChange={(value) => set("explorerUrl", value)}
        />
      </div>

      <p className="muted" data-testid="network-form-hint">
        Chrome will ask separately for permission to reach that endpoint. The wallet then checks
        that it really serves the chain ID above before saving anything.
      </p>

      {error !== null && (
        <p className="banner banner--error" data-testid="network-form-error">
          {error}
        </p>
      )}

      <div className="approval__actions">
        <button
          type="button"
          className="button--ghost"
          data-testid="network-form-cancel"
          disabled={busy}
          onClick={() => window.close()}
        >
          Cancel
        </button>
        <button
          type="button"
          className="button--primary"
          data-testid="network-form-submit"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? "Waiting for Chrome…" : restoring ? "Restore access" : "Add network"}
        </button>
      </div>
    </main>
  );
}

interface FieldProps {
  id: string;
  label: string;
  value: string;
  mono?: boolean;
  problem?: string | undefined;
  disabled?: boolean;
  onChange(value: string): void;
}

function Field({ id, label, value, mono, problem, disabled, onChange }: FieldProps) {
  return (
    <label className="field" htmlFor={`network-${id}`}>
      <span className="field__label">{label}</span>
      <input
        id={`network-${id}`}
        className={mono === true ? "field__input mono" : "field__input"}
        type="text"
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        data-testid={`network-${id}`}
        onChange={(event) => onChange(event.target.value)}
      />
      {problem !== undefined && (
        <span className="field__problem" data-testid={`network-${id}-problem`}>
          {problem}
        </span>
      )}
    </label>
  );
}
