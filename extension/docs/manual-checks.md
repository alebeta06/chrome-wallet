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

---

# Fase 8 — Redes

Recarga la extensión antes de empezar: el manifest cambió (`optional_host_permissions`).

## ⚠️ Cómo se quita un permiso de host: el interruptor, y es TODO o NADA

Seis comprobaciones de esta fase (58, 59, 61b, 66, 76, 77) necesitan una red del
catálogo cuyo permiso no esté concedido. **No se llega quitando un host**, se
llega con un interruptor global. Léelo antes de intentar ninguna de las seis.

**Lo que NO existe** (medido el 10 de agosto de 2026): `chrome://extensions` →
CodeCrypto Wallet → Details → **Site access** ofrece solo un desplegable —*On
click* / *On specific sites* / *On all sites*— y **ninguna lista de hosts
concedidos**. "On specific sites" abre un diálogo para **añadir** un sitio, no
para quitarlo. Por código tampoco: `remove()` lanza siempre (comprobación 79).

**Lo que SÍ funciona** (comprobación 80): mover el desplegable a **On click**
retira los permisos concedidos. Y retira **todos** — los opcionales y también los
`host_permissions` declarados en el manifest.

Tres consecuencias que cambian cómo se lee cada una de las seis:

1. **No se puede aislar una red.** Al mover el interruptor se van Anvil, Sepolia
   y las de usuario a la vez. Toda comprobación escrita como "quita el host de X
   y mira que Y no se entera" hay que releerla: no queda ninguna Y con permiso.
2. **La red activa siempre cae**, porque también pierde el suyo. Así que
   `chainChanged` va a llegar en todos los casos, incluso cuando la comprobación
   original decía que no debía llegar.
3. **Es reversible y silencioso.** Volver a *On all sites* devuelve los permisos
   **sin diálogo**. Cómodo para encadenar comprobaciones — y ver más abajo por
   qué es también lo que impide usarlo como remedio de seguridad.

> **Retener no es revocar, y la diferencia importa.** Que el permiso vuelva sin
> diálogo demuestra que el grant **nunca se borró**: solo estaba suspendido. Por
> eso esto no sirve para deshacerse del permiso de un endpoint que mintió
> (comprobación 64) — lo suspendería junto con todos los demás y volvería entero
> al primer clic. Sigue sin haber forma de **eliminar** un permiso concedido.

**Para volver al estado normal** al terminar cualquiera de las seis: Site access
→ *On all sites*. Compruébalo antes de seguir con otra comprobación, o arrastras
una wallet sin permisos a la siguiente y no entenderás nada:

```js
await chrome.permissions.contains({ origins: ["http://localhost:8545/*"] })  // true
```

## 56. Cuánto cuesta de verdad `contains()`

`unusableChainIds` se calcula preguntando a Chrome una vez por red, en cada
`wallet_getState`. Antes de dar por bueno que da igual, se mide.

En la consola de una página de la extensión:

```js
const pattern = 'http://localhost:8545/*'
const t0 = performance.now()
for (let i = 0; i < 100; i++) await chrome.permissions.contains({ origins: [pattern] })
console.log('media por contains():', (performance.now() - t0) / 100, 'ms')
```

Anótalo. Con dos o tres redes en el catálogo y las llamadas en paralelo, el
coste real de un `wallet_getState` es aproximadamente **una** de esas medias, no
la suma.

Y comprueba que el sondeo de saldos NO lo paga: con el popup abierto,

```js
(await chrome.storage.local.get('cc:logs'))['cc:logs']
  .filter((e) => e.label === 'wallet_getState').length
```

no crece cada 5 s. El sondeo llama a `wallet_getBalances`; `wallet_getState`
solo se pide al abrir el popup y después de una acción.

> Si la media saliera por encima de ~1 ms, hay que cachear el resultado durante
> lo que dura el popup abierto e invalidarlo con `permissions.onAdded` /
> `onRemoved`. Por debajo, no.

**Medido** (Chrome, perfil limpio, 5 de agosto de 2026): **0.409 ms** de media
por `contains()`. Con las dos redes de serie y las llamadas en paralelo son
~0.8 ms al abrir el popup.

**Veredicto: no se cachea.** Sin caché no hay invalidación que mantener, y es
una pieza menos de estado mutable en un worker que muere cuando le apetece. El
umbral de 1 ms se queda escrito: si un día el catálogo crece mucho o Chrome
cambia el coste, vuelve a correr el snippet y compara contra este número en vez
de contra una intuición.

## 57. Las builtin salen usables — con Site access en "On all sites"

> **Precondición, y no es una formalidad:** `chrome://extensions` → Details →
> **Site access** tiene que estar en **On all sites**. Con el desplegable en *On
> click* el resultado esperado de abajo es **falso**, y no por un bug: la
> comprobación 80 midió que ese ajuste retira **también** los `host_permissions`
> declarados en el manifest, así que las dos builtin salen como no usables.
> Compruébalo antes de dar por rota ninguna otra cosa.

```js
await chrome.runtime.sendMessage({
  type: 'CODECRYPTO_RPC', id: crypto.randomUUID(),
  method: 'wallet_getState', params: [],
}).then((r) => r.result.unusableChainIds)
```

Esperado: **`[]`**. Anvil y Sepolia están en `host_permissions`, así que deberían
estar siempre concedidas.

**Medido** (Chrome, perfil limpio, 5 de agosto de 2026):

```
anvil: true | sepolia: true      →  unusableChainIds: []
```

Los `host_permissions` declarados **sí** implican `contains() === true`. La
suposición se sostiene, así que `unusableChainIds` no necesita distinguir
"retirado por site access" de "revocado", y el listener de `onRemoved` puede
tratar los dos casos igual.

> Esta comprobación existe porque esa suposición podría ser falsa. Chrome deja
> restringir el acceso a sitios de una extensión desde su tarjeta ("On click" /
> "On specific sites"), y si eso también retira los `host_permissions`
> declarados, las dos builtin aparecerían como no usables sin que el usuario
> haya tocado ningún permiso de red.

**Pregunta contestada** (comprobación 80, 10 de agosto de 2026): **sí los
retira.** Con Site access en *On click*, `unusableChainIds` devolvió las tres
redes, Anvil y Sepolia incluidas.

Lo que esta comprobación decidió de forma provisional —que
`unusableChainIds` **no** necesita distinguir "retirado por site access" de
"revocado", y que el listener de `onRemoved` puede tratar los dos casos igual—
queda confirmado por el mismo camino: la wallet reaccionó a la retirada
exactamente como a una revocación (cayó a la red por defecto, marcó las tres,
avisó en el worker) y el comportamiento fue el correcto. **Distinguirlas habría
sido código de más para una diferencia que no se nota desde aquí.**

## 58. La red activa se queda sin permiso

1. Añade Sepolia como red activa: `wallet_setActiveNetwork` con `0xaa36a7`, o el
   selector.
2. Abre la dApp y conéctala. Deja la pestaña abierta con la consola visible.
3. En `chrome://extensions` → CodeCrypto Wallet → **Details** → **Site access**,
   mueve el desplegable a **On click**. Ver el aviso del principio de la fase:
   esto retira **todos** los permisos, no solo el de Sepolia.

Esperado, las tres cosas:

- El service worker registra `a revoked host permission moved the wallet to 0x7a69`.
- `wallet_getState` devuelve `chainId: "0x7a69"`.
- **La dApp recibe `chainChanged` con `"0x7a69"`** sin recargar nada.

El tercero es el que importa. Sin él, la dApp se queda creyendo que está en
Sepolia mientras la wallet firmaría en Anvil — la misma desincronización que la
comprobación de deriva de chainId cierra desde el otro lado.

> **Y fíjate en el destino: Anvil TAMPOCO tiene permiso ya.** La wallet se mueve
> igual, y es lo correcto: moverse a una red por defecto que también está sin
> acceso sigue siendo mejor que quedarse en una que el usuario cree activa. Lo
> fija `network-store.test.ts` → *moves to the default even when the default is
> unusable too*. Si la wallet se quedara quieta por "no hay a dónde ir", eso sí
> sería un bug.

Al terminar: Site access → *On all sites*.

## 59. Una red sin acceso no es una red borrada

Esta comprobación medía **dos** cosas y la vía nueva solo alcanza una. Se parte,
en vez de dejarla escrita como si siguiera entera.

### 59a. Sin acceso ≠ borrada — SE COMPRUEBA

En el mismo movimiento de la 58 (Site access → *On click*), sin deshacerlo:

```js
await chrome.runtime.sendMessage({
  type: 'CODECRYPTO_RPC', id: crypto.randomUUID(),
  method: 'wallet_getState', params: [],
}).then((r) => ({ unusable: r.result.unusableChainIds, hay: r.result.networks.length }))
```

