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

---

# Fase 5 — connect.html y permisos por origen

Requiere `pnpm build` + recargar (↻), Anvil, y la dApp en `localhost:3000`.
**Esta fase necesita los dos orígenes**: local y `https://chrome-wallet.vercel.app`.

Empieza con la wallet importada (comprobación 1) y sin sitios conectados.

## 22. Conectar por primera vez

En `http://localhost:3000`, sección 3 → **Connect wallet**.

Se abre `connect.html` en su propia ventana. Comprueba, en este orden:

1. **El origen es lo primero y lo más grande**, en monoespaciada:
   `http://localhost:3000`. Es la única pregunta que el usuario tiene que poder
   contestar antes de dar acceso — un dominio parecido al esperado es la forma
   más barata de phishing que hay.
2. Las 5 cuentas con su saldo, y la **cuenta por defecto preseleccionada**.
3. Elige la **cuenta 2** y pulsa **Connect**.

La ventana se cierra sola y la dApp muestra la píldora verde con
`0x3C44…93BC`. Recarga la página: **sigue conectada y no vuelve a preguntar**.

> 🇪🇸 NOTA: que recargar no pida permiso otra vez no es un atajo. Una wallet que
> abre ventana en cada F5 enseña a la gente a aprobar sin leer, que es
> exactamente la costumbre que hace que el phishing funcione.

## 23. LA COMPROBACIÓN DE LA FASE — dos orígenes, dos cuentas

Sin desconectar nada, abre `https://chrome-wallet.vercel.app` y conéctala a la
**cuenta 4** (`0x15d3…6A65`).

Ahora, en cada pestaña, pulsa `eth_accounts`:

| Origen | Esperado |
|---|---|
| `http://localhost:3000` | `["0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"]` |
| `https://chrome-wallet.vercel.app` | `["0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"]` |

**Direcciones distintas, la misma wallet, a la vez.** Y cada una devuelve
**una sola** cuenta: ninguna de las dos sabe cuántas tienes ni cuáles son las
otras.

Esto es el modelo por origen. Si las dos devolvieran lo mismo, la fase no está
hecha por mucho que todo lo demás funcione.

## 24. `accountsChanged` en vivo, y solo a quien le toca

Deja **las dos pestañas abiertas y visibles** (ventanas lado a lado).

Con la pestaña de localhost enfocada, abre el popup. Tiene que aparecer la
**banda violeta** arriba:

```
THIS SITE SEES
http://localhost:3000
[ 2 · 0x3C44…93BC ▾ ]   Disconnect
```

Cambia el desplegable de la banda a la **cuenta 0**. Sin tocar nada más:

- La pestaña de **localhost** recibe `accountsChanged` en su panel de eventos y
  la píldora pasa a `0xf39F…2266`.
- La pestaña de **Vercel** no recibe nada y sigue en `0x15d3…6A65`.

> 🇪🇸 NOTA: que Vercel no se entere es el punto. Emitir a todos los orígenes
> filtraría a una dApp qué cuenta usas en la otra — y no rompería nada
> visiblemente, solo filtraría.

## 25. La asimetría: la lista de abajo NO emite

En el mismo popup, pulsa una cuenta cualquiera de **la lista de abajo**
(no del desplegable de la banda).

- La marca `default` se mueve.
- **Ninguna de las dos dApps recibe nada.** El panel de eventos no crece.
- La banda de arriba **no cambia**: localhost sigue viendo la cuenta que le
  asignaste.

Esa es la asimetría entera:

| Control | Método | ¿Emite? |
|---|---|---|
| Desplegable de la banda | `wallet_setSiteAccount` | Sí, solo a ese origen |
| Lista de cuentas | `wallet_setDefaultAccount` | No, a nadie |

Si la lista emitiera, la dApp A se enteraría de qué cuenta usas en la dApp B.

## 26. Varias pestañas del mismo origen

Abre **dos** pestañas de `localhost:3000`. Cambia la cuenta del sitio desde el
popup.

