# Comprobaciones manuales en Chrome

Lo que los tests no pueden cubrir: que la extensión cargada de verdad responda
por `chrome.runtime`. Los tests corren contra el código fuente en Node; esto
corre contra el bundle instalado.

Antes de empezar: `pnpm build`, y en `chrome://extensions` → **Load unpacked** →
`extension/dist/`. Si ya estaba cargada, pulsa recargar (↻) después de cada
build; el service worker no se actualiza solo.

## Dónde ejecutar los snippets

En la consola de una **página de la extensión**, no en la de una web. La más
cómoda es `connect.html`:

```
chrome-extension://<TU_ID>/connect.html
```

Copia `<TU_ID>` de la tarjeta en `chrome://extensions`. Abre esa URL en una
pestaña y usa su DevTools (F12).

> 🇪🇸 NOTA: tiene que ser una página de la extensión porque estos métodos son
> **internos**. Desde la consola de una web cualquiera, `sender.tab` está
> definido y el background responde `4100` — que es justamente lo que debe
> hacer. Ver la comprobación 5.

## 1. Importar el mnemonic de Anvil

```js
await chrome.runtime.sendMessage({
  type: 'CODECRYPTO_RPC',
  id: crypto.randomUUID(),
  method: 'wallet_importMnemonic',
  params: [{
    phrase: 'test test test test test test test test test test test junk',
    accountCount: 5,
  }],
})
```

Esperado — `ok: true` y exactamente estas cinco direcciones, en este orden:

```
0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
0x70997970C51812dc3A010C7d01b50e0d17dc79C8
0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
0x90F79bf6EB2c4f870365E785982E1f101E93b906
0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65
```

## 2. Leer el estado

```js
await chrome.runtime.sendMessage({
  type: 'CODECRYPTO_RPC', id: crypto.randomUUID(), method: 'wallet_getState', params: [],
})
```

Esperado: `isLoaded: true`, 5 cuentas, `defaultAccountIndex: 0`,
`chainId: '0x7a69'`, las dos redes por defecto, `activeSite: null`.

**Y sobre todo: ningún `mnemonic` en la respuesta.** El snapshot no lo lleva y
no debe llevarlo nunca.

## 3. Generar una frase nueva sin persistirla

```js
await chrome.runtime.sendMessage({
  type: 'CODECRYPTO_RPC', id: crypto.randomUUID(), method: 'wallet_createMnemonic', params: [],
})
```

Esperado: 12 palabras. Ahora comprueba que **no** se guardó:

```js
await chrome.storage.local.get(null)   // cc:mnemonic sigue siendo el de la comprobación 1
```

## 4. Reset

```js
await chrome.runtime.sendMessage({
  type: 'CODECRYPTO_RPC', id: crypto.randomUUID(), method: 'wallet_reset', params: [],
})
await chrome.storage.local.get(null)
```

Esperado: `result: null`, y en storage ya no están `cc:mnemonic`, `cc:accounts`,
`cc:defaultAccountIndex`, `cc:connectedSites` ni `cc:pendingRequests`.
`cc:chainId` y `cc:logs` **siguen ahí**: el reset borra la wallet, no las
preferencias ni el registro.

## 5. La frontera de confianza (la comprobación que importa)

Abre una web cualquiera — `https://example.com` sirve — y en **su** consola:

```js
await chrome.runtime.sendMessage('<TU_ID>', {
  type: 'CODECRYPTO_RPC', id: crypto.randomUUID(), method: 'wallet_getState', params: [],
})
```

Esperado: error **4100**, no un snapshot.

> Nota: en Fase 1 esto puede fallar antes incluso de llegar al background, porque
> `externally_connectable` no está declarado en el manifest y una página no
> puede hablarle a la extensión por ese canal. Ambos resultados son correctos —
> lo que NO puede pasar es que devuelva el estado.

## 6. El service worker se duerme

Es el fallo número uno de MV3 y conviene verlo una vez:

1. Haz la comprobación 1.
2. Deja `chrome://extensions` abierto y espera a que el service worker pase de
   "activo" a inactivo (~30 s sin actividad).
3. Repite la comprobación 2.

Esperado: sigue devolviendo las 5 cuentas. El worker resucita y **relee todo de
storage**. Si algún día esto devolviera una wallet vacía, es que alguien metió
una caché en una variable de módulo.

---

# Fase 2 — Popup

Requiere `pnpm build` y recargar la extensión (↻) en `chrome://extensions`.
Para los saldos hace falta Anvil:

