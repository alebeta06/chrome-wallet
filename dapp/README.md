# CodeCrypto Wallet — test dApp

Una dApp Next.js que consume el provider de la extensión **desde fuera**, como
lo haría cualquier web. Sustituye a la `extension/test.html` de la Fase 3, que
era estática y desechable.

```bash
pnpm install
pnpm dev        # http://localhost:3000
```

Para desplegarla, ver [`../docs/DEPLOY.md`](../docs/DEPLOY.md).

---

## La pregunta que surge siempre: ¿y el mixed content?

> *"La dApp está en Vercel por HTTPS y Anvil escucha en `http://localhost:8545`.
> ¿No debería el navegador bloquear eso?"*

Bloquearía, **si la página hiciera esa petición**. No la hace. Nunca toca el RPC.

```
  dapp (https://…vercel.app)          ← contexto seguro
      │
      │  window.codecrypto.request({ method: "eth_getBalance" })
      ▼
  inject.js        (mundo de la página)
      │  window.postMessage
      ▼
  content-script.js (mundo aislado)
      │  chrome.runtime.sendMessage
      ▼
  background.js    (service worker, origen chrome-extension://)
      │
      │  ← ESTA es la única petición de red, y sale de la extensión
      ▼
  http://localhost:8545
```

La política de mixed content se aplica al **contexto de seguridad de quien hace
la petición**. Quien la hace es el service worker de la extensión, cuyo origen es
`chrome-extension://…`, no la página. Además `http://localhost` está
explícitamente exento del bloqueo por la
[spec de secure contexts](https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy):
se considera *potentially trustworthy* porque no viaja por la red.

Lo que sí hace falta es que la extensión declare el endpoint en
`host_permissions` de su manifest, y ya está declarado:

```jsonc
"host_permissions": [
  "http://localhost:8545/*",
  "https://sepolia.drpc.org/*"
]
```

**Consecuencia práctica:** la dApp desplegada en Vercel funciona contra tu Anvil
local sin ninguna configuración especial y sin túnel. Es la misma arquitectura por
la que MetaMask puede hablar con `localhost` desde una dApp en producción.

---

## Qué sabe esta dApp de la wallet

Lo mismo que sabría de MetaMask: **nada más allá de los estándares públicos.**

- `src/types/eip1193.ts` declara EIP-1193 y EIP-6963. No importa **nada** de
  `extension/`. Ese archivo sería idéntico en una dApp escrita contra cualquier
  otra wallet.
- Lo único específico de este proyecto es una constante, `CODECRYPTO_RDNS`, para
  destacar nuestra wallet en el selector. Es el mismo conocimiento que tiene
  cualquier dApp que escribe `io.metamask`.
- El descubrimiento es **solo** por EIP-6963: nunca se lee `window.codecrypto`
  ni `window.ethereum` directamente. Es lo que permite que convivan varias
  wallets sin pelearse por un global, y probarlo es media razón de que esta
  página exista.

Si mañana la superficie pública de la extensión cambiara, esta dApp se rompería
en runtime — que es exactamente lo que pasaría con una wallet de terceros. El
acoplamiento se ve porque no está escondido detrás de un import.

## Qué hace hoy (Fase 4)

Solo lo que el provider soporta:

| | |
|---|---|
| `eth_chainId` | Devuelve la red activa, con nombre legible |
| `eth_accounts` | Devuelve `[]` — y la página explica por qué |
| `eth_getBalance` | Saldo de la dirección que escribas |
| `eth_requestAccounts` | Responde `4200`; llega en la Fase 5 |
| Panel de eventos | Cableado, vacío hasta la Fase 5 |
| Botón *Connect* | Deshabilitado hasta la Fase 5 |

### Por qué `eth_accounts` devuelve `[]`

Porque este origen no tiene permiso, y lo correcto para un origen no conectado es
un array vacío. Devolver la cuenta activa convertiría la wallet en un
**fingerprint**: cualquier web que visites sabría tu dirección —un identificador
permanente con todo tu historial de transacciones colgando— sin abrir una sola
ventana de confirmación. Las cuentas llegan detrás de `eth_requestAccounts` y de
una aprobación explícita, en la Fase 5.

## Sin ethers

La dApp no tiene ethers como dependencia. Lo único que necesitaba era dividir
entre 10^18, y eso son quince líneas con `BigInt` en `src/lib/format.ts` — que
además es la forma correcta, porque los wei no caben en un `number`. Ethers
entrará en la Fase 7, cuando `verifyTypedData` sea algo que de verdad no se
escribe a mano.

## Tests

```bash
pnpm test:run
```

Cubren lo que se puede sin navegador: el store de descubrimiento EIP-6963 (que
recibe su `EventTarget` por parámetro justo para eso), el mapa de errores, los
formateadores y la tabla de redes. No hay tests de componentes: lo que de verdad
hay que comprobar necesita un navegador con la extensión cargada, y eso es
Playwright en la Fase 10.