**Las dos** tienen que actualizarse. Si solo cambia una, alguien se quedó con
`tabs[0]` en vez de recorrer todas — y la wallet estaría diciendo una cosa
mientras una de las pestañas dice otra.

## 27. Cerrar la ventana con la X

Desconecta localhost, y vuelve a pulsar **Connect wallet**. Cuando se abra
`connect.html`, **ciérrala con la X** sin decidir.

La dApp tiene que recibir **4001** y volver al botón de conectar, sin banner
rojo y sin quedarse colgada.

> 🇪🇸 NOTA: eso lo detecta el puerto keep-alive al caer, no
> `chrome.windows.onRemoved`. El puerto cubre además que la página crashee o
> navegue: en los tres casos muere igual.

Prueba también **Reject**: mismo 4001, misma ausencia de ruido.

## 28. El service worker se duerme con la ventana abierta

El caso que el puerto existe para resolver:

1. Pulsa **Connect wallet**.
2. Con `connect.html` abierta, deja pasar **45–60 s** mirando
   `chrome://extensions`. El service worker **NO** debe pasar a inactivo.
3. Aprueba.

La conexión se completa y la dApp recibe su cuenta. Si el worker se hubiera
dormido, la promesa habría muerto y la dApp se habría comido un 4900.

## 29. Timeout de 60 s

Pulsa **Connect wallet** y no toques nada durante **más de 60 s**.

La ventana se cierra sola y la dApp recibe **4001** con el mensaje de timeout.
Para la dApp es indistinguible de un rechazo, que es lo correcto: en los dos
casos no hay conexión y no hay nada que enseñar.

## 30. Dos peticiones seguidas → una sola ventana

Con localhost desconectado, en su consola:

```js
// Descubre la wallet como lo haría una dApp, por EIP-6963.
const detail = await new Promise((resolve) => {
  window.addEventListener('eip6963:announceProvider', (event) => {
    if (event.detail.info.rdns === 'academy.codecrypto.wallet') resolve(event.detail)
  })
  window.dispatchEvent(new Event('eip6963:requestProvider'))
})

// Dos llamadas seguidas, sin esperar a la primera.
const a = detail.provider.request({ method: 'eth_requestAccounts' })
const b = detail.provider.request({ method: 'eth_requestAccounts' })

// Tras aprobar en la ventana:
console.log(await a, await b)   // la misma cuenta en las dos
```

Se abre **una sola** ventana. Al aprobar, **las dos** promesas se resuelven con
la misma cuenta.

> 🇪🇸 NOTA: no es un caso rebuscado — React en StrictMode monta dos veces en
> desarrollo, así que una dApp llamando dos veces seguidas es lo normal. Dos
> ventanas obligarían a decidir dos veces y dejarían una huérfana.

## 31. Desconectar desde los dos lados

- **Desde la dApp:** botón **Disconnect** (`wallet_revokePermissions`). La
  píldora desaparece, llega `accountsChanged` con `[]`, y `eth_accounts` vuelve
  a `[]`.
- **Desde el popup:** sección **Connected sites** → **Disconnect**. Mismo
  efecto, y el otro origen sigue conectado.

Una dApp solo puede revocarse **a sí misma**: el origen sale del emisor del
mensaje, no de los params, así que no hay forma de pedirlo para otro sitio.

## 32. Reset con sitios conectados

Con los dos orígenes conectados y sus pestañas abiertas, pulsa **Reset** en el
popup.

Las **dos** dApps reciben `accountsChanged` con `[]` a la vez. Sin ese aviso,
cada una seguiría enseñando una cuenta que ya no existe hasta que alguien
recargara — la wallet vacía y la web diciendo que tienes fondos.

## 33. Índice fuera de rango tras reimportar

1. Conecta localhost a la **cuenta 4**.
2. Reset, y reimporta la frase de Anvil con **2 cuentas**.

`eth_accounts` en localhost devuelve **`[]`**, y **Connect wallet** vuelve a
abrir la ventana.

