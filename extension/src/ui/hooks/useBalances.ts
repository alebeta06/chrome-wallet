import { useEffect, useState } from "react";

import type { Address, Hex } from "@/types/messages";
import { callBackground, type RpcError } from "@/ui/rpc";
import { createBalancePoller } from "./balance-poller";

/**
 * 🇪🇸 NOTA: 5 segundos, con setInterval, y viviendo en el popup.
 *
 * NO se usa chrome.alarms: su periodo mínimo es de 1 minuto, así que ni siquiera
 * podría cumplir la especificación. Pero es que además el sitio correcto para
 * este polling es el popup: cuando el popup se cierra, el intervalo se limpia y
 * las peticiones paran. Es lo que se quiere — nadie está mirando el saldo, así
 * que consultarlo sería gastar batería y cuota de RPC para nada. Un polling en
 * el background seguiría corriendo con la wallet cerrada.
 */
export const BALANCE_POLL_INTERVAL_MS = 5_000;

export interface BalancesState {
  balances: Record<Address, Hex>;
  error: RpcError | null;
  /** True until the first response settles, success or failure. */
  isInitialLoad: boolean;
}

/**
 * @param chainId only to key the effect. See the note below.
 *
 * 🇪🇸 NOTA: opcional porque `connect.html` no lo tiene. Esa ventana enseña
 * saldos para ayudar a elegir cuenta, vive como mucho 60 s y no muestra ninguna
 * red, así que no hay nada en pantalla que un cambio de red dejara mintiendo. El
 * popup sí lo pasa, y ahí es donde importa.
 */
export function useBalances(addresses: Address[], chainId?: Hex): BalancesState {
  const [balances, setBalances] = useState<Record<Address, Hex>>({});
  const [error, setError] = useState<RpcError | null>(null);
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  /**
   * 🇪🇸 NOTA: la dependencia es la cadena, no el array. `snapshot.accounts` es
   * un array nuevo en cada render, así que depender de él reiniciaría el
   * setInterval en cada render y el polling no llegaría a dispararse nunca.
   */
  /**
   * 🇪🇸 NOTA: el chainId entra en la clave desde la Fase 8. Sin él, cambiar de
   * red no reinicia el sondeo: el intervalo sigue corriendo y los saldos de la
   * red anterior se quedan en pantalla hasta el siguiente tick — cinco segundos
   * enseñando el saldo de otra cadena junto al nombre de la nueva. Y si la red
   * nueva no responde, el error tampoco aparece hasta entonces.
   */
  const key = `${chainId ?? ""}:${addresses.join(",")}`;

  useEffect(() => {
    if (addresses.length === 0) {
      setIsInitialLoad(false);
      return;
    }

    const poller = createBalancePoller(() => callBackground("wallet_getBalances", { addresses }), {
      onBalances(next) {
        setBalances(next);
        setError(null);
        setIsInitialLoad(false);
      },
      onError(next) {
        // 🇪🇸 NOTA: `balances` NO se toca. Con Anvil apagado la lista de cuentas
        // sigue mostrando los últimos saldos buenos junto al aviso, en vez de
        // vaciarse y parecer que la wallet se ha roto.
        setError(next);
        setIsInitialLoad(false);
      },
    });

    void poller.poll();
    const timer = setInterval(() => void poller.poll(), BALANCE_POLL_INTERVAL_MS);

    return () => {
      poller.stop();
      clearInterval(timer);
    };
    // `addresses` is intentionally absent: `key` is its stable identity.

  }, [key]);

  return { balances, error, isInitialLoad };
}
