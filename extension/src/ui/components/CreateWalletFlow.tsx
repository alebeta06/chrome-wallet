import { useEffect, useState } from "react";

import { callBackground, toRpcError } from "@/ui/rpc";
import { DEFAULT_ACCOUNT_COUNT } from "./constants";

interface CreateWalletFlowProps {
  onCreated(): void;
  onBack(): void;
}

/**
 * Generates a phrase, shows it, and imports it once the user confirms.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PHRASE IS ALLOWED ON SCREEN
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: la regla de oro dice que el mnemonic y las claves privadas viven
 * SOLO en el service worker. Mostrar la frase no la rompe, y conviene tener
 * clara la distinción, porque parece que sí.
 *
 * Lo que la regla prohíbe es que la UI DERIVE, FIRME o PERSISTA. Nada de eso
 * pasa aquí: el popup no sabe qué es un HDNodeWallet, no tiene ethers en su
 * bundle, y no escribe en storage. Recibe la frase, la pinta, y se la devuelve
 * al background para que la importe.
 *
 * Y mostrarla no es opcional: una frase de recuperación que el usuario nunca ve
 * es una wallet que no puede recuperar. MetaMask hace exactamente esto por el
 * mismo motivo.
 *
 * Las tres reglas que sí aplican, y que este componente cumple:
 *   1. La frase vive en el estado local de ESTE componente, el más pequeño que
 *      la necesita. No sube a Popup, no viaja por props, no hay contexto.
 *   2. Se borra en cuanto la importación responde ok, antes de avisar al padre.
 *   3. No se loguea nunca, ni entera ni parcial, ni en un catch. Y no toca
 *      sessionStorage ni localStorage.
 */
export function CreateWalletFlow({ onCreated, onBack }: CreateWalletFlowProps) {
  const [phrase, setPhrase] = useState<string | null>(null);
  const [hasSavedIt, setHasSavedIt] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const generated = await callBackground("wallet_createMnemonic");
        if (!cancelled) setPhrase(generated);
      } catch (cause) {
        if (!cancelled) setError(toRpcError(cause).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  async function confirm(): Promise<void> {
    if (phrase === null) return;

    setIsBusy(true);
    setError(null);
    try {
      await callBackground("wallet_importMnemonic", {
        phrase,
        accountCount: DEFAULT_ACCOUNT_COUNT,
      });
      // Out of React state before anything else happens.
      setPhrase(null);
      onCreated();
    } catch (cause) {
      // toRpcError never carries the phrase: it only sees the background's reply.
      setError(toRpcError(cause).message);
      setIsBusy(false);
    }
  }

  const words = phrase === null ? [] : phrase.split(" ");

  return (
    <section className="stack" data-testid="create-wallet-view">
      <h2>Your recovery phrase</h2>
      <p className="muted">
        Write these 12 words down in order and keep them offline. Anyone who has them
        controls this wallet, and they cannot be recovered if lost.
      </p>

      {phrase === null && error === null && <p className="muted">Generating…</p>}

      {words.length > 0 && (
        <div className="mnemonic-grid" data-testid="mnemonic-words">
          {words.map((word, index) => (
            <span className="mnemonic-word" key={`${index}-${word}`} data-testid={`mnemonic-word-${index}`}>
              <span className="mnemonic-word__index">{index + 1}</span>
              {word}
            </span>
          ))}
        </div>
      )}

      <label>
        <input
          type="checkbox"
          checked={hasSavedIt}
          onChange={(event) => setHasSavedIt(event.target.checked)}
          disabled={phrase === null}
          data-testid="mnemonic-confirm-checkbox"
        />
        I have written my recovery phrase down
      </label>

      {error !== null && (
        <p className="banner banner--error" data-testid="wallet-error-banner">
          {error}
        </p>
      )}

      <button
        type="button"
        className="button--primary button--block"
        disabled={!hasSavedIt || phrase === null || isBusy}
        onClick={() => void confirm()}
        data-testid="mnemonic-confirm-button"
      >
        {isBusy ? "Creating…" : "Create wallet"}
      </button>

      <button type="button" className="button--ghost" onClick={onBack} data-testid="onboarding-back-button">
        Back
      </button>
    </section>
  );
}
