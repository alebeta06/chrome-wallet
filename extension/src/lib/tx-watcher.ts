/**
 * @file lib/tx-watcher.ts
 * @description When the wallet asks the chain about its pending transactions.
 *
 * `pending-txs.ts` decides WHAT to do with an answer. This decides WHEN to ask,
 * which is a different problem with a different failure mode: getting it wrong
 * does not produce a wrong answer, it produces no answer at all.
 */

import type { PendingTxStore } from "./pending-txs";

/** What this module uses from chrome.alarms, and nothing more. */
export interface AlarmsPort {
  create(name: string, info: { periodInMinutes: number }): Promise<void>;
  clear(name: string): Promise<void>;
}

export const TX_ALARM = "codecrypto:pending-txs";

/**
 * ---------------------------------------------------------------------------
 * 0.5, AND THE NUMBER IS MEASURED, NOT REMEMBERED
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: el mínimo de `chrome.alarms` son TREINTA SEGUNDOS, no un minuto.
 * Literal de la documentación oficial de Chrome:
 *
 *   "Chrome limits alarms to at most once every 30 seconds but may delay them an
 *    arbitrary amount more. That is, setting `delayInMinutes` or
 *    `periodInMinutes` to less than 0.5 will not be honored and will cause a
 *    warning."
 *
 * El minuto era cierto en las primeras versiones de MV3 y dejó de serlo. Se
 * comprobó contra la doc de Chrome y no contra `@types/chrome`, que es un
 * paquete de terceros: es la lección de la comprobación 79 en otro dominio —
 * medir sobre el artefacto correcto.
 *
 * Bajar de 0.5 no acelera nada: Chrome lo ignora y además avisa por consola.
 */
export const TX_ALARM_PERIOD_MINUTES = 0.5;

/**
 * ---------------------------------------------------------------------------
 * THE FAST PATH IS BEST EFFORT. IT IS NEVER THE MECHANISM.
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: Anvil mina en un segundo y la alarma no puede bajar de treinta, así
 * que sin esto el aviso de una transacción local llegaría medio minuto tarde.
 *
 * Justo después de difundir, el worker sigue vivo —acaba de trabajar, y Chrome
 * lo mantiene ~30 s tras la última actividad— así que una comprobación diferida
 * de unos segundos suele llegar a tiempo y no cuesta nada.
 *
 * **Y puede no ejecutarse nunca.** Un `setTimeout` NO mantiene vivo al service
 * worker: si Chrome lo suspende antes, el temporizador muere con él y no queda
 * rastro. Por eso es un atajo y no un mecanismo, exactamente igual que la
 * notificación de escritorio: **la alarma es la red**, y todo lo que garantiza
 * que una transacción acabe resuelta pasa por ella.
 *
 * Si alguien necesita alguna vez que esto sea fiable, la respuesta no es alargar
 * el temporizador: es que ya existe la alarma.
 */
export const FAST_PATH_DELAY_MS = 3_000;

export interface TxWatcher {
  /**
   * Asks about everything pending, then leaves the alarm matching reality.
   * Resolves with how many are still pending.
   */
  sweep(): Promise<number>;
  /**
   * There is new work: arm the net now, and take the shortcut as well.
   *
   * 🇪🇸 NOTA: arma la alarma sin reconciliar primero. Preguntar por el recibo de
   * una transacción difundida hace un milisegundo es una llamada garantizada a
   * devolver `null`.
   */
  noteNewWork(): Promise<void>;
  /**
   * There is nothing left to watch: take the alarm down.
   *
   * 🇪🇸 NOTA: existe porque `sweep` no es el único camino que vacía la lista. El
   * RESET la borra entera, y por ahí no pasa ninguna reconciliación — la alarma
   * se quedaba armada vigilando una clave que ya no existe, y solo se enteraba
   * al dispararse otra vez. Un despertar del worker para nada.
   *
   * Colgado del cambio en storage, cubre ese camino y cualquier otro que aparezca
   * después, que es la razón de no llamarlo desde el reset directamente.
   */
  standDown(): Promise<void>;
}

export interface TxWatcherDeps {
  pendingTxs: PendingTxStore;
  alarms: AlarmsPort;
  /** Injected so a test never waits three real seconds. */
  schedule?: (task: () => void, delayMs: number) => void;
}

export function createTxWatcher({
  pendingTxs,
  alarms,
  schedule = (task, delayMs) => {
    setTimeout(task, delayMs);
  },
}: TxWatcherDeps): TxWatcher {
  async function arm(): Promise<void> {
    // create() with the same name replaces, so this is idempotent.
    await alarms.create(TX_ALARM, { periodInMinutes: TX_ALARM_PERIOD_MINUTES });
  }

  /**
   * ------------------------------------------------------------------------
   * NOTHING PENDING MEANS NO ALARM. THAT IS WHAT BOUNDS IT.
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: la alarma se borra en cuanto la lista queda vacía, y ésa es la
   * única razón por la que no queda una corriendo para siempre. Una alarma cada
   * treinta segundos que despierta al worker para no hacer nada es gasto de
   * batería que nadie relaciona nunca con la wallet, porque no se ve.
   */
  async function sweep(): Promise<number> {
    const remaining = await pendingTxs.reconcile();

    if (remaining > 0) await arm();
    else await alarms.clear(TX_ALARM);

    return remaining;
  }

  async function noteNewWork(): Promise<void> {
    await arm();

    schedule(() => {
      void sweep().catch((cause: unknown) => {
        console.error("[codecrypto] the fast path could not sweep:", cause);
      });
    }, FAST_PATH_DELAY_MS);
  }

  async function standDown(): Promise<void> {
    await alarms.clear(TX_ALARM);
  }

  return { sweep, noteNewWork, standDown };
}
