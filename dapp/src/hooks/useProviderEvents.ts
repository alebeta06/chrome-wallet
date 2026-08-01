"use client";

import { useEffect, useState } from "react";

import { PROVIDER_EVENTS, type EIP1193Provider } from "@/types/eip1193";

export interface LoggedEvent {
  id: number;
  at: string;
  name: string;
  data: unknown;
}

const MAX_EVENTS = 50;

/**
 * Subscribes to every EIP-1193 event of the selected provider.
 *
 * 🇪🇸 NOTA: hasta la Fase 5 esto no recibe nada — no hay permisos por origen ni
 * cambio de red desde la dApp, así que la wallet no tiene a quién emitir. Se
 * cablea igual, y no por adelantarse: un canal que se conecta el día que hay
 * algo que mandar es un canal que nunca se ha probado. Con esto montado, la
 * comprobación manual de la Fase 3 —disparar un CODECRYPTO_TAB_EVENT a mano
 * desde la consola del service worker— tiene dónde aterrizar hoy.
 */
export function useProviderEvents(provider: EIP1193Provider | null): LoggedEvent[] {
  const [events, setEvents] = useState<LoggedEvent[]>([]);

  useEffect(() => {
    if (provider === null) return;

    // A fresh provider means a fresh log: events from the previous wallet would
    // be misleading sitting under a different name.
    setEvents([]);

    let nextId = 0;

    /**
     * 🇪🇸 NOTA: hay que guardar la referencia EXACTA que se pasó a `on` para
     * poder quitarla luego. Registrar una flecha nueva en el cleanup no quita
     * nada, y cada cambio de wallet dejaría un listener vivo apuntando a un
     * `setEvents` de un render viejo.
     */
    const registered = PROVIDER_EVENTS.map((name) => {
      const listener = (data: unknown) => {
        setEvents((current) =>
          [
            ...current,
            { id: nextId++, at: new Date().toLocaleTimeString(), name, data },
          ].slice(-MAX_EVENTS),
        );
      };

      provider.on(name, listener);
      return { name, listener };
    });

    return () => {
      for (const { name, listener } of registered) {
        provider.removeListener(name, listener);
      }
    };
  }, [provider]);

  return events;
}