> 🇪🇸 NOTA: acotar a la cuenta 0 habría sido más cómodo y peor. La dApp enseñaba
> "tu cuenta es 0x15d3…" y pasaría a operar como 0xf39F… sin decírselo a nadie.
> Sustituir una identidad en silencio es exactamente el fallo que el modelo por
> origen existe para no tener.
>
> (En la práctica `wallet_reset` ya limpia `cc:connectedSites`, así que para
> forzar el caso hay que editar storage a mano — pero la defensa vale igual.)

## 34. Ninguna web puede aprobarse sola

En la consola de `localhost:3000`, con una conexión pendiente:

```js
chrome.runtime.sendMessage('<TU_ID>', {
  type: 'CODECRYPTO_DECISION', requestId: '<el-id>', kind: 'connect',
  approved: true, accountIndex: 0,
})
```

No debe conectar nada. El background solo acepta decisiones de sus **propias**
páginas; si no, cualquier web se saltaría la ventana entera — que es justo el
permiso que esta fase existe para pedir.

---

# Fase 6 — Firma de transacciones

Requiere `pnpm build` + recargar (↻), Anvil, y la dApp. Empieza con la wallet
importada y `localhost:3000` **conectado a la cuenta 0**.

## 35. Enviar 1 ETH

En la dApp, sección 4: destino `0x7099…79C8`, cantidad `1`, **Send transaction**.

Se abre `notification.html`. Comprueba, en este orden:

1. **El origen arriba y en grande**, igual que en `connect.html`.
2. `From` es la cuenta 0 — la que autorizaste, no otra.
3. `Amount` dice **`1.0000 ETH`**, no `0xde0b6b3a7640000`. Una cantidad en hex
   no es algo que nadie pueda juzgar antes de aprobar.
4. `Gas` y `Max total` con números reales.
5. **No** aparece el aviso rojo de contrato: es una transferencia simple.

Aprueba. La dApp muestra el hash. Abre el popup: la cuenta 0 ha bajado ~1 ETH y
la 1 ha subido 1.

## 36. El recibo dice `type: 2` (spec 17)

En la consola del service worker, con el hash de la comprobación anterior:

```js
const rpc = (method, params) => fetch('http://localhost:8545', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
}).then((r) => r.json())

;(await rpc('eth_getTransactionByHash', ['<EL_HASH>'])).result.type
```

Esperado: **`"0x2"`**. Y en el mismo objeto, `maxFeePerGas` y
`maxPriorityFeePerGas` presentes, `gasPrice` no relevante.

> 🇪🇸 NOTA: se comprueba en vez de darlo por hecho. Ethers suele inferir el tipo
> bien, pero "suele" no es una garantía: una transacción legacy en una red
> EIP-1559 paga de más y puede quedarse atascada. El firmante pone `type: 2`
> explícito y hay un test que mira el prefijo `0x02` del sobre RLP — esto
> confirma que el nodo lo ve igual.

## 37. El `from` de otra cuenta se rechaza SIN abrir ventana

En la consola de la dApp:

```js
const detail = await new Promise((resolve) => {
  window.addEventListener('eip6963:announceProvider', (e) => {
    if (e.detail.info.rdns === 'academy.codecrypto.wallet') resolve(e.detail)
  })
  window.dispatchEvent(new Event('eip6963:requestProvider'))
})

// La cuenta 1, que NO es la autorizada para este origen.
await detail.provider.request({
  method: 'eth_sendTransaction',
  params: [{
    from: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    to:   '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    value: '0xde0b6b3a7640000',
  }],
})
```

Esperado: error **4100**, y **ninguna ventana se abre**.

> 🇪🇸 NOTA: que no se abra ventana es la mitad de la comprobación. Si se abriera,
> enseñaría la cuenta 1 y el usuario la aprobaría porque la ventana lo dice — el
> permiso que dio era para UNA cuenta. Y una ventana que aparece para algo
> condenado enseña a cerrar ventanas sin leerlas, que es la costumbre que hace
> funcionar el phishing.

