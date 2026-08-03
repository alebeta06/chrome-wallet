import type { Address, ConnectedSite } from "@/types/messages";
import { shortenAddress } from "@/lib/format";

interface Props {
  site: ConnectedSite;
  accounts: Address[];
  onSelectAccount(accountIndex: number): void;
  onDisconnect(): void;
}

/**
 * The account THIS site sees, shown next to — never instead of — the
 * wallet-wide default.
 *
 * ---------------------------------------------------------------------------
 * THIS COMPONENT IS HALF THE VALUE OF THE PER-ORIGIN MODEL
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: sin esta banda el popup enseña un solo selector de cuenta, y el
 * usuario que quiere cambiar la cuenta que ve una dApp pulsa ahí, cambia la
 * cuenta POR DEFECTO de la wallet, la dApp no se entera de nada, y el modelo por
 * origen parece un bug.
 *
 * La clave está en que cada control tenga el SUYO, no en enseñar dos números:
 *
 *   este desplegable  → wallet_setSiteAccount    → solo este sitio, y SÍ emite
 *   la lista de abajo → wallet_setDefaultAccount → preferencia interna, NO emite
 *
 * Si la lista de abajo hiciera las dos cosas según el contexto, sería
 * imposible saber qué va a pasar antes de pulsar — que es peor que no tener la
 * banda.
 */
export function ActiveSiteBand({ site, accounts, onSelectAccount, onDisconnect }: Props) {
  return (
    <section className="site-band" data-testid="active-site-band">
      <span className="site-band__label">This site sees</span>
      <span className="site-band__origin" data-testid="active-site-origin">
        {site.origin}
      </span>

      <div className="site-band__account">
        <select
          value={site.accountIndex}
          aria-label="Account this site sees"
          data-testid="active-site-account"
          onChange={(event) => onSelectAccount(Number(event.target.value))}
        >
          {accounts.map((address, index) => (
            <option key={address} value={index}>
              {index} · {shortenAddress(address)}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="button--ghost"
          data-testid="active-site-disconnect"
          onClick={onDisconnect}
        >
          Disconnect
        </button>
      </div>

      <span className="site-band__label">
        Changing this only affects {site.origin}. The list below sets the wallet default.
      </span>
    </section>
  );
}
