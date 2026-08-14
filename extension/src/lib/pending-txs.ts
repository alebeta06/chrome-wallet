/**
 * @file lib/pending-txs.ts
 * @description Transactions that were broadcast and have not been accounted for.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS: `await tx.wait()` IS THE MV3 BUG IN DISGUISE
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: esperar el recibo en el service worker es exactamente "guarda una
 * promesa y espera", que es el bug número uno de MV3. En Sepolia una
 * confirmación son 12-15 segundos y Chrome mata el worker a los ~30 de
 * inactividad, así que la notificación de minado no llegaría prácticamente
 * nunca — y no fallaría: simplemente no aparecería.
 *
 * Lo que sobrevive a la muerte del worker es storage. Se anota el hash al
 * difundir, y al DESPERTAR se le pregunta al nodo por el recibo. La espera deja
 * de estar en memoria y pasa a estar en disco.
 *
 * ---------------------------------------------------------------------------
 * ITS OWN CHAIN, LIKE EVERY OTHER OWNER
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: `cc:pendingTxs` es un Record entero en una clave, así que dar de alta
 * y quitar son read-modify-write. La cadena es SUYA —no la de aprobaciones ni la
 * de logs— porque son datos distintos: una cadena compartida solo conseguiría
 * que un alta esperase detrás de una escritura con la que no comparte nada.
 * Ver `serialize.ts` para el mecanismo y, sobre todo, para lo que NO cubre.
 */

import {
  pendingTxKey,
  type Hex,
  type NetworkConfig,
  type Origin,
  type PendingTx,
} from "@/types/messages";

import type { ReceiptReader } from "./chain";
import { createLogEntry, type LogWriter } from "./logs";
import type { Notifier } from "./notifications";
import { createSerializer } from "./serialize";
import type { WalletStorage } from "./storage";

/**
 * How long the wallet keeps asking about a transaction nobody mined.
 *
 * 🇪🇸 NOTA: una hora. Más allá de eso, seguir preguntando en cada despertar es
 * gastar llamadas para siempre por algo que casi con seguridad se cayó de la
 * mempool. El límite es arbitrario; lo que no es arbitrario es que al rendirse
 * quede escrito (ver `stopTracking`).
 */
export const MAX_PENDING_TX_AGE_MS = 60 * 60 * 1000;

export interface PendingTxStore {
  /** Records a broadcast transaction. Idempotent by `${chainId}:${hash}`. */
  track(entry: PendingTx): Promise<void>;
  /** Everything still being watched. */
  read(): Promise<PendingTx[]>;
  /**
   * Asks the chain about every pending transaction and acts on the answers.
   * Resolves with how many are STILL pending afterwards, which is what the
   * caller needs to decide whether the alarm has any reason to keep running.
   */
  reconcile(): Promise<number>;
}

export interface PendingTxDeps {
  storage: WalletStorage;
  logs: LogWriter;
  notifier: Notifier;
  readReceipt: ReceiptReader;
  /** Resolves the network to ask, or null if the user deleted it. */
  networkFor(chainId: Hex): Promise<NetworkConfig | null>;
  now?: () => number;
}

/** What one reconciliation decided about one transaction. */
type Outcome = "pending" | "confirmed" | "reverted" | "abandoned";

