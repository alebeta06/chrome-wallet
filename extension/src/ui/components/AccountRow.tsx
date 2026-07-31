import { useState } from "react";

import type { Address, Hex } from "@/types/messages";
import { formatEther, shortenAddress } from "@/lib/format";

interface AccountRowProps {
  index: number;
  address: Address;
  /** undefined while unknown — never rendered as 0.0000. */
  balance: Hex | undefined;
  isDefault: boolean;
  isInitialLoad: boolean;
  onSelect(index: number): void;
}

export function AccountRow({
  index,
  address,
  balance,
  isDefault,
  isInitialLoad,
  onSelect,
}: AccountRowProps) {
  const [hasCopied, setHasCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(address);
      setHasCopied(true);
      setTimeout(() => setHasCopied(false), 1200);
    } catch {
      // Clipboard access can be denied; failing silently beats crashing the row.
    }
  }

  /**
   * 🇪🇸 NOTA: mientras no se sabe el saldo se muestra un guion, nunca 0.0000.
   * Un cero es un saldo real y perfectamente posible, así que usarlo como
   * "cargando" es decirle al usuario que no tiene fondos cuando lo que pasa es
   * que aún no hemos preguntado.
   */
  const balanceLabel =
    balance !== undefined ? `${formatEther(balance)} ETH` : isInitialLoad ? "—" : "unavailable";

  return (
    <li>
      <div className={`account-row ${isDefault ? "account-row--default" : ""}`} data-testid={`account-row-${index}`}>
        <span className="account-row__index">{index}</span>

        <button
          type="button"
          className="account-row__body button--ghost"
          onClick={() => onSelect(index)}
          aria-pressed={isDefault}
          data-testid={`account-select-${index}`}
        >
          <span className="account-row__address" data-testid={`account-address-${index}`}>
            {shortenAddress(address)}
          </span>
          <span className="account-row__balance" data-testid={`account-balance-${index}`}>
            {balanceLabel}
          </span>
        </button>

        {isDefault && (
          <span className="account-row__default-mark" data-testid={`account-default-mark-${index}`}>
            default
          </span>
        )}

        <button
          type="button"
          className="button--icon"
          onClick={() => void copy()}
          title={address}
          aria-label={`Copy address of account ${index}`}
          data-testid={`account-copy-${index}`}
        >
          {hasCopied ? "✓" : "copy"}
        </button>
      </div>
    </li>
  );
}
