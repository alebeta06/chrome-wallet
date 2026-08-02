import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "CodeCrypto Wallet — test dApp",
  description:
    "Test dApp for the CodeCrypto Wallet Chrome extension: EIP-6963 discovery and the public EIP-1193 surface.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    /**
     * 🇪🇸 NOTA: el atributo que provoca el aviso lo escribe NUESTRA PROPIA
     * extensión, no un script ajeno. Su content script pone
     * `data-cc-provider-uuid` en `document.documentElement` como parte del
     * handoff del uuid de EIP-6963 (Fase 3): el uuid tiene que ser estable por
     * instalación, así que vive en `cc:providerUuid` y lo genera el service
     * worker — pero `inject.ts` corre en el mundo de la página y no tiene acceso
     * a ningún `chrome.*`, así que el uuid le llega por un atributo del DOM más
     * un CustomEvent. Ver `extension/src/content-script.ts`.
     *
     * Consecuencia: el servidor renderiza `<html lang="en">` y el cliente, al
     * hidratar, ya tiene el atributo puesto. React ve dos HTML distintos y avisa.
     *
     * `suppressHydrationWarning` es la vía OFICIAL de React para exactamente
     * este caso —el DOM modificado desde fuera antes de hidratar— y no es un
     * silenciador general: solo afecta a ESTE elemento y **no se propaga a los
     * hijos**, así que cualquier desajuste real dentro de la página se sigue
     * reportando. Ponerlo en `<body>` o más abajo sí taparía bugs de verdad.
     */
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
