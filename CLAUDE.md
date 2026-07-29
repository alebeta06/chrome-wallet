# CodeCrypto Wallet — Chrome Extension (MV3)

Wallet de Ethereum como extensión de Chrome. Práctica del Máster CodeCrypto.
Proyecto de 11 fases. Sin smart contracts en el alcance.

## Regla inmutable

`extension/src/types/messages.ts` es el contrato de mensajería del proyecto
(su "ABI"). **NO se edita, no se reescribe, no se proponen cambios.** Todo el
código se escribe contra sus tipos. Si algo parece necesitar un cambio ahí,
para y pregunta antes de tocarlo.

## Arquitectura — la regla de oro

El mnemonic y las claves privadas viven **únicamente en el service worker**
(`background.ts`). El popup, `connect.html` y `notification.html` son solo UI:
mandan mensajes RPC y muestran resultados. Nunca importan `ethers`, nunca
derivan una wallet, nunca firman.

Modelo de cuenta: **por origen**. Cada dApp conectada tiene su propia cuenta.
`accountsChanged` se emite solo al origen afectado; `chainChanged` es global.

## Stack fijado

- Vite 7.3.6 (Rollup, `build.rollupOptions`) · React 19 · TypeScript 5.9.3 strict
- pnpm · ethers.js v6 (solo en `background.ts`)
- Prohibido: viem, web3.js, @scure/bip39, @noble/* directo
- Prohibido: `fetch`/`axios` para RPC (todo vía `ethers.JsonRpcProvider`)
- Prohibido: cargar ethers desde CDN (viola la CSP de MV3)

## Build — no tocar sin discutirlo

Tres pasadas: una ESM (HTML + background) y una IIFE por cada script clásico
(`content-script`, `inject`). Chrome los carga como scripts clásicos: si el
bundle emite `import`/`export`, fallan en runtime.

Verificación obligatoria tras cualquier cambio de build:
`grep -E '^\s*(import|export)\s' dist/content-script.js dist/inject.js` → vacío.

Los tres scripts de extensión solo importan de `types/messages.ts` y de
utilidades puras sin estado. Nada con estado a nivel de módulo: cada pasada
IIFE lo inlinearía por separado y tendrías dos instancias.

## Convenciones de código

- TypeScript strict. `noUncheckedIndexedAccess` está desactivado → validar
  índices de array explícitamente contra `.length` antes de indexar.
- JSDoc en inglés. Notas pedagógicas con prefijo `🇪🇸 NOTA:` en español.
- `data-testid` en **todos** los elementos interactivos, desde el inicio.
- Errores del provider: códigos EIP-1193 estándar (ver `ErrorCode` en
  `messages.ts`), nunca `new Error()` genérico cruzando un boundary.
- Solicitudes pendientes: persistir en `chrome.storage.local`, nunca solo en
  un `Map` en memoria (el service worker se duerme a los ~30 s).

## Git

- Conventional Commits en inglés, atómicos por unidad lógica
- **Sin** trailers `Co-Authored-By`
- **Nunca** auto-push. El push lo hace Alejandro desde su terminal.
- Rama única: `main`

## Modo de trabajo

- Manual-approve. Proponer estructura y estrategia en texto antes de escribir.
- Investigar y verificar antes de asumir (docs, `curl`, no memoria).
- Pausar al primer fallo de test o build y diagnosticar antes de seguir.
