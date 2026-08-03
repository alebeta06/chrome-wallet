import { useCallback, useEffect, useState } from "react";

import type { Address, ConnectedSite, Origin } from "@/types/messages";
import { shortenAddress } from "@/lib/format";
import { callBackground, toRpcError } from "@/ui/rpc";

interface Props {
  accounts: Address[];
  /** Bumped by the parent so the list re-reads after a connect or a disconnect. */
  revision: number;
  onChanged(): void;
}

/**
 * Every origin with access, and a way to take it away.
 *
 * 🇪🇸 NOTA: spec 37. Una wallet que deja conectar sitios y no enseña cuáles
 * están conectados es una wallet en la que el permiso se da una vez y no se
 * revisa nunca — y eso es exactamente cómo se acumulan permisos de sitios que
 * usaste una tarde hace seis meses.
 */
export function ConnectedSites({ accounts, revision, onChanged }: Props) {
  const [sites, setSites] = useState<ConnectedSite[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSites(await callBackground("wallet_getConnectedSites"));
      setError(null);
    } catch (cause) {
      setError(toRpcError(cause).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  async function disconnect(origin: Origin): Promise<void> {
    try {
      await callBackground("wallet_disconnectSite", { origin });
      onChanged();
    } catch (cause) {
      setError(toRpcError(cause).message);
    }
  }

  // Nothing connected is not an error state and gets no empty-state box: the
  // section simply is not there.
  if (sites !== null && sites.length === 0 && error === null) return null;

  return (
    <section className="stack stack--tight" data-testid="connected-sites">
      <h2>Connected sites</h2>

      {error !== null && (
        <p className="banner banner--error" data-testid="connected-sites-error">
          {error}
        </p>
      )}

      <ul className="site-list">
        {(sites ?? []).map((site) => (
          <li key={site.origin} className="site-row" data-testid={`site-${site.origin}`}>
            <span className="site-row__origin">{site.origin}</span>
            <span className="site-row__account">
              {accounts[site.accountIndex] === undefined
                ? "—"
                : shortenAddress(accounts[site.accountIndex])}
            </span>
            <button
              type="button"
              className="button--ghost"
              data-testid={`site-disconnect-${site.origin}`}
              onClick={() => void disconnect(site.origin)}
            >
              Disconnect
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