export function createPendingTxStore({
  storage,
  logs,
  notifier,
  readReceipt,
  networkFor,
  now = () => Date.now(),
}: PendingTxDeps): PendingTxStore {
  const serialize = createSerializer();

  async function readAll(): Promise<Record<string, PendingTx>> {
    return (await storage.get("cc:pendingTxs")) ?? {};
  }

  function track(entry: PendingTx): Promise<void> {
    return serialize(async () => {
      const all = await readAll();
      await storage.set("cc:pendingTxs", {
        ...all,
        [pendingTxKey(entry.chainId, entry.hash)]: entry,
      });
    });
  }

  function forget(key: string): Promise<void> {
    return serialize(async () => {
      const all = await readAll();
      if (all[key] === undefined) return;

      const next = { ...all };
      delete next[key];
      await storage.set("cc:pendingTxs", next);
    });
  }

  async function read(): Promise<PendingTx[]> {
    return Object.values(await readAll());
  }

  async function note(
    label: string,
    entry: PendingTx,
    extra: Record<string, string | number> = {},
  ): Promise<void> {
    try {
      await logs.append(
        createLogEntry("operation", label, entry.origin, {
          hash: entry.hash,
          chainId: entry.chainId,
          accountIndex: entry.accountIndex,
          ...extra,
        }),
      );
    } catch (cause) {
      console.error("[codecrypto] could not log a transaction outcome:", cause);
    }
  }

  /**
   * ------------------------------------------------------------------------
   * GIVING UP IS NOT THE SAME AS FAILING, AND THE WORDING CARRIES THAT
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: "stopped tracking", nunca "failed". Lo que ha ocurrido es que la
   * WALLET deja de mirar, no que la transacción haya fallado: puede seguir en la
   * mempool y minarse mañana, y en ese caso el usuario tendrá fondos movidos y
   * un registro que dijo que falló. Escribir "failed" aquí sería afirmar algo
   * que no sabemos.
   *
   * Y deja línea en vez de desaparecer en silencio, que era la otra opción. Una
   * transacción que estuvo una hora sin minarse y se esfuma del registro es
   * exactamente lo que alguien querría poder reconstruir después.
   *
   * Sin notificación: al usuario no le ha pasado nada nuevo. Avisarle de que la
   * wallet dejó de mirar suena a fallo y no lo es.
   */
  async function stopTracking(entry: PendingTx, waitedMs: number): Promise<void> {
    await note("stopped tracking transaction", entry, {
      waitedMinutes: Math.round(waitedMs / 60_000),
    });
  }

  async function resolveOne(entry: PendingTx, at: number): Promise<Outcome> {
    const key = pendingTxKey(entry.chainId, entry.hash);
    const network = await networkFor(entry.chainId);

    /**
     * 🇪🇸 NOTA: sin red no hay a quién preguntar —el usuario borró esa red del
     * catálogo—. No se descarta por eso: se deja envejecer, y el descarte por
     * antigüedad dejará su línea. Tirarla aquí en silencio perdería el rastro
     * justo en el caso donde más raro es lo que pasó.
     */
    /**
     * ------------------------------------------------------------------------
     * THREE WAYS OF NOT KNOWING, AND THEY END UP IN THE SAME PLACE
     * ------------------------------------------------------------------------
     * 🇪🇸 NOTA: no se sabe nada de esta transacción si (a) su red ya no está en el
     * catálogo, (b) el nodo no contesta, o (c) el nodo contesta que aún no la
     * conoce. Las tres caen abajo, al descarte por antigüedad, y eso es
     * deliberado: si el fallo del RPC saltara el descarte, un endpoint muerto
     * dejaría entradas creciendo para siempre — que es exactamente lo que el
     * descarte existe para impedir.
     *
     * Lo que NO cambia es el silencio: ninguna de las tres escribe ni avisa
     * mientras la hora no se cumpla. Un parpadeo del RPC no es información sobre
     * la transacción, y castigarlo con una línea sería la misma confusión que la
     * Fase 8 evitó con el nodo caído.
     */
    if (network !== null) {
      let receipt: Awaited<ReturnType<ReceiptReader>> = null;

      try {
        receipt = await readReceipt(network, entry.hash);
      } catch {
        receipt = null;
      }

      if (receipt !== null) {
        const confirmed = receipt.status === 1;

        await notifier.announceTransaction(entry.hash, confirmed);
        await note(confirmed ? "transaction confirmed" : "transaction reverted", entry, {
          blockNumber: receipt.blockNumber,
        });
        await forget(key);

        return confirmed ? "confirmed" : "reverted";
      }
    }

    if (at - entry.sentAt >= MAX_PENDING_TX_AGE_MS) {
      await stopTracking(entry, at - entry.sentAt);
      await forget(key);
      return "abandoned";
    }

    return "pending";
  }

  async function reconcile(): Promise<number> {
    const at = now();
    const entries = await read();
    if (entries.length === 0) return 0;

    const outcomes = await Promise.all(entries.map((entry) => resolveOne(entry, at)));

    return outcomes.filter((outcome) => outcome === "pending").length;
  }

  return { track, read, reconcile };
}

/** Builds the entry from what the broadcasting point already has. */
export function pendingTxFrom(input: {
  hash: Hex;
  chainId: Hex;
  accountIndex: number;
  origin?: Origin;
  sentAt: number;
}): PendingTx {
  const entry: PendingTx = {
    hash: input.hash,
    chainId: input.chainId,
    sentAt: input.sentAt,
    accountIndex: input.accountIndex,
  };
  if (input.origin !== undefined) entry.origin = input.origin;
  return entry;
}