Esperado: `unusableChainIds` trae **las tres** —`0x7a69`, `0xaa36a7` y `0x53a`—
y `networks` **sigue teniendo las tres**. Ninguna desaparece del catálogo por
haberse quedado sin permiso. Es la mitad que importaba para la UI: una red no
usable se marca, no se borra, porque borrarla mandaría al usuario a añadir otra
vez algo que ya tiene.

### 59b. "Revocar lo que no usabas no te mueve" — NO ALCANZABLE

Medía que perder el permiso de una red que **no** era la activa te dejaba donde
estabas, sin `chainChanged`. Por esta vía es imposible: el interruptor es global,
la red activa pierde el suyo **siempre**, y el `chainChanged` llega **siempre**.
No queda ninguna red "otra" que conserve permiso para comparar.

Y no es que falte una variante más lista: **la propiedad requiere retirar un
permiso y no otro**, que es exactamente lo que Chrome ya no deja hacer.

Qué la cubre mientras tanto:

- `dispatch.test.ts` → *lists the network whose host was revoked*, que fija que
  la red se marca sin salir del catálogo.
- Y para reproducirlo **a mano**, la única vía sería sembrar `cc:networks` con
  una red cuyo host nunca se concedió mientras la activa conserva el suyo — el
  camino candidato del punto 4 de `e2e-backlog.md`, que sigue **sin medir**. Es
  el único que aísla UNA red, y por eso no se ha borrado del backlog.

## 60. Cambiar de red desde una dApp

Con la dApp conectada y su consola abierta:

```js
const p = await window.codecrypto ?? provider   // el que ya usas en la dApp
provider.on('chainChanged', (id) => console.log('chainChanged →', id))

await provider.request({
  method: 'wallet_switchEthereumChain',
  params: [{ chainId: '0xaa36a7' }],
})
```

Esperado: devuelve `null`, se imprime `chainChanged → 0xaa36a7`, y
`eth_chainId` ya responde lo nuevo. El popup enseña Sepolia al abrirlo.

**Y NO se imprime `accountsChanged`.** Cambiar de red no toca las cuentas ni los
permisos por origen: son ejes independientes. Ponle también un listener a
`accountsChanged` antes de la llamada para poder afirmarlo, no para suponerlo.

## 61. Los dos 4902, y son distintos

```js
// a) una red que no está en el catálogo
await provider.request({
  method: 'wallet_switchEthereumChain',
  params: [{ chainId: '0x1' }],
}).catch((e) => console.log(e.code, e.message))
```

Esperado: **4902**, y el mensaje menciona `wallet_addEthereumChain`.

```js
// b) una red que SÍ está, sin permiso
// primero: Site access → "On click" (retira TODOS, ver el aviso de la fase)
await provider.request({
  method: 'wallet_switchEthereumChain',
  params: [{ chainId: '0xaa36a7' }],
}).catch((e) => console.log(e.code, e.message))
```

Esperado: **4902 también**, pero el mensaje dice *"Sepolia"* y *"revoked"*. Mismo
código porque la reacción correcta de la dApp es la misma —ofrecer añadirla—, y
distinto mensaje porque lo que el usuario tiene que entender no lo es.

**Y el mensaje tiene que decir QUÉ hacer, no solo qué pasa.** Léelo como si no
supieras nada del código: ¿te queda claro que hay que **volver a conceder el
permiso**? Si suena a "esa red no está disponible" a secas, está mal — manda al
usuario a añadir otra vez una red que ya tiene, que es justo lo que no hay que
hacer. Con la red ya en el catálogo, añadirla de nuevo es la acción equivocada
y la única que el mensaje parecería estar sugiriendo.

Comprueba además que **la red activa no se movió** y que no llegó ningún
`chainChanged`: el permiso se comprueba antes de escribir.

## 62. Escrito de otra forma es la misma red

```js
await provider.request({
  method: 'wallet_switchEthereumChain',
  params: [{ chainId: '0x0AA36A7' }],
})
await provider.request({ method: 'eth_chainId' })
```

Esperado: funciona, y `eth_chainId` devuelve `"0xaa36a7"` — en minúsculas y sin
el cero. Un `0x01` no es una petición rara: es el mismo número escrito de otra
forma, y obligar a la dApp a conocer nuestra forma canónica sería un detalle
nuestro filtrándose hacia fuera.

## 63. Añadir una red desde la dApp

Necesitas un segundo Anvil para tener una red real que añadir:

```bash
anvil --port 8546 --chain-id 1338
```

Desde la consola de la dApp conectada:

```js
await provider.request({
  method: 'wallet_addEthereumChain',
  params: [{
    chainId: '0x53a',                       // 1338
    chainName: 'Anvil Two',
    rpcUrls: ['http://localhost:8546'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  }],
})
```

Esperado, en este orden:

1. Se abre `notification.html` diciendo **"A site wants to add a network"**, con
   la URL **entera y sin truncar**.
2. Al pulsar **Add network**, Chrome abre su propio diálogo de permisos.
3. Al aceptarlo, la llamada devuelve `null`.
4. La red aparece en `wallet_getState().networks`.
5. **NO se cambió de red.** `eth_chainId` sigue devolviendo Anvil, y no llegó
   ningún `chainChanged`. Añadir una red es ponerla en la lista, no meterte en
   ella.

## 64. El RPC que miente sobre su chainId

Con el segundo Anvil corriendo en 8546 con chainId **1338**, pide añadirlo
declarando otro:

```js
await provider.request({
  method: 'wallet_addEthereumChain',
  params: [{
    chainId: '0x2a',                        // 42 — mentira
    chainName: 'Fake',
    rpcUrls: ['http://localhost:8546'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  }],
}).catch((e) => console.log(e.code, e.message))
```

Esperado, las tres cosas:

- **-32602**, y el mensaje dice qué cadena reporta de verdad.
- La red **no** está en `wallet_getState().networks`.
- **El permiso SIGUE concedido.** No se comprueba en `chrome://extensions` —esa
  pantalla no lista los hosts concedidos, ver el aviso del principio de la
  fase—, sino en la consola de cualquier página de la extensión:

  ```js
  await chrome.permissions.contains({ origins: ["http://localhost:8546/*"] })  // true
  ```

  No es un bug — ver abajo.
- En la consola del **service worker**, un `console.error` con los cuatro datos:
  el origen que lo pidió, `http://localhost:8546`, el `0x2a` declarado y el
  `0x53a` que reporta el nodo. Los cuatro, no tres.

> **Esto medía otra cosa hasta agosto de 2026, y decía lo contrario.** Esperaba
> ver el permiso revocado, porque la wallet lo intenta y porque el spike de la
> Fase 8 lo daba por posible. No lo es: `chrome.permissions.remove()` lanza
> `You cannot remove required permissions` para cualquier origen http/https
> mientras el content script declare `<all_urls>` — está medido en la
> comprobación 79 y explicado en la cabecera de `lib/permissions.ts`. El spike
> había medido `remove()` en **Brave** y `contains()` en Chrome, y la conclusión
> viajó de un navegador al otro sin que nadie lo notara.

**Y no hay forma de dejar el perfil limpio.** Esto decía hasta el 10 de agosto de
2026 que el permiso se quitaba a mano desde `chrome://extensions`, y era falso:
esa pantalla no da control por host (ver el aviso del principio de la fase). Ni
la wallet ni el usuario pueden retirarlo. Por eso el mensaje del worker no
sugiere ninguna salida — mandar a buscar algo que no existe es peor que callar.

Y que ese permiso se quede **no es equivalente** a los otros huérfanos que el
proyecto acepta. Los demás son hosts de los que no sabemos nada malo. Éste es un
host que mintió sobre su identidad y que la wallet decidió que no quería: es una
degradación de seguridad real, y el `console.error` es lo único que queda de ella.

## 65. El nodo caído NO cuesta el permiso

Para el segundo Anvil (`Ctrl-C`) y repite la comprobación 63 con `0x53a`.

> **Ojo: "el permiso sigue concedido" YA NO PRUEBA NADA aquí.** Desde la 64
> sabemos que el permiso se queda **en los dos casos** — cuando el nodo no
> responde y cuando el endpoint miente— porque Chrome no deja revocarlo en
> ninguno. Mirar `chrome://extensions` no distingue "lo conservó" de "no pudo
> quitarlo", y una comprobación que no distingue no es una comprobación.
> El discriminante se muda al código y a la consola.

Esperado, y las tres cosas juntas:

- **4901**, no -32602. Ése es el primer discriminante: "no está" y "mintió" son
  respuestas distintas.
- En la consola del service worker **NO aparece** el `console.error` de la 64 —
  ni ningún mensaje nombrando dos chainIds distintos. Aquí no hay ninguna cadena
  que contradecir, porque el nodo no llegó a decir nada.
- **NO aparece** tampoco el `Chrome refused to revoke …`. En este camino ni
  siquiera se intenta revocar, que es justo lo que se está comprobando.

Vuelve a levantar Anvil y repite la llamada: funciona **sin que Chrome vuelva a
abrir el diálogo de permisos**, porque nunca se retiró.