```bash
anvil    # escucha en http://localhost:8545, chainId 31337 (0x7a69)
```

## 7. Onboarding — crear wallet

Si ya tenías wallet, resetéala antes (comprobación 4 de la Fase 1, o el botón de
la propia UI).

1. Click en el icono de la extensión. Debe verse "No wallet yet".
2. **Create a new wallet** → aparecen 12 palabras numeradas, en monoespaciada.
3. El botón **Create wallet** está deshabilitado. Marca el checkbox → se activa.
4. Confirma. Aparece la lista de 5 cuentas.

Comprueba que la frase **no** quedó en ningún sitio del lado de la UI. En la
consola del popup:

```js
sessionStorage.length   // 0
localStorage.length     // 0
```

## 8. Onboarding — importar

Reset, y esta vez **Import an existing wallet**.

1. El contador de palabras reacciona al escribir: con 3 palabras dice
   "3 words. A recovery phrase has 12, 15, 18, 21 or 24" y el botón está
   deshabilitado.
2. Pulsa **Use the public Anvil dev phrase**. El contador pasa a "12 words" en
   verde y el botón se habilita.
3. Importa → 5 cuentas.

Prueba también el caso que motiva `normalizeMnemonicInput`: pega la frase con un
salto de línea al final y espacios dobles en medio. Debe seguir diciendo
"12 words" e importar sin quejarse.

## 9. Saldos y polling (con Anvil encendido)

- Las 5 cuentas muestran `10000.0000 ETH`.
- La primera cuenta es la marcada como `default`.
- El badge de red dice "Anvil Local" con el punto verde.

Para ver el refresco de 5 s, mueve fondos por fuera y espera sin tocar nada:

```bash
cast send 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 \
  --value 1ether --private-key \
  0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --rpc-url http://localhost:8545
```

En menos de 5 segundos, y sin interactuar con el popup, la cuenta 0 debe bajar y
la 1 subir. En la pestaña Network de DevTools se ve una petición cada 5 s.

**Y lo que confirma que el polling vive en el popup:** cierra el popup y mira la
pestaña Network del service worker. Las peticiones paran. Nadie está mirando el
saldo, así que no se consulta.

## 10. Red caída (Anvil apagado)

Con el popup abierto, para Anvil (`Ctrl-C`). En menos de 5 s:

- Aparece el banner "Cannot reach Anvil Local. Balances may be out of date."
- El punto del badge de red se pone rojo.
- **Las 5 cuentas siguen ahí**, con los últimos saldos buenos.
- Copiar una dirección sigue funcionando; cambiar la cuenta por defecto también.

Nada de pantalla en blanco y nada de lista vacía: la wallet sin nodo sigue siendo
una wallet, solo que sin saldos.

Vuelve a arrancar Anvil → el banner desaparece solo en el siguiente ciclo.

## 11. Cuenta por defecto

Click en otra cuenta → la marca `default` se mueve y el borde violeta también.

Comprueba la asimetría del modelo por origen (la mitad que ya existe):

```js
await chrome.storage.local.get(null)
```

Solo debe haber cambiado `cc:defaultAccountIndex`. `cc:connectedSites` no se
toca — la cuenta por defecto es preferencia interna y ninguna dApp se entera.

## 12. Persistencia entre aperturas

Cierra el popup y vuelve a abrirlo. Debe mostrar directamente las cuentas, sin
pedir la frase y sin pasar por el onboarding.

Repítelo después de que el service worker se duerma (~30 s): el resultado es el
mismo, porque el estado se relee de storage en cada petición.

---

# Fase 3 — Provider inyectado y EIP-6963

Requiere `pnpm build` y recargar la extensión (↻) en `chrome://extensions`.
Además hacen falta Anvil y la dApp:

```bash
anvil                       # http://localhost:8545, chainId 31337

# en otra terminal:
cd dapp && pnpm dev         # → http://localhost:3000
```

> 🇪🇸 NOTA: **por HTTP, nunca por `file://`.** Con `file://` el origin es `null`,
> un origen opaco. En la Fase 5 los permisos se guardan POR ORIGEN, así que
> probar contra un origen opaco daría por buenas cosas que no lo son.

Estas comprobaciones se hacían contra `extension/test.html`, una página estática
que se borró en la Fase 4. Ahora se hacen contra la dApp, en **dos orígenes**:

| | |
|---|---|
| Local | http://localhost:3000 |
| Producción | **https://chrome-wallet.vercel.app** |