## 38. Una llamada a contrato se ve distinta

Mismo snippet, pero con `data` y `value: 0`:

```js
await detail.provider.request({
  method: 'eth_sendTransaction',
  params: [{
    to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    value: '0x0',
    data: '0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead',
  }],
})
```

En la ventana:

- Banda **roja** arriba: "This is a contract call, not a plain transfer."
- El selector `0xa9059cbb` visible, y **show all** despliega el `data` completo.
- `Amount` dice `0.0000 ETH`.

Ese último punto es el que importa: **el `0.0000` tranquiliza y es justo lo
peligroso.** Sin el aviso, una `approve()` infinita se ve igual que no mandar
nada. Rechaza.

## 39. Cerrar con la X y rechazar

- **X** en `notification.html` → la dApp recibe **4001** y vuelve al formulario,
  sin banner rojo.
- **Reject** → mismo 4001.

## 40. El worker no se duerme con la ventana abierta

1. **Send transaction**.
2. Con la ventana abierta, espera **45-60 s** mirando `chrome://extensions`. El
   service worker **no** debe pasar a inactivo.
3. Aprueba.

La transacción se envía. El timeout de firma es de 120 s, más que el de conexión.

## 41. Badge y notificación (specs 32, 33)

Al abrirse la ventana de firma:

- El icono de la extensión muestra **`1`** en violeta.
- Aparece una **notificación de escritorio** con el icono de la wallet y
  "Signature request".

Al aprobar o rechazar, el badge **desaparece**.

**El caso que importa del badge** — que sobreviva al sueño del worker:

1. Lanza una transacción y **no decides**.
2. Cierra la ventana de aprobación con la X → llega el 4001.
3. Lanza otra y deja la ventana abierta.
4. En `chrome://extensions`, pulsa **Service worker** → **Stop**.
5. El badge sigue diciendo `1`, y al despertar el worker lo recalcula solo.

> 🇪🇸 NOTA: si el badge fuera un contador en memoria, ahí diría cero mientras el
> usuario tiene una ventana abierta esperándole. Se deriva de
> `cc:pendingRequests` justo para que ese caso no exista.

Si la notificación **no** aparece: comprueba que el icono es un PNG.
`chrome.notifications` falla en silencio con un SVG — sin excepción, sin
notificación y sin nada en consola.

## 42. Dos transacciones seguidas, sin error de nonce

Manda una de `0.1`, apruébala, y **sin esperar al recibo** manda otra de `0.2` y
apruébala también.

Las dos tienen que confirmarse. Si vieras
`replacement transaction underpriced`, es que la cola del firmante no está
serializando.

Para forzar el solapamiento de verdad, desde la consola de la dApp:

```js
const send = (eth) => detail.provider.request({
  method: 'eth_sendTransaction',
  params: [{ to: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', value: eth }],
})

// Dos a la vez. Se abren DOS ventanas: cada transacción se aprueba por separado.
Promise.all([send('0x2386f26fc10000'), send('0x2386f26fc10000')]).then(console.log)
```

Esperado: **dos ventanas**, no una. Aprueba las dos → dos hashes distintos.

> 🇪🇸 NOTA: que se abran dos es lo correcto y es una diferencia deliberada con
> las conexiones, que sí se agrupan. Dos `eth_sendTransaction` del mismo origen
> son dos transacciones DISTINTAS: compartir una aprobación enviaría la segunda
> sin que el usuario la haya visto nunca.

## 43. Sin fondos, y que no se confunda con un rechazo

Envía una cantidad mayor que el saldo, por ejemplo `99999`, y **apruébala**.

La dApp debe decir algo como "Not enough ETH in this account to cover the value
plus gas", con código **-32603** — **nunca 4001**.

> 🇪🇸 NOTA: es la diferencia que hace que el mensaje sea honesto. Un 4001 aquí le
> diría "cancelaste la transacción" a alguien que la aprobó y se quedó sin
> fondos: le culpa de algo que no hizo y esconde la causa real.

## 44. Anvil apagado