Es la diferencia entre "mintió" y "no está": decidir revocar por un parpadeo del
nodo obligaría a pasar otra vez por el diálogo nativo entero. Que hoy esa
decisión no pueda ejecutarse no la borra — sigue siendo la decisión correcta, y
es la que se ve en el código y en los tests.

## 66. Reconceder una red sin acceso

El ciclo completo, que es el que un atajo de idempotencia habría roto:

1. Añade Anvil Two (comprobación 63) y cambia a ella con
   `wallet_switchEthereumChain`.
2. `chrome://extensions` → **Site access** → **On click**. Retira todos los
   permisos, no solo el de Anvil Two.
3. La wallet cae a Anvil sola y la dApp recibe `chainChanged` (comprobación 58).
4. `wallet_switchEthereumChain` a `0x53a` → **4902** mencionando
   `wallet_addEthereumChain`.
5. Llama a `wallet_addEthereumChain` **con exactamente los mismos params** de la
   comprobación 63.

Esperado en el paso 5: **se abre una ventana** que dice *"restore access"*, no un
`null` silencioso.

> Si el paso 5 devuelve `null` sin abrir nada, el consejo del 4902 no lleva a
> ninguna parte y la red queda inalcanzable para siempre desde la dApp. **Ésa es
> la aserción de esta comprobación**, y no depende de nada de Chrome: es lógica
> de la wallet decidiendo que un alta con el permiso ausente no es idempotente.

**Medido** (Chrome, 10 de agosto de 2026, observado al pasar la comprobación 76):
`chrome.permissions.request()` **sí reconcede con el interruptor en *On click***.
El diálogo aparece, se concede, y la red vuelve a ser usable sin tocar Site
access. Tras aprobar, el `switch` del paso 4 funciona.

> **Y reconcede SELECTIVAMENTE, que es lo que no se esperaba.** Tras restaurar
> Anvil Two, esa red quedó usable mientras Anvil Local y Sepolia seguían
> tachadas. O sea: el interruptor retiene todo a la vez, pero recuperar va de una
> en una. **La asimetría es la noticia** — el camino de vuelta sí distingue
> hosts, aunque el de ida no.

## 67. Dos altas a la vez con RPC distinto

En la consola de la dApp, **sin `await` entre las dos**:

```js
const uno = provider.request({ method: 'wallet_addEthereumChain', params: [{
  chainId: '0x53a', chainName: 'Anvil Two', rpcUrls: ['http://localhost:8546'],
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
}]})
const dos = provider.request({ method: 'wallet_addEthereumChain', params: [{
  chainId: '0x53a', chainName: 'Anvil Two', rpcUrls: ['http://localhost:8547'],
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
}]})
```

Esperado: **DOS ventanas**, cada una con su URL. Son dos preguntas distintas.

Si saliera una sola, aprobarla estaría aprobando también una URL que nunca
apareció en pantalla — y eso no es un problema de comodidad.

Repite con los dos params **idénticos**: ahí sí, **una sola ventana**, y las dos
promesas se resuelven con ella.

## 68. Una dApp no puede reapuntar una red de serie

```js
await provider.request({
  method: 'wallet_addEthereumChain',
  params: [{
    chainId: '0xaa36a7',                    // Sepolia
    chainName: 'Sepolia',
    rpcUrls: ['http://localhost:8546'],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  }],
}).catch((e) => console.log(e.code, e.message))
```

Esperado: **-32602** nombrando Sepolia, **sin abrir ventana** y **sin que Chrome
pida ningún permiso**. Y en la consola del service worker, un `warn` con el
origen y la URL propuesta.

Que una web pueda hacer aparecer un diálogo nativo de permisos con un intento que
nunca va a prosperar es ruido que no tiene por qué poder provocar. Y el aviso en
el registro es lo único que distingue una dApp mal configurada de una hostil.

## 69. Cambiar de red con una firma esperando

El caso que la deriva de chainId existe para cerrar:

1. Con Anvil activo, lanza desde la dApp un `eth_sendTransaction` y **no
   decidas**. Deja la ventana abierta.
2. Sin cerrarla, abre el popup y cambia a Sepolia.
3. Vuelve a la ventana de firma y pulsa **Approve**.

Esperado: **-32602**, y el mensaje nombra **Anvil Local** — la red para la que se
aprobó. No se firma nada, y en el explorador de Sepolia no aparece ninguna
transacción.

Repítelo con `eth_signTypedData_v4`. Mismo resultado: una firma EIP-712 no toca
la red, pero su `domain.chainId` se validó contra la que estaba activa al
empezar, y si la wallet se movió esa validación ya no dice nada.

## 70. La transacción sale como type 2 en una red que soporta 1559

Después de enviar en Anvil o en Sepolia:

```js
const r = await rpc('eth_getTransactionReceipt', [hash])
parseInt(r.type, 16)      // 2
```

Esperado: **2**. El fallback a legacy no puede activarse de más — una
transacción legacy en una red EIP-1559 paga de más y puede quedarse atascada,
que es el problema que 1559 vino a resolver.

## 71. Dos pestañas del MISMO origen reciben chainChanged

Abre la dApp **dos veces en la misma URL**, con la consola de las dos visible, y
en ambas:

```js
provider.on('chainChanged', (id) => console.log('aquí →', id))
```

Cambia de red desde el popup. Esperado: **las dos** imprimen.

> El caso es del mismo origen a propósito. Con dos orígenes distintos, un filtro
> mal puesto pasaría igualmente porque cada uno recibiría el suyo; con dos
> pestañas iguales se caza además el error clásico de quedarse con la primera —
> que deja una pestaña enseñando la red vieja mientras la otra ya cambió.

Y en las dos, comprueba que **no** llegó ningún `accountsChanged`: pon el
listener antes de cambiar de red.

## 72. El selector de red

Con el popup abierto:

- Las redes salen con nombre y símbolo, y la activa marcada.
- Pulsar otra cambia de red. Los saldos se refrescan **al momento**, no cinco
  segundos después: el chainId entra en la clave del sondeo.
- Las dos de serie **no** tienen la ✕ de borrar.

## 73. Alta manual — y por qué está en su propia ventana

`+ Add network` abre una ventana aparte, no una pantalla dentro del popup.

Levanta el segundo Anvil (`anvil --port 8546 --chain-id 1338`) y rellena:

```
Name      Anvil Two
RPC       http://localhost:8546
Chain ID  0x53a
Symbol    ETH
Decimals  18
```

Esperado: Chrome pide permiso, se verifica el chainId, la red aparece en el
selector, y **no** te cambia a ella.

**Comprueba el motivo de la ventana aparte**, que es lo que midió el GATE 2:

1. Abre el popup y luego haz clic **fuera** de él. Se cierra.
2. Ahora abre la ventana de red, escribe medio formulario y haz clic fuera.
   **Sigue ahí.**

Si el formulario viviera en el popup, cualquier despiste perdería lo escrito — y
peor: el diálogo de permisos de Chrome mataría el contexto y el `await` no
volvería nunca.

**Y comprueba lo que NO aparece:** al pulsar "Add network" no se abre ninguna
ventana de aprobación preguntándote si apruebas lo que acabas de escribir. No
falta: sobra. El dueño de la wallet no se aprueba a sí mismo, y una aprobación
que no puede acabar en "no" solo enseña a pulsar sin leer.

## 74. Validación en el propio campo

En el formulario, escribe `http://rpc.example.com` en RPC y pulsa enviar.

Esperado: el error sale **junto al campo**, diciendo que solo se admite https o
http en local — y **Chrome no llega a pedir ningún permiso**. Lo mismo con un
Chain ID que no sea hex.

## 75. Borrar una red y su permiso

1. Añade Anvil Two (comprobación 73).
2. Pulsa la ✕ de su fila.
3. La red **desaparece de la lista**, que es lo que pediste.
4. Los dos permisos **siguen concedidos**. Se comprueba en la consola, no en
   `chrome://extensions`, que no los lista:

   ```js
   await chrome.permissions.contains({ origins: ["http://localhost:8546/*"] })  // true
   await chrome.permissions.contains({ origins: ["http://localhost:8545/*"] })  // true
   ```
5. En la consola del service worker, un `console.warn` —no un `error`— diciendo
   que la red se borró y su permiso se queda.

> **El título de esta comprobación mentía, y el paso 3 pedía lo contrario.**
> Chrome no puede revocar (comprobación 79), así que el permiso se queda siempre.
> La red se borra igual: borrar es lo que el usuario pidió, y revocar era aseo.

Este huérfano **sí** es de los benignos, al revés que el de la 64: lo dejó un
borrado que pediste tú, sobre un host del que no sabemos nada malo. Y tampoco se
puede quitar —ni tú ni la wallet—, pero aquí no hay nada que lamentar: es un host
que tú elegiste y que hasta hace un momento usabas.