Conviene pasarlas por los dos. Son orígenes distintos, y en la Fase 5 eso deja de
ser un detalle: cada uno tendrá su propia cuenta conectada, y ésa es la mitad
interesante del modelo por origen. Ver [`docs/DEPLOY.md`](../../docs/DEPLOY.md).

## 13. El content script llega hasta la página (empieza por aquí)

Lo que importa es que la página cae dentro de `<all_urls>` y recibe el content
script. Si esto falla, todo lo demás de la lista es ruido.

Abre `http://localhost:3000` y en **su** consola:

```js
window.codecrypto        // objeto, no undefined
window.codecrypto.isCodeCrypto   // true
window.codecrypto.isMetaMask     // false
```

Y en el log de la consola tiene que estar:

```
[codecrypto] content script loaded at http://localhost:3000
```

> `isMetaMask: false` es deliberado. Mentir ahí rompe las dApps que ramifican
> por ese flag, y es deshonesto.

> 🇪🇸 NOTA: que la dApp lea `window.codecrypto` desde la consola es una
> comprobación de diagnóstico, no lo que hace la página. **La dApp descubre la
> wallet solo por EIP-6963** — leer el global directamente es justo lo que
> EIP-6963 existe para evitar.

## 14. La wallet aparece por EIP-6963, con su icono

En la sección 1 de la dApp, la tarjeta **CodeCrypto Wallet** con:

- El **icono renderizado**, no un cuadro roto. Es la comprobación real de que el
  data URI es un SVG válido: los selectores multi-wallet lo meten en un `<img>`.
- `academy.codecrypto.wallet` como rdns.
- La etiqueta *this project*.
- En la sección 2, un uuid con forma de UUIDv4.

Pulsa **Re-dispatch eip6963:requestProvider**: la tarjeta sigue ahí y **no se
duplica**, y el contador sigue diciendo el mismo número. Eso comprueba dos cosas
a la vez — el segundo de los dos anuncios (el que atiende a las dApps que montan
su selector más tarde) y la deduplicación del store.

## 15. Los métodos públicos

| Botón | Esperado |
|---|---|
| `eth_chainId` | `Anvil Local · 31337 · 0x7a69` — nombre legible, no solo el hex |
| `eth_accounts` | `[]` — **array vacío, con la wallet cargada y con cuentas** |
| `eth_getBalance` sobre `0xf39Fd…92266` | `10000.0000 ETH` con Anvil recién arrancado |
| Escribir una dirección malformada | El botón se deshabilita y la dApp lo explica, **sin llegar a preguntarle a la wallet** |

Con Anvil apagado, `eth_getBalance` tiene que dar **4901** con el texto "cannot
reach that network's RPC endpoint" — no un `-32603` genérico ni un JSON crudo.
Es la prueba de que el mapa de errores de la dApp hace su trabajo.

> 🇪🇸 NOTA: el `[]` de `eth_accounts` es el ítem de la rúbrica, no un "todavía no
> está implementado". Devolver la cuenta activa a un origen no conectado
> convierte la wallet en un **fingerprint**: cualquier web que visites sabría tu
> dirección sin pedir permiso y sin abrir una ventana. Las cuentas llegan en la
> Fase 5, detrás de `eth_requestAccounts` y de `connect.html`.

## 16. Un método público sin implementar da 4200, no 4100

Botón **eth_requestAccounts**. Esperado: error con `code: 4200`.

Que sea 4200 y no 4100 es lo que se comprueba: 4100 significaría que la frontera
de confianza está rechazando métodos públicos y ninguna dApp podría hablar con la
wallet. 4200 significa "pasaste el control, esto aún no existe" — llega en la
Fase 5.

## 17. El provider existe dentro de un iframe (spec 34)

La sección 5 de la dApp embebe la ruta `/frame`. Tiene que decir en verde:

```
Provider present inside this iframe ✓ — CodeCrypto Wallet
```

Es lo que cubren `all_frames: true` y `match_about_blank: true` del manifest: hay
dApps que viven dentro de un iframe, y una wallet que solo se inyecta en el frame
principal no existe para ellas.

> 🇪🇸 NOTA: el mensaje de "no provider" solo aparece tras 800 ms de espera. La
> ausencia de un anuncio no es un evento —nadie dispara "no estoy aquí"— así que
> sin ese temporizador la página se quedaría en "checking…" para siempre justo en
> el caso que hay que poder distinguir.

## 18. El uuid es estable entre recargas

Apunta el uuid de la sección 2. Recarga la página **dos veces** (F5). Tiene que
ser **el mismo** las tres veces.

