"use client";

import { useEffect, useState } from "react";

import { useProviders } from "@/hooks/useProviders";
import { CODECRYPTO_RDNS } from "@/types/eip1193";

/** How long to wait before calling it: an announcement is milliseconds away. */
const VERDICT_AFTER_MS = 800;

/**
 * Reports whether the wallet reached this frame.
 *
 * 🇪🇸 NOTA: hace falta un temporizador porque la ausencia de un anuncio no es un
 * evento — nadie dispara "no estoy aquí". Sin él, la página se quedaría para
 * siempre en "comprobando…" cuando la wallet NO está inyectada, que es
 * justamente el caso que hay que poder distinguir de un fallo.
 */
export function FrameProbe() {
  const providers = useProviders();
  const [decided, setDecided] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDecided(true), VERDICT_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  const ours = providers.find((entry) => entry.info.rdns === CODECRYPTO_RDNS);

  if (ours !== undefined) {
    return (
      <p className="frame-probe ok" data-testid="frame-status">
        Provider present inside this iframe ✓ — {ours.info.name}
      </p>
    );
  }

  if (!decided) {
    return (
      <p className="frame-probe muted" data-testid="frame-status">
        Checking for an announcement…
      </p>
    );
  }

  return (
    <p className="frame-probe bad" data-testid="frame-status">
      No CodeCrypto provider in this iframe ✗
      {providers.length > 0 && ` (${providers.length} other wallet(s) did announce)`}
    </p>
  );
}