Para Anvil e intenta enviar. Dos cosas:

- La ventana de firma **se abre igual**, diciendo que no pudo estimar la comisión
  — sin inventarse un número — y el botón de aprobar **sigue activo**.
- Al aprobar, la dApp recibe **4901** ("cannot reach the RPC endpoint"), no un
  -32603 genérico.

Bloquear la aprobación habría convertido un parpadeo del nodo en "la wallet no
deja operar".

> 🇪🇸 NOTA: esta comprobación **encontró un bug de verdad** en la Fase 7, y
> conviene no perder el motivo. El mapeo de errores enumeraba los códigos de
> transporte de ethers (`NETWORK_ERROR`, `SERVER_ERROR`, `TIMEOUT`) y mandaba
> todo lo demás a un -32603 genérico. Pero con el nodo caído ethers no lanza
> ninguno de esos tres: lanza `code: "ECONNREFUSED"`, el errno de socket crudo.
>
> Perseguir códigos de transporte no se gana — Node da uno, undici otro y Chrome
> envuelve el fallo de `fetch` de otra forma. La lista está ahora **al revés**:
> se enumeran los códigos que significan que el nodo SÍ contestó
> (`INSUFFICIENT_FUNDS`, `CALL_EXCEPTION`…) y cualquier otra cosa que salga de
> una llamada de red es, por definición, que no llegamos a él. Es el mismo
> criterio que `chain.ts` ya usaba para los saldos, y por eso ésos sí acertaban.

## 45. Los params de firma no llegan al registro

```js
(await chrome.storage.local.get('cc:logs'))['cc:logs']
  .filter((e) => e.label === 'eth_sendTransaction')
```

Cada entrada tiene `detail: "[redacted]"`. **En ninguna aparecen el destino, la
cantidad ni el `data`.** Y en todo `cc:logs`, jamás el mnemonic.

---

# Fase 7 — EIP-712

Requiere `pnpm build` + recargar (↻) y la dApp. **Anvil no hace falta para
firmar** — ver la comprobación 50.

Empieza con `localhost:3000` conectado a la cuenta 0.

## 46. Firmar y verificar (el punto 4 de la prueba de aceptación)

Sección 5 de la dApp, ejemplo **Ether Mail** (el que viene por defecto) →
**Sign typed data**.

Se abre `notification.html`. Comprueba:

1. El origen arriba y en grande.
2. **Domain** antes que el mensaje: `name`, `version`, `chainId`,
   `verifyingContract`.
3. **`Mail · primaryType`** como título del bloque del mensaje.
4. El mensaje campo a campo, con `from` y `to` **indentados** bajo su nombre —
   no un JSON en bruto.

Firma. En la dApp:

```
✓ verified
recovered 0xf39F…2266, expected 0xf39F…2266
```

> 🇪🇸 NOTA: ese `✓` es la comprobación de verdad de la fase. `verifyTypedData`
> recalcula el hash EIP-712 desde cero y recupera quién firmó usando **solo la
> firma**. Si el separador de dominio o el encoding de los tipos no fueran los
> del estándar, la dirección recuperada sería otra — y una firma mal construida
> verifica perfectamente contra su propio código equivocado.

## 47. `EIP712Domain` en `types` no rompe nada

Botón **With EIP712Domain** → **Sign typed data**.

- La ventana **sí** muestra el `EIP712Domain` en el payload que llegó.
- La firma funciona y verifica igual.

> 🇪🇸 NOTA: la mayoría de las dApps lo incluyen, porque el estándar lo define.
> Ethers v6 lo construye solo desde el `domain` y lanza
> `ambiguous primary types or unused types` si además se lo pasas en `types`. Se
> borra sobre una **copia**, para que la ventana pueda enseñar lo que la dApp
> mandó de verdad.

## 48. Tipos anidados y arrays

Botón **Nested arrays** → **Sign typed data**.

En la ventana, `items` debe desplegarse como `items[0]` y `items[1]`, cada uno
con su `sku` y su `amount` indentados. Firma y verifica.