> **Lo que esta comprobación ya no puede demostrar.** El paso 4 servía para
> probar que la condición está escrita **por patrón y no por host** — mismo host,
> puerto distinto, permisos independientes. Al no revocarse nada, los dos
> permisos siguen ahí pase lo que pase y el paso no discrimina. Esa demostración
> vive ahora **solo en los tests unitarios** de `network-rpc.test.ts` (los que
> comprueban que se conserva el permiso cuando otra red comparte el patrón y que
> se revoca exactamente una vez con dos borrados simultáneos), donde el fake sí
> permite revocar. Se dice aquí en vez de dejar creer que esto lo cubre.

Prueba también los tres rechazos, y lee los mensajes como si no supieras nada:

- ✕ en la red **activa** → dice que **cambies de red primero**. Es el único de los
  tres que el usuario puede arreglar, y el único que dice cómo.

> **El rechazo de "red de serie" no se puede provocar desde el popup, y está
> bien así.** Las builtin **no tienen ✕** — comprobado el 10 de agosto de 2026.
> No es que el botón falle: es que no está. Un botón que siempre acaba en un
> mensaje de error es peor UI que un botón ausente, porque invita a pulsarlo
> para descubrir que no.
>
> Consecuencia honesta: ese rechazo queda cubierto **solo por test**
> (`networks.test.ts` → *refuses to touch a built-in*, y la tabla de motivos de
> `removeNetwork`), y **por diseño de la UI**, no por un hueco. La defensa sigue
> haciendo falta porque `wallet_removeNetwork` también llega desde una dApp,
> donde no hay UI que la proteja.

## 76. Una red sin acceso: marcada, y con salida

1. Con Anvil Two añadida y **Anvil de serie** como red activa, mueve Site access
   a **On click**.
2. Abre el popup.

> **Van a salir marcadas las TRES, no solo Anvil Two.** El interruptor es global
> (ver el aviso del principio de la fase), así que Anvil y Sepolia aparecen
> igual. No es un fallo del render: es que de verdad no hay permiso para
> ninguna. Lo que se está mirando aquí es **cómo se marca una fila**, y da lo
> mismo que sean tres que una.

Esperado:

- Anvil Two **sigue en la lista**, atenuada y tachada, con el chip `no access`.
  No desaparece: si desapareciera, irías a añadirla otra vez, que es la acción
  equivocada porque ya la tienes.
- Al lado, un botón **Restore**.
- Si intentas seleccionarla, sale el 4902 con el mensaje del permiso revocado.

Pulsa **Restore**: se abre la ventana de red con los datos ya rellenos y en modo
*"Restore access"*, con los campos bloqueados —se reconcede lo que la wallet
tiene guardado, no lo que escribas— y un aviso explicando qué pasó. Concede el
permiso y la red vuelve a ser usable, sin haber tenido que escribir nada.

## 77. La red activa se queda sin acceso

Repite la 76 pero con **Anvil Two como red activa**.

Esperado: la wallet cae a Anvil sola y la dApp recibe `chainChanged`
(comprobación 58), y el popup enseña arriba el aviso de que ya no puede alcanzar
esa red — separado del banner de saldos, porque "no llego al nodo" y "me quitaste
el permiso" tienen arreglos distintos.

> **El aviso tiene que salir aunque el destino tampoco tenga permiso.** Por esta
> vía la wallet cae a Anvil y Anvil está igual de inalcanzable, así que el popup
> queda enseñando una red activa sin acceso. Si en ese estado el aviso NO
> aparece, es un bug: sería justo el caso en que el usuario más necesita que le
> digan por qué no llegan los saldos.

Al terminar: Site access → *On all sites*, y comprueba que vuelven los permisos
antes de seguir con la 78.

## 78. Una dApp cambia la red con el popup abierto

Deja el popup abierto y, desde la consola de la dApp:

```js
await provider.request({
  method: 'wallet_switchEthereumChain',
  params: [{ chainId: '0xaa36a7' }],
})
```

Esperado: el selector del popup **se mueve solo** a Sepolia, sin cerrarlo ni
volver a abrirlo. No hay sondeo: el popup escucha `chrome.storage.onChanged`,
que es donde el cambio deja huella pase por donde pase.

## 79. Por qué `remove()` no puede revocar nada (medido)

Esta no se repite en cada revisión: es un **experimento cerrado**, con su
resultado escrito, del que dependen la 64, la 65 y la 75. Está aquí para que
nadie tenga que volver a discutirlo de memoria — y sobre todo para que nadie
vuelva a proponer la hipótesis equivocada, que es muy natural.

**El síntoma.** `chrome.permissions.remove()` lanza `You cannot remove required
permissions` para **cualquier** origen http/https de esta extensión, incluidos
hosts limpios que no aparecen en el manifest.

**La hipótesis natural, que es falsa:** que el comodín `https://*/*` de
`optional_host_permissions` convierta en "requerido" lo que cae debajo.

**La causa real:** `content_scripts[0].matches` es `<all_urls>`, Chrome lo
instala como scriptable host **requerido**, y `remove()` rechaza cualquier
patrón contenido en los requeridos. `ContainsPattern` es contención semántica,
no pertenencia exacta, y `<all_urls>` contiene todo patrón http/https. La cadena
con sus archivos de Chromium está en la cabecera de `lib/permissions.ts`.

### Cómo se midió

Las dos mitades predicen lo **contrario**, que es lo que hace que el experimento
valga. Antes de cada intento, comprobar el baseline — `remove()` elimina en
silencio lo que no esté concedido, así que un `true` sobre un patrón que no está
no prueba nada:

```js
await chrome.permissions.contains({ origins: ["http://localhost:8546/*"] })  // TIENE que dar true
```

Y en cada mitad, tras editar `src/manifest.ts`: `pnpm build`, `chrome://extensions` → ↻.

| | `content_scripts[0].matches` | `optional_host_permissions` |
|---|---|---|
| **A · discriminante** | `["http://localhost:3000/*"]` | intacto (con el comodín) |
| **B · control inverso** | `["<all_urls>"]` | `["http://localhost:8546/*"]` |

```js
try { console.log('remove →', await chrome.permissions.remove({ origins: ["http://localhost:8546/*"] })) }
catch (e) { console.log('THREW →', e.message) }
console.log('contains después →', await chrome.permissions.contains({ origins: ["http://localhost:8546/*"] }))
```

**Medido** (Chrome, 8 de agosto de 2026):

```
A · content script estrecho, comodín intacto
   baseline: true → remove: true → contains: false     ✅ REVOCA DE VERDAD

B · <all_urls> de vuelta, comodín estrechado a un host
   baseline: true → THREW: You cannot remove required permissions
                  → contains: true                     ❌ NO REVOCA
```

**Veredicto.** La variable causal es `content_scripts[0].matches`. La anchura de
`optional_host_permissions` **no interviene**: con el comodín fuera sigue
lanzando, y con el comodín dentro pero el content script estrecho, revoca.

Y no hay salida por manifest. Estrechar los `matches` devuelve `remove()` pero
deja de ser una wallet — se inyecta en cualquier sitio o no sirve. Registrar el
content script en runtime exige permiso de host sobre esos orígenes, que
reintroduce el mismo error por la rama de los explicit hosts.

> **Revocar un permiso por host es incompatible con una extensión que se inyecta
> en todos los sitios.** No es un accidente de nuestro manifest: es la forma de
> la API.

Al terminar, revertir las dos líneas, `pnpm build`, ↻, y `git diff` vacío.

## 80. ¿Retira permisos el desplegable de Site access?

**Sin correr.** De su resultado dependen seis comprobaciones marcadas NO
EJECUTABLE (58, 59, 61b, 66, 76, 77) y si el listener de
`chrome.permissions.onRemoved` de `background.ts` es alcanzable o es código
muerto. Es la última vía que queda: la de por host ya se midió y no existe.

Con Anvil Two añadida y su permiso concedido, en la consola de una página de la
extensión (baseline obligatorio):

```js
await chrome.permissions.contains({ origins: ["http://localhost:8546/*"] })  // TIENE que dar true
```

Deja esa consola abierta y **también la del service worker**, que es donde
aparecería el aviso. Entonces, en `chrome://extensions` → CodeCrypto Wallet →
Details → **Site access**, mueve el desplegable a **On click**. Vuelve y repite
el `contains()`.

Esperado si la vía sirve:

- `contains()` pasa a **`false`**.
- El service worker registra `a revoked host permission moved the wallet to …`
  **si Anvil Two era la red activa** — que es lo que mide la 58 por otro camino.
- `wallet_getState().unusableChainIds` incluye `0x53a`.

Esperado si no sirve: `contains()` sigue en `true` y no pasa nada en el worker.

Prueba también el camino inverso —volver a *On all sites*— y mira si
`contains()` regresa a `true` sin diálogo.

