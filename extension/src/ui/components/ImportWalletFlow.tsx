import { useMemo, useState } from "react";

import { normalizeMnemonicInput } from "@/lib/format";
import { callBackground, toRpcError } from "@/ui/rpc";
import { DEFAULT_ACCOUNT_COUNT, DEV_MNEMONIC, VALID_WORD_COUNTS } from "./constants";

interface ImportWalletFlowProps {
  onImported(): void;
  onBack(): void;
}

/**
 * 🇪🇸 NOTA sobre el alcance de la validación en vivo.
 *
 * Aquí se comprueba el número de palabras y que cada una sea a-z. Lo que NO se
 * comprueba es el checksum BIP-39, y no es un olvido: validar el checksum exige
 * la lista de 2048 palabras, que vive dentro de ethers, que no puede entrar en
 * el bundle de la UI. Se podría duplicar la lista en la UI, pero entonces habría
 * dos copias de la misma verdad y una acabaría desactualizada.
 *
 * Así que la validez final la decide el background, que ya tiene la lista, y
 * responde -32602 si la frase no cuadra. Lo que se gana con la comprobación
 * local es el 90% de los errores reales —una palabra de menos al pegar— sin
 * necesidad de ir y volver.
 */
function describeInput(normalized: string): { words: number; hint: string; canSubmit: boolean } {
  if (normalized === "") {
    return { words: 0, hint: "", canSubmit: false };
  }

  const words = normalized.split(" ");
  const malformed = words.find((word) => !/^[a-z]+$/.test(word));

  if (malformed !== undefined) {
    return {
      words: words.length,
      hint: "A recovery phrase contains only lowercase words — check for stray characters.",
      canSubmit: false,
    };
  }

  if (!VALID_WORD_COUNTS.includes(words.length)) {
    return {
      words: words.length,
      hint: `${words.length} words. A recovery phrase has 12, 15, 18, 21 or 24.`,
      canSubmit: false,
    };
  }

  return { words: words.length, hint: `${words.length} words`, canSubmit: true };
}

export function ImportWalletFlow({ onImported, onBack }: ImportWalletFlowProps) {
  const [raw, setRaw] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Normalisation happens on every keystroke so the count the user sees is the
  // count the background will see. See lib/format.ts for what it strips.
  const normalized = useMemo(() => normalizeMnemonicInput(raw), [raw]);
  const { hint, canSubmit } = describeInput(normalized);

  async function submit(): Promise<void> {
    setIsBusy(true);
    setError(null);
    try {
      await callBackground("wallet_importMnemonic", {
        phrase: normalized,
        accountCount: DEFAULT_ACCOUNT_COUNT,
      });
      setRaw("");
      onImported();
    } catch (cause) {
      setError(toRpcError(cause).message);
      setIsBusy(false);
    }
  }

  return (
    <section className="stack" data-testid="import-wallet-view">
      <h2>Import a recovery phrase</h2>

      <textarea
        value={raw}
        onChange={(event) => setRaw(event.target.value)}
        placeholder="word one word two word three…"
        // No autofill, no spell-check, no autocorrect: a password manager or a
        // spell checker must never see a recovery phrase.
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-testid="import-mnemonic-textarea"
      />

      <p
        className={`feedback ${canSubmit ? "feedback--ok" : "feedback--bad"}`}
        data-testid="import-mnemonic-feedback"
      >
        {hint}
      </p>

      <button
        type="button"
        className="button--ghost"
        onClick={() => setRaw(DEV_MNEMONIC)}
        data-testid="import-mnemonic-hint-button"
      >
        Use the public Anvil dev phrase (local testing only)
      </button>

      {error !== null && (
        <p className="banner banner--error" data-testid="wallet-error-banner">
          {error}
        </p>
      )}

      <button
        type="button"
        className="button--primary button--block"
        disabled={!canSubmit || isBusy}
        onClick={() => void submit()}
        data-testid="import-mnemonic-submit"
      >
        {isBusy ? "Importing…" : "Import wallet"}
      </button>

      <button type="button" className="button--ghost" onClick={onBack} data-testid="onboarding-back-button">
        Back
      </button>
    </section>
  );
}
