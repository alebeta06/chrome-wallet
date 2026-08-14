import { useState } from "react";

import type { Address, Hex } from "@/types/messages";
import { formatEther, shortenAddress } from "@/lib/format";
import { parseAmount, validateAmount } from "@/lib/validators";
import { callBackground, toRpcError } from "@/ui/rpc";

interface Props {
  accounts: Address[];
  /** The account the transfer leaves from: the wallet-wide default. */
  fromIndex: number;
  balances: Record<Address, Hex | undefined>;
  onSent(): void;
}

/**
 * 🇪🇸 NOTA: `idle → pending → confirmed | failed`, y el estado de carga es
 * FUNCIONALIDAD, no adorno. En Sepolia una confirmación son 12-15 segundos: sin
 * nada en pantalla, el usuario pulsa otra vez, y la segunda transferencia es
 * real. Que el botón se deshabilite mientras tanto es lo que impide el doble
 * envío.
 */
type Status =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "confirmed"; hash: Hex }
  | { kind: "failed"; message: string };

/**
 * Moving funds between the user's own accounts (spec 25).
 *
 * ---------------------------------------------------------------------------
 * NO APPROVAL WINDOW HERE
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: las ventanas de aprobación protegen al usuario de las dApps, no de sí
 * mismo. Esto lo pulsa el dueño en su propia UI, así que pedirle permiso por lo
 * que acaba de pulsar solo añadiría un clic — y los clics de confirmación que no
 * aportan nada son los que enseñan a aprobar sin leer.
 */
export function InternalTransfer({ accounts, fromIndex, balances, onSent }: Props) {
  const [toIndex, setToIndex] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const from = accounts[fromIndex];
  const balance = from === undefined ? undefined : balances[from];

  /**
   * 🇪🇸 NOTA: el desplegable excluye la cuenta de origen. Mandarse dinero a uno
   * mismo se mina perfectamente y solo quema gas, así que la opción no existe en
   * vez de existir y ser rechazada — el background la rechaza igual, pero un
   * control que ofrece algo inválido es un control que miente.
   */
  const destinations = accounts
    .map((address, index) => ({ address, index }))
    .filter((entry) => entry.index !== fromIndex);

  /**
   * 🇪🇸 NOTA: aquí la fee va a CERO a propósito, y no es un descuido. El popup no
   * puede estimarla —no hay método interno para eso y el contrato no se amplía
   * por esto—, así que esta validación solo atrapa lo barato: formato, decimales
   * de más, cero, y pasarse del saldo. La comprobación de verdad, con la fee real,
   * la hace el background antes de firmar y con la MISMA función.
   *
   * Es un filtro previo, no la autoridad. Decir lo contrario aquí llevaría a que
   * alguien quitara la del background por "duplicada".
   */
  const check =
    amount.trim().length === 0
      ? null
      : validateAmount(amount, { balanceWei: BigInt(balance ?? "0x0"), feeWei: 0n });

  const canSend = toIndex !== null && check !== null && check.ok && status.kind !== "pending";

  async function send(): Promise<void> {
    if (toIndex === null || check === null || !check.ok) return;

    /**
     * 🇪🇸 NOTA: se parsea con la MISMA función que acaba de validar, no con una
     * conversión escrita aquí. Un segundo `split(".")` en este archivo sería dos
     * versiones de la misma regla, y la de aquí se olvidaría del `padEnd` el día
     * que alguien la tocara — que es el fallo que convierte 0.1 ETH en 1 wei sin
     * que nada se queje.
     *
     * No puede ser null: `check.ok` ya lo garantiza. Se comprueba igual porque
     * el tipo lo dice y fingir lo contrario con un `!` es cómo se cuelan.
     */
    const wei = parseAmount(amount);
    if (wei === null) return;

    setStatus({ kind: "pending" });
    try {
      const hash = await callBackground("wallet_internalTransfer", {
        fromIndex,
        toIndex,
        // The decimal string never reaches the background: it travels as wei.
        valueWei: `0x${wei.toString(16)}` as Hex,
      });

      setStatus({ kind: "confirmed", hash });
      setAmount("");
      onSent();
    } catch (cause) {
      setStatus({ kind: "failed", message: toRpcError(cause).message });
    }
  }

  if (accounts.length < 2) return null;

  return (
    <section className="stack stack--tight" data-testid="internal-transfer">
      <h2>Send between your accounts</h2>

      <p className="transfer__from" data-testid="transfer-from">
        From {shortenAddress(from ?? ("0x" as Address))}
        {balance !== undefined && <span> · {formatEther(balance)} ETH</span>}
      </p>

      <label className="transfer__field">
        <span>To</span>
        <select
          value={toIndex ?? ""}
          onChange={(event) =>
            setToIndex(event.target.value === "" ? null : Number(event.target.value))
          }
          data-testid="transfer-to"
        >
          <option value="">Choose an account…</option>
          {destinations.map((entry) => (
            <option key={entry.address} value={entry.index} data-testid={`transfer-to-${entry.index}`}>
              #{entry.index} · {shortenAddress(entry.address)}
            </option>
          ))}
        </select>
      </label>

      <label className="transfer__field">
        <span>Amount (ETH)</span>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          placeholder="0.0"
          onChange={(event) => setAmount(event.target.value)}
          data-testid="transfer-amount"
        />
      </label>

      {check !== null && !check.ok && (
        <p className="banner banner--error" data-testid="transfer-amount-error">
          {check.message}
        </p>
      )}

      <button
        type="button"
        className="button--primary"
        disabled={!canSend}
        onClick={() => void send()}
        data-testid="transfer-send"
      >
        {status.kind === "pending" ? "Sending…" : "Send"}
      </button>

      {status.kind === "confirmed" && (
        <p className="banner banner--ok" data-testid="transfer-sent">
          Sent. <span className="transfer__hash">{status.hash}</span>
        </p>
      )}

      {status.kind === "failed" && (
        <p className="banner banner--error" data-testid="transfer-error">
          {status.message}
        </p>
      )}
    </section>
  );
}