> **Qué decidía, y cómo cayó.** Salió que **sí retira**, así que las seis
> volvieron, reescritas para *"todas las redes a la vez"*. La única que no se
> pudo recuperar entera es la 59: su mitad (b) medía que perder el permiso de una
> red que **no** era la activa te deja donde estabas, y por esta vía la activa
> cae siempre. Está partida en 59a (se comprueba) y 59b (no alcanzable), en vez
> de dejarla escrita como si siguiera entera.
>
> La otra rama —que no retirase— traía la regla de no borrar el listener de
> `onRemoved` en la misma tanda, sino marcarlo y decidirlo aparte. No hizo falta,
> pero la regla se queda escrita: llevamos dos casos en esta fase —el spike de
> Brave y la revocación a mano— en los que una medición se dio por concluyente
> antes de tiempo. Borrar código de seguridad con una medición recién hecha es el
> movimiento que esta fase ha enseñado a no hacer.

### Resultado

**Medido** (Chrome canal Stable, perfil de desarrollo, extensión unpacked,
**10 de agosto de 2026**). Anvil Two en el catálogo y como red **activa**:

```
  baseline contains()          → true
  tras mover a "On click"      → false
  aviso en el service worker   → "a revoked host permission moved the
                                  wallet to 0x7a69"
  unusableChainIds             → ["0x7a69", "0xaa36a7", "0x53a"]
  al volver a "On all sites"   → true, sin diálogo
```

**Veredicto: la vía sirve, y es reversible.** Tres cosas quedan fijadas:

1. **`permissions.onRemoved` no es código muerto.** Tiene disparador conocido y
   se dispara — el aviso del worker lo prueba.
2. **"On click" retira también los `host_permissions` declarados**, no solo los
   opcionales: en `unusableChainIds` salieron las tres redes, incluidas Anvil y
   Sepolia, que están en el manifest. Esto **contesta la pregunta que la
   comprobación 57 dejó abierta**, y la 57 lleva ahora su precondición.
3. **Retener no es revocar.** El permiso volvió **sin diálogo**, lo que
   demuestra que el grant nunca se borró: estaba suspendido. Sigue sin existir
   ninguna forma de **eliminar** un permiso concedido — ni para la wallet
   (comprobación 79) ni para el usuario.

La fecha y el navegador van arriba a propósito. En esta fase ya han viajado dos
mediciones fuera de su contexto —`remove()` medido en Brave y leído como si fuera
Chrome, y el control por host que desapareció sin que ninguna comprobación lo
notara—, así que ésta nació fechada en vez de que hubiera que reconstruirlo
después.

## 81. Qué RPC público de Sepolia sirve de verdad (medido)

**Experimento cerrado**, como la 79. Existe porque el endpoint de serie se murió
en mitad de la fase y hubo que elegir otro — y porque **ésta es la medición de
esta fase que más rápido caduca**: los planes gratuitos cambian sin avisar. Lleva
fecha y la lista de métodos probados para que el día que falle se pueda repetir
en vez de discutirlo de memoria.

**Por qué se prueban NUEVE métodos y no `eth_chainId`.** Porque el modo de fallo
real no es "el endpoint está caído", es "este método concreto es de pago". Un
endpoint que responde `eth_chainId` y `eth_getBalance` da una wallet que se ve
perfecta —red correcta, saldos, todo— y que solo se cae al firmar.

```bash
for m in eth_chainId eth_blockNumber eth_gasPrice eth_maxPriorityFeePerGas \
         eth_estimateGas eth_getTransactionCount eth_getBalance \
         eth_feeHistory eth_getBlockByNumber; do
  curl -sS --max-time 15 -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$m\",\"params\":[]}" "$URL"
done
```

(Los que llevan parámetros —`eth_estimateGas`, `eth_getBalance`,
`eth_getTransactionCount`, `eth_feeHistory`, `eth_getBlockByNumber`— con los
suyos; lo que se mira es si contestan o si devuelven un error de plan.)

**Medido** (curl desde WSL2, **10 de agosto de 2026**):

| Endpoint | Métodos OK | Qué pasa |
|---|---|---|
| `ethereum-sepolia-rpc.publicnode.com` | **9/9** | `chainId` `0xaa36a7` ✓, ~350 ms por llamada. **El elegido.** |
| `1rpc.io/sepolia` | 8/9 | falla **`eth_estimateGas`** — *"not available on free plan"* |
| `sepolia.drpc.org` | **0/9** | *"chain is not available on free plan"* en todos. Era el de serie. |
| `rpc.sepolia.org` | 0/9 | timeout a los 15 s |

**Veredicto: `publicnode`**, sin clave. Se descartó Alchemy con API key por algo
que no es negociable en una extensión: el bundle se descarga y se abre, así que
una clave dentro no es un secreto — no hay equivalente a la fricción de un
`NEXT_PUBLIC_*` en un servidor.

> **La trampa de esta medición es `1rpc`.** Pasa ocho de nueve. Si se hubiera
> mirado solo `eth_chainId` habría salido elegido, y el fallo habría aparecido
> en la transacción de cierre de fase, delante de la cámara, en el único momento
> en que no se puede depurar.

**Si publicnode también cae:** no se reapunta Sepolia desde la wallet —se rechaza
con -32602 por ser builtin—. Se cambia `DEFAULT_NETWORKS` en `src/lib/networks.ts`
y el `host_permissions` de `src/manifest.ts`, y se reconstruye. Ver la NOTA junto
a las builtin, que explica por qué eso arregla también los perfiles existentes.

---

# Fase 9 — Registro, avisos, reset y transferencias internas

> **Pasadas el 17-18 de agosto de 2026 en Chrome Stable. 14 de 14, sin
> bloqueantes.** Cada una lleva su `Resultado` con navegador y fecha, por la
> lección de la 79 — aquella midió `remove()` en Brave y la conclusión viajó a
> Chrome sin que nadie lo notara al releerla.
>
> **Lo que NO salió limpio, y está dicho donde toca:**
>
> - la **89** es PARCIAL: destapó que el badge se queda obsoleto cuando una
>   solicitud caduca en vez de resolverse. Diagnóstico completo en
>   `lib/badge.ts`;
> - el sub-paso **(5) de la 87** no es reproducible con el registro lleno, y se
>   dice en vez de darlo por bueno;
> - la **82** necesitó dos intentos de setup, y el primero dio un falso
>   negativo. El intento fallido está escrito porque explica por qué el setup
>   final es el que es.
>
> Otros dos límites conocidos, encontrados durante estas comprobaciones y
> anotados en el código en vez de en una lista aparte: cerrar la ventana de
> aprobación con el worker muerto no produce el `4001` (ver el `onDisconnect`
> del puerto en `background.ts`), y el timeout de 120 s responde `4001`, que
> significa otra cosa (ver el temporizador en `lib/approvals.ts`).

## Las cinco superficies, y en cuál va cada paso

Esta fase se mueve entre más ventanas que ninguna anterior, así que cada paso
lleva delante dónde va:

| Etiqueta | Qué es | Cómo se abre |
|---|---|---|
| **[T-anvil]** | terminal del nodo local | `anvil` en su propia terminal |
| **[T-dapp]** | terminal de la dApp | `pnpm dev` en `dapp/` |
| **[worker]** | consola del **service worker** | `chrome://extensions` → tarjeta → **service worker** |
| **[popup]** | consola del popup | abre el popup, botón derecho → **Inspeccionar** |
| **[dApp]** | consola de la página web | F12 en `localhost:3000` |
| **[aprobación]** | consola de `connect.html` / `notification.html` | botón derecho en esa ventana → **Inspeccionar** |

> 🇪🇸 NOTA: el popup **se cierra al perder el foco**, y con él su consola. Para
> inspeccionarlo hay que abrir su DevTools ANTES de hacer nada; si se cierra a
> mitad, el panel de logs y la transferencia no se pueden depurar. Es la razón
> de que casi todo lo de esta fase se mire desde **[worker]**, que no se cierra.

**Cómo saber que el worker ha reiniciado de verdad:** arranca imprimiendo
`[codecrypto] background service worker alive`. Si esa línea no aparece, no ha
reiniciado y la comprobación no está midiendo lo que cree.

---

## 82. El rearme de la alarma al arrancar (LA MÁS IMPORTANTE)

**Ésta es la única propiedad de la Fase 9 que ningún test puede falsar.** Quitar
el barrido de arranque de `background.ts` no pone rojo nada — se comprobó — así
que esto es lo único que la protege. Si alguna vez hay que recortar la lista,
ésta se queda.

Lo que está en juego: si al arrancar nadie recalcula, un worker que muera con
transacciones en vuelo las deja **sin vigilar para siempre**. La alarma no vuelve
sola, nadie pregunta por el recibo, y el usuario no recibe el aviso de algo que
sí se minó. Sin ningún error en ninguna parte.

1. **[T-anvil]** arranca el nodo con bloques lentos, para tener una transacción
   en vuelo de verdad:

   ```bash
   anvil --block-time 60
   ```

