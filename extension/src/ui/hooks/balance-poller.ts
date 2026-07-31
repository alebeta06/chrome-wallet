/**
 * @file ui/hooks/balance-poller.ts
 * @description The "latest response wins" rule, extracted from React.
 *
 * 🇪🇸 NOTA: esto vive fuera del hook a propósito, y no es por elegancia. Contra
 * Anvil todas las respuestas llegan en milisegundos y en orden, así que ni las
 * pruebas manuales ni un test de navegador ejercitan jamás el caso que importa.
 * El único sitio donde se puede provocar de verdad —tres peticiones en vuelo que
 * vuelven desordenadas— es un test unitario que controle cuándo resuelve cada
 * promesa, y para eso la coordinación tiene que ser código sin React dentro.
 */

import type { Address, Hex } from "@/types/messages";
import { toRpcError, type RpcError } from "@/ui/rpc";

export interface BalancePollerHandlers {
  onBalances(balances: Record<Address, Hex>): void;
  onError(error: RpcError): void;
}

export interface BalancePoller {
  /** Runs one read. A response older than one already handled is dropped. */
  poll(): Promise<void>;
  /** After this no handler fires again, whatever is still in flight. */
  stop(): void;
}

export function createBalancePoller(
  read: () => Promise<Record<Address, Hex>>,
  handlers: BalancePollerHandlers,
): BalancePoller {
  let issued = 0;
  let newestHandled = 0;
  let stopped = false;

  /**
   * 🇪🇸 NOTA: un booleano `cancelled` no basta. Con intervalo de 5 s y una
   * petición que tarda 12, hay tres en vuelo a la vez y pueden volver en
   * cualquier orden. Un contador es lo que permite decir "esta respuesta es
   * anterior a una que ya pinté" y tirarla.
   *
   * Y aplica igual a los FALLOS: si la petición #2 va bien y luego falla la #1,
   * que llegó antes, mostrar su error borraría un dato correcto por uno viejo.
   */
  function isStale(ticket: number): boolean {
    return stopped || ticket <= newestHandled;
  }

  return {
    async poll(): Promise<void> {
      const ticket = ++issued;
      try {
        const balances = await read();
        if (isStale(ticket)) return;
        newestHandled = ticket;
        handlers.onBalances(balances);
      } catch (cause) {
        if (isStale(ticket)) return;
        newestHandled = ticket;
        handlers.onError(toRpcError(cause));
      }
    },

    stop(): void {
      stopped = true;
    },
  };
}