```js
await chrome.storage.local.get('cc:providerUuid')   // en la consola de la extensión
```

> 🇪🇸 NOTA: si cambiara en cada carga, la dApp vería una wallet distinta cada vez
> y un selector multi-wallet acumularía entradas duplicadas de la misma
> extensión. Por eso lo genera el service worker una sola vez y vive en storage:
> hay un content script por pestaña, y varias pestañas abriéndose a la vez
> generarían uuids distintos.

## 19. Convivencia con MetaMask

Con MetaMask (u otras wallets) instaladas y habilitadas, recarga la dApp:

- La sección 1 lista **todas** las wallets, cada una con su icono y su rdns.
- El contador dice cuántas anunciaron.
- Solo CodeCrypto lleva la etiqueta *this project*.
- Se puede pulsar cualquiera y los métodos de la sección 3 van contra ella.
- **Cero errores de `window.ethereum` en la consola.**

Lo último es consecuencia de una decisión: `inject.ts` no toca `window.ethereum`
en absoluto. Pelearse por esa propiedad es como las wallets se rompen entre
ellas, y el que pierde siempre es el usuario delante de una dApp que no conecta.

> 🇪🇸 NOTA: probar con otra wallet seleccionada no es un extra. Que
> `eth_chainId` funcione contra MetaMask demuestra que la dApp está escrita
> contra EIP-1193 y no contra las particularidades de esta wallet — que es la
> razón de que `dapp/` no importe nada de `extension/`.

## 20. El relay de eventos y el cerrojo del origen

Todavía no hay nada que emita eventos — `wallet_setSiteAccount` es Fase 5 y
`wallet_setActiveNetwork` es Fase 8 — así que el relay se prueba disparando uno a
mano.

En `chrome://extensions` → tarjeta de la extensión → **service worker**, en su
consola:

```js
const [tab] = await chrome.tabs.query({ url: 'http://localhost:3000/*' })

// (a) evento GLOBAL: expectedOrigin null, va a cualquier origen conectado
await chrome.tabs.sendMessage(tab.id, {
  type: 'CODECRYPTO_TAB_EVENT', eventName: 'chainChanged',
  data: '0xaa36a7', expectedOrigin: null,
})

// (b) evento por ORIGEN, con el origen correcto
await chrome.tabs.sendMessage(tab.id, {
  type: 'CODECRYPTO_TAB_EVENT', eventName: 'accountsChanged',
  data: ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'],
  expectedOrigin: 'http://localhost:3000',
})

// (c) el mismo, con el origen EQUIVOCADO
await chrome.tabs.sendMessage(tab.id, {
  type: 'CODECRYPTO_TAB_EVENT', eventName: 'accountsChanged',
  data: ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'],
  expectedOrigin: 'https://evil.example',
})
```

Esperado en el panel de eventos de la página: llegan **(a)** y **(b)**, y **(c)
no llega**.

> 🇪🇸 NOTA: (c) es el test que importa. Los tabId se reciclan, y si una pestaña
> navega de la dApp A a la dApp B justo entre el `chrome.tabs.query` y el
> `sendMessage`, el evento aterriza en el sitio equivocado y le filtras a B qué
> cuenta usas en A. Es una ventana de milisegundos y una fuga real; la
> comprobación es de una línea y vive en el content script.

## 21. El registro de actividad (base de las specs 13-16)

Después de haber pulsado unos cuantos botones en la dApp, en la consola de una
página de la extensión:

```js
(await chrome.storage.local.get('cc:logs'))['cc:logs']
```

Esperado:

- Una entrada `call` por cada llamada, con `origin: 'http://localhost:3000'`.
- Una entrada `error` extra detrás de cada llamada que falló (el 4200 de
  `eth_requestAccounts`, el 4901 con Anvil apagado).
- Si has probado también contra la URL de Vercel, sus entradas llevan **ese**
  origin y no el de localhost — que es la primera señal visible de que el modelo
  por origen de la Fase 5 tiene con qué trabajar.
- **Ninguna entrada del polling de saldos del popup.** Abre el popup, déjalo
  medio minuto, ciérralo y vuelve a mirar: el registro no ha crecido.

Lo último es deliberado. El popup consulta saldos cada 5 s; con
`MAX_LOG_ENTRIES = 500` —y ese número está en el contrato inmutable— cuarenta
minutos de popup abierto barrerían el registro entero y enterrarían justo lo que
las specs 13-16 quieren ver.

La UI que pinta todo esto es la Fase 9. Aquí solo se acumula.