2. **[dApp]** envía una transacción y apruébala. Vuelve el hash enseguida; la
   transacción NO está minada.

3. **[worker]** comprueba que la alarma existe:

   ```js
   await chrome.alarms.getAll()
   // → [{ name: "codecrypto:pending-txs", periodInMinutes: 0.5, ... }]
   ```

4. **[worker]** ahora simula lo que la documentación de Chrome advierte — que la
   alarma **no sobrevive de forma fiable** al reinicio del worker:

   ```js
   await chrome.alarms.clear('codecrypto:pending-txs')
   await chrome.alarms.getAll()   // → []
   ```

5. Mata el worker. En `chrome://serviceworker-internals/` búscalo y pulsa
   **Stop**; si no aparece, deja pasar ~30 s sin tocar nada hasta que la tarjeta
   de `chrome://extensions` diga que el service worker está inactivo.

6. Despiértalo abriendo el popup. **[worker]** confirma en su consola que salió
   `[codecrypto] background service worker alive` — **sin esa línea no ha
   reiniciado y el paso siguiente no prueba nada**.

7. **[worker]**:

   ```js
   await chrome.alarms.getAll()
   ```

   **Esperado: la alarma está de vuelta**, con `periodInMinutes: 0.5`.

8. **[T-anvil]** deja que pase el minuto. **Esperado:** salta la notificación de
   escritorio de transacción confirmada, y en **[popup]** el panel de actividad
   tiene la línea `transaction confirmed`.

> **Por qué el paso 4 no sobra.** Sin borrar la alarma a mano, Chrome podría
> conservarla por su cuenta y el paso 7 saldría verde aunque el rearme no
> existiera — la comprobación pasaría por el motivo equivocado. Borrarla es lo
> que hace que esto mida el rearme y no la persistencia de Chrome.

> **Resultado (Chrome Stable · 17-18 de agosto de 2026): PASA.** Y el setup costó dos intentos, que es parte del
> hallazgo.
>
> **El intento que falló:** con `anvil --block-time 60` y con `600`, la
> transacción **se minó durante los ~30 s de espera** del paso 5, así que
> `standDown` desarmó la alarma correctamente y el paso 7 devolvía `[]`. Un
> **falso negativo**: parecía que el rearme no funcionaba cuando lo que pasaba
> es que ya no había nada que rearmar. Sirvió de paso para verificar algo que
> esta comprobación no buscaba — que el barrido de arranque **reconcilia,
> notifica y limpia**, no solo rearma.
>
> **El setup que sirve es `anvil --no-mining`**, que deja la transacción en
> vuelo indefinidamente.
>
> Secuencia final: tx en vuelo → alarma armada → **borrada a mano** →
> DevTools y pestaña de la dApp cerrados, ~30 s quieto, tarjeta en
> *service worker (inactive)* → popup abierto → línea `background service
> worker alive` confirmada → `chrome.alarms.getAll()` devuelve
> `codecrypto:pending-txs` con `periodInMinutes: 0.5` **y un `scheduledTime`
> POSTERIOR al `sentAt` de la pendiente** — o sea una alarma NUEVA, no la vieja
> resucitada. La pendiente seguía viva. Después, `cast rpc anvil_mine` →
> notificación y línea `transaction confirmed`, con **8 minutos entre
> `transaction sent` y `transaction confirmed`** y el worker muerto y
> reiniciado en medio.
>
> **Y el paso 4 no sobraba, con nombre y todo:** las alarmas de esta extensión
> llevan `persistAcrossSessions: true`. Sin borrarla a mano, el paso 7 habría
> medido **la persistencia de Chrome** en vez del rearme, y habría pasado
> aunque el barrido no existiera.

---

## 83. La notificación de minado en Anvil, por el camino rápido

Anvil mina en un segundo y la alarma no baja de 30 s, así que sin el atajo el
aviso llegaría medio minuto tarde para algo instantáneo.

1. **[T-anvil]** `anvil` (sin `--block-time`, minado instantáneo).
2. **[dApp]** envía una transacción y apruébala.
3. Cuenta. **Esperado: la notificación de "Transaction confirmed" aparece en
   unos 3 segundos**, no en 30.
4. **[popup]** el panel de actividad tiene **dos** líneas `operation` para esa
   transacción: `transaction sent` y `transaction confirmed`.

> El atajo es **mejor esfuerzo**: si Chrome hubiera suspendido el worker antes de
> los 3 s, el aviso llegaría igualmente pero al saltar la alarma. Que tarde 30 s
> no es un fallo; que no llegue nunca sí.

> **Resultado (Chrome Stable · 17-18 de agosto de 2026): PASA.** Tres segundos exactos — 4:27:37 → 4:27:40 — y las
> dos líneas `operation` (`transaction sent` y `transaction confirmed`). Camino
> rápido confirmado: no esperó a la alarma.

---

## 84. La misma, en Sepolia, con los 12-15 segundos de verdad

Éste es el caso que el `await tx.wait()` no habría sobrevivido nunca.

1. **[popup]** cambia a **Sepolia**. Necesitas fondos de un faucet.
2. **[dApp]** envía una transacción pequeña y apruébala.
3. **Inmediatamente**, **[worker]**:

   ```js
   (await chrome.storage.local.get('cc:pendingTxs'))['cc:pendingTxs']
   // → { "0xaa36a7:0x…": { hash, chainId, sentAt, accountIndex, origin } }
   ```

   La clave lleva **chainId y hash**, y `origin` es el de la dApp.

4. **Deja el navegador quieto** y espera. **Esperado: la notificación llega**, y
   `cc:pendingTxs` vuelve a `{}`.

> Lo que se está probando es que la espera vive en **disco** y no en una promesa.
> Si quieres verlo del todo, mata el worker en el paso 4 antes de que se mine:
> el aviso llega igual cuando la alarma lo despierta.

> **Resultado (Chrome Stable · 17-18 de agosto de 2026): PASA.** Sepolia real, con Anvil apagado. La clave fue
> `0xaa36a7:0x537810a3…` — **el chainId de Sepolia y no el de Anvil**, así que
> la identidad compuesta distingue redes dentro del mismo historial, que es
> justo para lo que se eligió. Espera real de 12-15 s con el navegador quieto y
> la notificación llegó.
>
> Es el escenario que un `await tx.wait()` no habría sobrevivido nunca, medido
> contra red de verdad y no contra un nodo local.

---

## 85. Una transacción revertida NO se cuenta como fallida ni como pendiente

Las tres respuestas del nodo son distintas y el código las trata distinto:
`null` (aún no minada), `status: 1` (minada), `status: 0` (**minada y
revertida** — gastó gas y está en la cadena).

1. **[T-anvil]** `anvil`.
2. **[dApp]** manda una transacción que revierta: a un contrato que lance, o con
   `gas` fijado tan bajo que se quede sin él.
3. **Esperado:** notificación con título **"Transaction reverted"**, no
   "confirmed" ni "failed".
4. **[popup]** el panel tiene la línea `transaction reverted` en nivel
   **`operation`**, no en `error`, y por tanto **no está en rojo**.

> El rojo de la spec 15 significa "la wallet devolvió un código de error a una
> dApp". Una reversión es la cadena contestando bien a lo que se le pidió. Si
> esto sale rojo, alguien ha cambiado el nivel y el rojo ha dejado de significar
> algo concreto.

> **Resultado (Chrome Stable · 17-18 de agosto de 2026): PASA.** Contrato en `0xe7f1725E…` con runtime
> `0x60006000fd`, **verificado con `cast code` y `cast call` ANTES de medir**.
> Eso no es celo: una dirección sin código acepta una transferencia
> normalmente, así que medir sobre ella habría dado un falso negativo — la
> transacción se habría confirmado y la comprobación habría "fallado" por el
> motivo equivocado.
>
> Receipt con `status 0`, notificación **"Transaction reverted"**, línea de
> nivel `operation`, y **no aparece bajo el filtro Errors**.

---

## 86. El descarte a la hora deja rastro, y no dice "failed"

La hora no se espera: se falsea la fecha de envío.

1. **[dApp]** envía una transacción con **[T-anvil]** `anvil --block-time 600`,
   para que no se mine.
2. **[worker]** envejece la entrada a mano:

   ```js
   const key = 'cc:pendingTxs';
   const all = (await chrome.storage.local.get(key))[key];
   const id = Object.keys(all)[0];
   all[id].sentAt = Date.now() - 61 * 60 * 1000;   // hace 61 minutos
   await chrome.storage.local.set({ [key]: all });
   ```

3. Espera a que salte la alarma (máximo 30 s) o abre el popup para despertar al
   worker.
4. **[worker]**:

   ```js
   (await chrome.storage.local.get('cc:pendingTxs'))['cc:pendingTxs']   // → {}
   ```

5. **[popup]** el panel tiene la línea **`stopped tracking transaction`** con
   `waitedMinutes: 61`.