## 49. Un chainId de otra cadena se RECHAZA

Botón **Wrong chainId** → **Sign typed data**.

Esperado: error **-32602** con un mensaje del estilo
"This message is for chain 1, but the wallet is on 31337 (Anvil Local)", y
**ninguna ventana se abre**.

> 🇪🇸 NOTA: éste es el caso que de verdad importa de EIP-712. Estás en Anvil,
> jugando con dinero de mentira, y la dApp te pide firmar algo cuyo dominio dice
> `chainId: 1`. Esa firma es criptográficamente válida **en mainnet**: si era un
> `Permit`, alguien acaba de recibir permiso para mover tus tokens de verdad —
> sin transacción, sin gas y sin nada en el explorador.
>
> La sensación de "estoy en una testnet, no puede pasar nada" es justo lo que
> hace que se firme sin mirar. Por eso se rechaza en vez de avisar, que es
> además lo que hace MetaMask.

## 50. Firmar funciona con Anvil apagado

Para Anvil (`Ctrl-C`) y repite la comprobación 46.

**La firma funciona igual.** Y en la misma dApp, **Send transaction** falla con
4901.

> 🇪🇸 NOTA: no es casualidad y merece verse una vez. Firmar es criptografía
> local — no hay nonce que pedir, no hay comisión que estimar y no hay nada que
> difundir. Lo único que se consulta de la red es su chainId, y sale de storage.
> Por eso el firmante de mensajes no pasa por la cola del nonce: no hay nonce.

Vuelve a arrancar Anvil.

## 51. Firmar como otra cuenta se rechaza sin ventana

En la consola de la dApp:

```js
const detail = await new Promise((resolve) => {
  window.addEventListener('eip6963:announceProvider', (e) => {
    if (e.detail.info.rdns === 'academy.codecrypto.wallet') resolve(e.detail)
  })
  window.dispatchEvent(new Event('eip6963:requestProvider'))
})

const payload = document.querySelector('[data-testid="input-typed-data"]').value

// La cuenta 1, que NO es la autorizada para este origen.
await detail.provider.request({
  method: 'eth_signTypedData_v4',
  params: ['0x70997970C51812dc3A010C7d01b50e0d17dc79C8', payload],
})
```

Esperado: **4100**, y ninguna ventana. Mismo control que el `from` de la Fase 6
y por el mismo motivo: el permiso que diste era para UNA cuenta.

## 52. Payload roto

Borra una llave del JSON en el textarea y pulsa firmar. La dApp dice que el JSON
no parsea, **sin llegar a llamar a la wallet**.

Ahora prueba desde consola con JSON válido pero payload roto:

```js
await detail.provider.request({
  method: 'eth_signTypedData_v4',
  params: [
    '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    JSON.stringify({ domain: {}, types: { Mail: [] }, primaryType: 'Invoice', message: {} }),
  ],
})
```

Esperado: **-32602** mencionando `Invoice` — no un -32603 genérico. El
`primaryType` no está declarado en `types`, y se corta antes de abrir ventana.

## 53. Cerrar con la X

Firma, y cierra `notification.html` con la X sin decidir. La dApp recibe
**4001** y vuelve al formulario, sin banner rojo.

## 54. Los params no llegan al registro

```js
(await chrome.storage.local.get('cc:logs'))['cc:logs']
  .filter((e) => e.label === 'eth_signTypedData_v4')
```

`detail: "[redacted]"` en todas. **Ni el mensaje, ni el dominio, ni el
`verifyingContract`.**

## 55. La tarjeta de la extensión, sin avisos

En `chrome://extensions`, la tarjeta de CodeCrypto Wallet: **cero errores**.

Antes de esta fase aparecían avisos de *"cross-world extension resource
mismatch"* por los `<link rel="modulepreload">` que Vite generaba. Bajo
`chrome-extension://` no adelantaban nada —los archivos son locales— y llenaban
el panel de ruido. Un panel de errores con ruido permanente es un panel que se
deja de mirar.
