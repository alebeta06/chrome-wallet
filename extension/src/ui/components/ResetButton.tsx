import { useState } from "react";

import { callBackground, toRpcError } from "@/ui/rpc";

interface ResetButtonProps {
  onReset(): void;
}

/**
 * Two-step confirmation. Resetting drops the mnemonic, and nothing brings it
 * back, so a single misclick must not be able to do it.
 */
export function ResetButton({ onReset }: ResetButtonProps) {
  const [isArmed, setIsArmed] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reset(): Promise<void> {
    setIsBusy(true);
    try {
      await callBackground("wallet_reset");
      setIsArmed(false);
      onReset();
    } catch (cause) {
      setError(toRpcError(cause).message);
    } finally {
      setIsBusy(false);
    }
  }

  if (!isArmed) {
    return (
      <button
        type="button"
        className="button--ghost"
        onClick={() => setIsArmed(true)}
        data-testid="reset-wallet-button"
      >
        Reset wallet
      </button>
    );
  }

  return (
    <div className="stack stack--tight">
      <p className="banner banner--warn">
        This erases the recovery phrase and every account from this browser. Make sure you
        have the phrase written down.
      </p>

      {error !== null && <p className="banner banner--error">{error}</p>}

      <div className="row">
        <button
          type="button"
          className="button--danger"
          disabled={isBusy}
          onClick={() => void reset()}
          data-testid="reset-wallet-confirm-button"
        >
          {isBusy ? "Resetting…" : "Yes, erase it"}
        </button>
        <button
          type="button"
          className="button--ghost"
          onClick={() => setIsArmed(false)}
          data-testid="reset-wallet-cancel-button"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