**Esperado, y las dos mitades importan:**
- la línea **NO** dice "failed" ni "error" — la transacción puede seguir en la
  mempool y minarse mañana; lo que ha pasado es que la wallet deja de mirar;
- **NO** aparece ninguna notificación de escritorio: al usuario no le ha pasado
  nada nuevo.

> **Resultado (Chrome Stable · 17-18 de agosto de 2026): PASA.** Con `sentAt` envejecido a −61 minutos:
> `cc:pendingTxs` quedó en `{}` y salió la línea `stopped tracking
> transaction` con `waitedMinutes: 61`. **No dice "failed"** y **no hubo
> notificación**, que eran las dos mitades.
>
> Detalle que confirma el diseño: esta línea **sí lleva origen**, porque la
> transacción venía de la dApp — al contrario que las de la 91, que no lo
> llevan porque no las pidió ninguna web.

---

## 87. El panel de actividad: colores, filtro, colapso y copiar

**[popup]**, con la wallet ya usada un rato (conecta una dApp, pide saldos,
firma algo, provoca un error).

1. **Colores.** Las líneas `error` salen en rojo; las de `event`, `operation` y
   `call` no. El rojo es solo del nivel `error`.
2. **Filtro.** Los cinco botones — *All, Calls, Events, Operations, Errors* —
   filtran de uno en uno. **Los cuatro niveles son las specs 13-16 una a una**,
   así que pulsarlos por orden es la demostración de las cuatro.
3. **Colapso.** Recarga la dApp varias veces seguidas para provocar repeticiones
   del mismo método. **Esperado:** una sola fila con `×N`, **no N filas**.
4. **Colapso de verdad, no salteado.** Provoca A, A, B, A: pide saldo dos veces,
   firma, y pide saldo otra vez. **Esperado: cuatro cosas en TRES filas** —
   `eth_getBalance ×2`, la firma, `eth_getBalance`. Si sale `×3` y la firma, el
   panel está reordenando y miente sobre el orden.
5. **Vacío.** Con un perfil recién instalado, el panel dice *"Nothing has
   happened yet."*. Con el filtro *Errors* puesto y sin errores, dice *"Nothing
   of this kind in the log."*. **Son dos frases distintas a propósito**: decir lo
   mismo haría pensar que el filtro está roto.
6. **Copiar.** Pulsa *Copy logs*, pega en un editor. **Esperado:** JSON válido
   con las entradas completas. El botón dice *Copied* un segundo.
7. **En vivo.** Deja el popup abierto y provoca actividad desde **[dApp]**.
   **Esperado:** el panel se actualiza **sin cerrarlo y abrirlo**.

> **Resultado (Chrome Stable · 17-18 de agosto de 2026): PASA**, con un sub-paso no reproducible y dicho.
>
> (1) Solo las de nivel `error` en rojo. (2) Los cinco filtros funcionan uno a
> uno. (3) Un bucle de cinco `eth_chainId` dio **una fila con `×6`** — la sexta
> era una llamada previa idéntica y adyacente, o sea que el colapso funcionó
> exactamente como debe. (6) *Copy logs* → JSON válido. (7) Actualización en
> vivo con el popup en pestaña propia y F5 en la dApp.
>
> **(4) es el que importa, y salió: A, A, B, A → TRES filas** —
> `eth_chainId ×8`, `eth_accounts`, `eth_chainId`. El `eth_accounts` **parte el
> run**. Si el panel agrupara salteado habrían salido dos filas con `×9`.
>
> **(5) NO REPRODUCIBLE, y se deja escrito en vez de darlo por bueno:** el
> registro ya tiene entradas de los cuatro niveles, así que ningún filtro queda
> vacío y el segundo mensaje no se puede provocar. Los dos textos están
> cubiertos por los tests de `log-view.ts`. No se vació `cc:logs` a propósito,
> para no arriesgar el historial que la 93 necesita.

---

## 88. Ningún secreto en el registro

**[dApp]**, con la wallet conectada. Firma un EIP-712 cuyo payload lleve un campo
con nombre inventado:

```js
await provider.request({
  method: 'eth_signTypedData_v4',
  params: [addr, JSON.stringify({
    domain: { name: 'Evil dApp', chainId: 31337 },
    primaryType: 'Note',
    types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }],
             Note: [{ name: 'userBackupPhrase', type: 'string' }] },
    message: { userBackupPhrase: 'test test test test test test test test test test test junk' },
  })],
})
```

**[popup]** pulsa *Copy logs* y busca en lo pegado:

- **`userBackupPhrase` NO aparece.**
- **La frase NO aparece.**
- Sí aparece la línea `call` con `eth_signTypedData_v4` y el origen.

> El nombre del campo lo elige la dApp, así que ninguna lista de métodos podría
> anticiparlo. Lo que protege es que la estructura no pasa: solo escalares planos
> construidos por la wallet.

> **Resultado (Chrome Stable · 17-18 de agosto de 2026): PASA.** Con un EIP-712 cuyo campo `userBackupPhrase` lo
> inventó la dApp: **ni el nombre del campo ni la frase** aparecen en
> `cc:logs`. Sí está la línea `call` con su origen, y la `operation` con
> `accountIndex` y `chainId` y nada más.
>
> **Hallazgo lateral, guardado como material de vídeo:** el volcado contiene
> entradas **anteriores al commit del escritor nuevo** con el payload completo
> de `wallet_addEthereumChain` dentro — `chainName`, `rpcUrls`,
> `nativeCurrency`— y otras con `detail: "[redacted]"`. Es la denylist vieja y
> su agujero, visibles en el propio dato: lo que la lista nombraba salía
> tapado, y lo que no nombraba salía entero.

---

## 89. El badge sobrevive a la muerte del worker

1. **[dApp]** lanza **dos** peticiones que abran ventana (dos firmas seguidas) y
   **no decidas ninguna**.
2. El badge de la extensión marca **2**.
3. Mata el worker (ver el paso 5 de la 82) sin tocar las ventanas.
4. Despierta al worker abriendo el popup. **[worker]** confirma la línea
   `background service worker alive`.
5. **Esperado: el badge sigue diciendo 2.**
6. Aprueba una. **Esperado: pasa a 1.** Cierra la otra con la X. **Esperado:
   desaparece**, y **[dApp]** recibe `4001`.

> El texto del badge es estado del NAVEGADOR y sobrevive al worker. Si nadie lo
> recalculara al arrancar, se quedaría diciendo lo que dijera antes de morir.

> **Resultado (Chrome Stable · 17-18 de agosto de 2026): PARCIAL.** Los pasos 1-4 pasan: el badge marca **2**,
> sobrevive a la muerte del worker, y la línea `background service worker
> alive` confirma el reinicio.
>
> **El paso 6 destapó un fallo real, que NO se arregla en esta fase:** el badge
> se queda obsoleto cuando una solicitud **caduca** en vez de resolverse. Se
> vio "1" con cero solicitudes vivas.
>
> El diagnóstico completo —incluida la hipótesis equivocada, descartada por
> medición— está **en `lib/badge.ts`**, junto a la nota del descarte por
> `expiresAt`. Resumen: la derivación es correcta y descarta las caducadas; lo
> que falla es el DISPARO, porque `refreshBadge()` se cuelga de
> `storage.onChanged` y **una caducidad no es una escritura**.

---

## 90. La notificación se cierra al resolver, y su clic enfoca

1. **[dApp]** pide una firma. Aparecen la ventana y la notificación.
2. Manda la ventana al fondo (pincha en otra) y **haz clic en la notificación**.
   **Esperado: la ventana que YA existía vuelve al frente. NO se abre una
   segunda.**
3. Aprueba. **Esperado: la notificación desaparece sola.**
4. Repite y esta vez **rechaza**. **Esperado: también desaparece.**
5. Repite y cierra la ventana con la **X**. La solicitud se rechaza con `4001`.
   Ahora haz clic en la notificación si sigue en pantalla. **Esperado: no pasa
   nada — no se abre ninguna ventana.**

> El paso 5 es el que importa: cerrar la ventana YA decidió. Reabrirla sería
> pedir una decisión ya tomada sobre una petición que la dApp ya contestó.

> **Resultado (Chrome Stable · 17-18 de agosto de 2026): PASA**, verificado por la consola de **[worker]** y no
> por lo que se veía en pantalla: Windows retenía las notificaciones con
> prioridad *Normal*, y hubo que subirlas a *Primera* para verlas. Que la
> comprobación no dependiera de eso es lo que la salvó.
>
> El id es `codecrypto:` + el requestId exacto. Clic → **una ventana antes, una
> después**: no se creó una segunda. Tras aprobar, la notificación de la
> solicitud desaparece y **solo quedan las de `codecrypto:tx:`** — el otro
> espacio de ids, y el caso real que habría provocado la colisión de prefijos
> que se corrigió al escribirlo. Cierre con la X → `4001 The approval window
> was closed.`, con 0 ventanas, 0 pendientes y 0 notificaciones.

---

## 91. La transferencia interna, y el borde de saldo menos fee

**[popup]**, con al menos dos cuentas y **[T-anvil]** `anvil`.

1. El desplegable de destino **no ofrece la cuenta de origen**.
2. Escribe `0` → error. `abc` → error. Un número con **19 decimales** → error.
   El botón *Send* está deshabilitado mientras haya error.
3. Manda `0.01` a la cuenta 1. **Esperado:** el botón dice *Sending…*, luego
   aparece el hash, y los saldos de las dos cuentas cambian.
4. **[popup]** el panel de actividad tiene `transaction sent` y después
   `transaction confirmed` — y **ninguna de las dos tiene origen**, porque no la
   pidió ninguna web. Compruébalo con *Copy logs*: esas dos entradas **no llevan
   campo `origin`**.
5. **El borde.** Mira el saldo exacto de la cuenta de origen e intenta enviarlo
   **entero**. **Esperado: se rechaza**, con un mensaje sobre la fee — **no** se
   abre nada, **no** lo rechaza el nodo después.
6. **NO se abre ninguna ventana de aprobación** en ningún momento de esta
   comprobación.

> El paso 5 es la razón de que el techo sea saldo **menos fee**. Si la wallet
> aceptara y el nodo rechazara después, el usuario aprendería que lo que la
> wallet acepta no significa nada — y ese hábito es el vector.

> **Resultado (Chrome Stable · 17-18 de agosto de 2026): PASA.** El desplegable excluye la cuenta activa. *Send*
> deshabilitado con `0`, con `abc` y con 19 decimales. 0.01 ETH → hash, bloque
> 7, notificación. **CERO ventanas de aprobación** en todo el recorrido.
>
> Las dos líneas `operation` muestran origen **`wallet`** y no una URL — que es
> la etiqueta que el panel pinta cuando la entrada **no tiene origen**.
> Contraste directo con las de la 83 y la 85, que muestran
> `http://localhost:3000`.
>
> **El borde:** 9999.9598 (el saldo completo) rechazado **en el formulario**
> con *"That is more than this account can send once the fee is taken out"* —
> sin abrir nada y **sin viajar al nodo**. Que el rechazo llegue antes del
> nodo es exactamente el punto de que el techo sea saldo menos fee.

---

## 92. El reset, con una dApp conectada delante

Ésta se hace con **[dApp]** abierta y su consola visible **todo el rato**.

1. **[dApp]** conecta la wallet y deja puestos los dos listeners:

   ```js
   provider.on('accountsChanged', (a) => console.log('accountsChanged →', a))
   provider.on('disconnect', (e) => console.log('disconnect →', e))
   ```

2. **[dApp]** lanza una firma y **déjala sin decidir**, con su ventana abierta.
3. **[popup]** pulsa *Reset wallet* → *Yes, erase it*. **Son dos pasos a
   propósito**: un solo clic no puede borrar la frase.
4. **Esperado, en este orden:**
   - **[dApp]** imprime `accountsChanged → []` **y** `disconnect → {code: 4900…}`;
   - la firma pendiente se rechaza con **4001** y su ventana **se cierra sola**;
   - el badge desaparece;
   - **[popup]** vuelve al onboarding.
5. **[worker]**:

   ```js
   await chrome.storage.local.get(null)
   ```

   **Esperado:** ya no están `cc:mnemonic`, `cc:accounts`, `cc:connectedSites`,
   `cc:pendingRequests` ni `cc:pendingTxs`. **Sí siguen** `cc:logs`,
   `cc:networks` y `cc:providerUuid`.

> Los dos eventos, no uno. `accountsChanged: []` dice "ya no tienes cuenta aquí";
> `disconnect` dice "este proveedor ya no sirve". Una dApp que solo escuche uno
> se queda a medio enterar.

> **Resultado (Chrome Stable · 17-18 de agosto de 2026): PASA.** Con la dApp conectada y una firma pendiente:
> `accountsChanged → []`, `4001 "The wallet was reset while this request was
> waiting."` y `disconnect → 4900 "The wallet was reset."`. La ventana se cerró
> sola, el badge desapareció y el popup volvió al onboarding.
>
> Storage: sobreviven `cc:chainId`, `cc:logs`, `cc:networks` y
> `cc:providerUuid`; mueren `cc:mnemonic`, `cc:accounts`, `cc:connectedSites`,
> `cc:pendingRequests` y `cc:pendingTxs`.
>
> **Apareció además `cc:spike`**, residuo manual de los spikes de las
> comprobaciones 79 y 81 (`surface: 'popup-window'`, 15 entradas). No lo
> escribe ningún código. **Que sobreviva es CORRECTO**, y conviene decir por
> qué: `RESET_CLEARED_KEYS` es una lista explícita de lo que el código conoce,
> no un "borra todo menos". Un reset que borrara claves ajenas estaría
> decidiendo sobre datos que no son suyos. Borrada a mano.

---

## 93. El registro sobrevive al reset, y la línea del reset está dentro (spec 24)

Justo después de la 92, **sin recargar nada**:

1. **[popup]** completa el onboarding con el mnemonic de Anvil (el panel de
   actividad no se ve sin wallet).
2. Mira el panel. **Esperado:**
   - **las líneas anteriores al reset siguen ahí** — las llamadas de la dApp, los
     eventos, las operaciones;
   - **hay una línea `wallet reset`** de nivel `operation`, con `sites: 1`.

> Es auto-referencial a propósito: la línea que anota el borrado sobrevive al
> borrado que anota. Vaciar la wallet no es lo mismo que borrar lo que pasó, y
> ésta es la única forma de verlo.

**Y lo que NO debe pasar:** que el panel salga vacío. Si sale vacío, `cc:logs`
ha caído del lado que muere y la spec 24 está rota.

> **Resultado (Chrome Stable · 17-18 de agosto de 2026): PASA.** Tras reimportar, el historial anterior al reset
> está intacto, y dentro está la línea `wallet reset` de nivel `operation`, con
> origen `wallet` y `detail` = `{"pendingRequests":1,"sites":1}` — o sea que
> registra **qué se llevó por delante** ese reset concreto.
>
> Y no es un número fijo: en el reset de la comprobación 94, la misma línea
> salió con `pendingRequests: 0`. El detalle refleja cada caso.

---

## 94. La alarma no se queda huérfana después de un reset

Camino que no estaba en el plan y que apareció al escribir la 92.

1. **[T-anvil]** `anvil --block-time 600`.
2. **[dApp]** envía una transacción y apruébala: queda en vuelo.
3. **[worker]** `await chrome.alarms.getAll()` → **la alarma existe**.
4. **[popup]** haz un reset completo.
5. **[worker]**, en los siguientes segundos:

   ```js
   await chrome.alarms.getAll()   // → []
   ```

   **Esperado: vacío.** El reset borra `cc:pendingTxs` sin pasar por ninguna
   reconciliación, así que si la alarma siguiera ahí estaría despertando al
   worker cada 30 s para mirar una clave que ya no existe.

> No era una fuga permanente —al dispararse, el barrido la habría desarmado—
> pero sí un despertar para nada, y nada lo delata: no hay error, no hay log, y
> una alarma no se ve.

> **Resultado (Chrome Stable · 17-18 de agosto de 2026): PASA.** Antes del reset: alarma armada y una pendiente en
> vuelo. Después: `chrome.alarms.getAll()` → `[]` y `cc:pendingTxs` →
> `undefined`.
>
> El desarme lo hizo el **listener de storage** llamando a `standDown`, sin
> ninguna llamada explícita desde el reset — que era el motivo de ponerlo en el
> punto común y no en el camino que lo destapó.

---

## 95. La tarjeta de la extensión, sin avisos nuevos

Como la 55, repetida porque esta fase añadió un permiso.

En `chrome://extensions`, la tarjeta de CodeCrypto Wallet **no muestra ningún
error ni aviso**. Y en *Details*, la lista de permisos incluye ahora **alarms**
además de storage, tabs y notifications.

> `alarms` es un permiso normal, no de host: no pide diálogo al usuario y no roza
> nada de lo medido en la comprobación 79.

> **Resultado (Chrome Stable · 17-18 de agosto de 2026): PASA.** Tarjeta sin errores, con *Collect errors* activo.
>
> **Y una trampa que conviene dejar escrita:** la UI de *Details* lista solo
> `tabs` y `notifications`. Chrome **no muestra** `storage` ni `alarms` porque
> los clasifica como permisos sin advertencia al usuario, así que esa pantalla
> **no sirve** para comprobar que el permiso está. La fuente correcta es el
> manifest cargado:
>
> ```js
> chrome.runtime.getManifest().permissions
> // → ['storage', 'tabs', 'notifications', 'alarms']
> ```
>
> Mirar la UI y concluir que falta `alarms` habría sido leer el artefacto
> equivocado — la comprobación 79 otra vez, en pequeño.
