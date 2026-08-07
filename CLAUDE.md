# CodeCrypto Wallet — Chrome Extension (MV3)

Wallet de Ethereum como extensión de Chrome. Práctica del Máster CodeCrypto.
Proyecto de 11 fases. Sin smart contracts en el alcance.

## Estructura del repo

**Dos proyectos independientes**, cada uno con su `package.json` y su lockfile.
No hay workspace de pnpm en la raíz, y es deliberado: no comparten código, y
Vercel necesita instalar solo lo de `dapp/`.

```
extension/     la wallet — service worker, popup, provider inyectado
dapp/          dApp Next.js 15 que consume el provider desde fuera
docs/          DEPLOY.md
```

**La dApp no importa NADA de `extension/`.** Declara EIP-1193 y EIP-6963 por su
cuenta en `dapp/src/types/eip1193.ts`, porque son estándares públicos y una dApp
real no conoce los tipos internos de la wallet. Lo único específico del proyecto
que sabe es una constante con el rdns. Si algo parece necesitar un import entre
los dos, para y pregunta: probablemente signifique que la separación se está
rompiendo.

`formatEther` y `shortenAddress` existen a los dos lados a propósito. Son
veinticinco líneas puras con su test en cada proyecto; montar un paquete
compartido para eso cuesta más que duplicarlas.

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

**`extension/`**

- Vite 7.3.6 (Rollup, `build.rollupOptions`) · React 19 · TypeScript 5.9.3 strict
- pnpm · ethers.js v6 (solo en `background.ts`)
- Prohibido: viem, web3.js, @scure/bip39, @noble/* directo
- Prohibido: `fetch`/`axios` para RPC (todo vía `ethers.JsonRpcProvider`)
- Prohibido: cargar ethers desde CDN (viola la CSP de MV3)

**`dapp/`**

- Next.js 15 App Router · React 19 · TypeScript 5.9.3 strict
- CSS plano con custom properties, misma paleta que la extensión. Sin Tailwind.
- **Sin ethers** hasta que la Fase 7 necesite `verifyTypedData` de verdad
- El descubrimiento es solo por EIP-6963. Nunca `window.codecrypto` directo.

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

## Escrituras en storage: el read-modify-write (aprendido en la Fase 6)

`chrome.storage.local` **no tiene transacciones**, y `chrome.runtime.onMessage`
**despacha concurrente**. Cualquier clave que guarde un `Record` entero —
`cc:pendingRequests`, `cc:connectedSites`, `cc:logs` — se actualiza leyendo,
modificando y escribiendo, y eso es una carrera:

```
petición A: lee {}          petición B: lee {}
petición A: escribe {a}     petición B: escribe {b}   ← se come la A
```

**El síntoma no es un error.** No hay excepción, ni log, ni nada en consola. Lo
que pasa es que una solicitud desaparece de storage **con su ventana de
aprobación abierta delante del usuario**: la ventana dice "esta solicitud ya no
está esperando" y la dApp se queda hasta el timeout completo.

Regla: toda escritura sobre una de esas claves va por una **cadena serializada**
en el closure del módulo que la posee (ver `serialize()` en `approvals.ts`). Y la
comprobación previa —buscar un duplicado, mirar si existe— tiene que ir **dentro
del mismo turno**: separada de la escritura, dos peticiones simultáneas pasan
ambas el check.

Que la cadena no sobreviva al reinicio del worker es correcto: si el worker
murió, no hay escrituras en vuelo contra las que serializar.

### La lección del `flush()`

El test de deduplicación de la Fase 5 pasaba, y la carrera estaba ahí desde
entonces. Pasaba por esto:

```ts
const first = coordinator.requestConnect(CONNECT);
await flush();                                   // ← el culpable
const second = coordinator.requestConnect(CONNECT);
```

Ese `await` intermedio **serializaba artificialmente** dos llamadas que en el
navegador salen en paralelo. El test comprobaba un escenario que no ocurre.

> **Un test que necesita un `await` intermedio para pasar probablemente no está
> probando el caso real.** Antes de meter uno, pregúntate si el navegador lo
> pone: si la respuesta es no, quítalo y mira si el test sigue verde.

Los tests concurrentes de verdad lanzan las llamadas **sin `await` entre ellas** y
esperan al final (`await Promise.all([...])`).

### La otra mitad: comprobar que el test falla (aprendido en la Fase 8)

Quitar el `await` intermedio no basta. Un test concurrente puede estar bien
escrito —dos llamadas sin esperar entre ellas— y aun así no probar nada, porque
lo que afirma se cumple **con el bug delante**.

Pasó con esto:

```ts
await Promise.all([store.setActive(POLYGON), store.upsert(BASE)]);

// Sin cadena, una escritura pisa a la otra... y esto sigue pasando.
expect(findNetwork(networks, chainId)).toBeDefined();
```

Sin serializar se pierde uno de los dos efectos —o el cambio de red, o el alta—
pero el catálogo resultante contiene su propia red activa en los dos casos. La
aserción era sobre un invariante que el bug respeta.

> **Un test de concurrencia que no falla al desactivar la serialización no
> prueba la serialización.** Compruébalo: rompe la cadena a propósito, corre el
> test, y si sigue verde es que no sirve.

Lo que hay que afirmar son los **efectos**, uno por llamada concurrente —"la red
activa es POLYGON **y** BASE está en el catálogo"—, no un invariante que ambas
ramas satisfacen.

## Eventos: la emisión va en el punto común (aprendido en la Fase 8)

Cuando **N caminos producen el mismo efecto observable**, el aviso vive en el
punto por el que pasan todos, no repetido en cada uno.

Tres cosas mueven la red activa: el selector del popup, un
`wallet_switchEthereumChain` de una dApp, y el clampeo de la migración al
arrancar. Las tres acaban en `setActive()` del store, así que el `chainChanged`
está **ahí dentro** y no en los tres sitios.

El motivo no es evitar repetir tres líneas: es que el cuarto camino —el que
alguien añada dentro de seis meses— se va a olvidar. Y **el síntoma de
olvidarlo no es un error**: es una dApp que sigue creyendo que está en la red
anterior, firmando contra la que cree, hasta que alguien recarga la página. No
hay excepción, ni log, ni nada que lo delate.

Corolario: el punto común decide también **cuándo NO emitir**. Cambiar a la red
que ya estaba activa devuelve éxito y no emite — la llamada salió bien, pero no
ha cambiado nada que contar. Un evento que miente cuesta más que uno que falta.

## Permisos de host: cuándo se revoca (aprendido en la Fase 8)

> **Un permiso que el usuario concedió solo se revoca si el endpoint mintió.**

Mintió significa una cosa concreta y comprobable: `eth_chainId` contra el RPC
propuesto devuelve una cadena distinta de la declarada. Nada más.

| Camino | Permiso | Respuesta |
|---|---|---|
| `eth_chainId` devuelve otra cadena | **revocar** | -32602 |
| `eth_chainId` no responde | conservar | 4901 |
| el usuario rechaza | conservar | 4001 |
| cierra la ventana con la X | conservar | 4001 |
| el worker muere antes de verificar | conservar | (sin respuesta) |

Las cuatro filas que conservan dejan un **permiso huérfano**: un host alcanzable
que ninguna red del catálogo usa. Se acepta, y el motivo no es que sea inofensivo
—que lo es— sino que **la alternativa es peor**. Para recogerlos habría que
llevar nuestra propia lista de lo que hemos pedido: estado mutable en un worker
que muere, que es exactamente la lección de la Fase 6. Y no hay atajo por la API:
el spike de la Fase 8 midió que `chrome.permissions.getAll()` devuelve
`<all_urls>` por los `matches` del content script, así que **no sirve para
enumerar lo concedido**. Que reintentar el alta funcione sin segundo diálogo es
el consuelo, no la justificación.

Revocar por un nodo que no contesta castigaría un parpadeo con el diálogo nativo
entero otra vez, y no sabemos nada malo del endpoint: solo que ahora mismo no
está.

**La revocación del único caso que revoca se verifica.** `chrome.permissions.
remove()` puede resolver `true` sin revocar nada — se midió en Brave durante el
spike. Se vuelve a preguntar con `contains()`. Y si no se pudo revocar, el -32602
se devuelve igual: no se da de alta una red que mintió solo porque no pudimos
limpiar el permiso.

## Ediciones automatizadas: verificar que casaron

Un `sed`/`python` de reemplazo que no comprueba que encontró su ancla **no es
una edición, es una esperanza.**

Pasó en la Fase 8. Un script añadía dos `case` al switch de `dispatch.ts`, el
ancla no casó por un espacio, y el script terminó con éxito sin tocar nada:

```python
s = s.replace(viejo, nuevo)   # si `viejo` no está, esto no falla. No hace nada.
```

**El typecheck no lo caza**, y eso es lo que lo hace peligroso: el método
simplemente cae por el `default` del switch, que es una rama que existe y
compila. La wallet respondía 4200 a un método que estaba implementado. Lo
encontró un test, y podría no haberlo habido.

Regla: todo reemplazo automatizado lleva su `assert` antes.

```python
assert viejo in s, "ancla del switch"
s = s.replace(viejo, nuevo, 1)
```

## Un test sobre dos instancias no prueba nada (aprendido en la Fase 8)

Si el *arrange* y el *assert* operan sobre **instancias distintas**, el test pasa
contando una historia falsa.

El caso: comprobar que una firma se rechaza si la red cambia mientras la ventana
de aprobación está abierta.

```ts
const { area } = setup(CONNECTED);                    // ← área A
const { dispatch } = setup(CONNECTED, …, {
  approvals: switchingApprovals(area, SEPOLIA),       // escribe en A
});                                                   // ← lee de B
```

`setup()` crea su propia área cada vez. El cambio de red iba a un storage y el
despachador leía otro, así que el test no ejercitaba la deriva **en absoluto** —
y habría seguido verde con la comprobación borrada.

La forma correcta es una sola instancia, con un `holder` si hace falta romper el
orden de construcción:

```ts
const { approvals, holder } = switchingApprovals(SEPOLIA);
const harness = setup(CONNECTED, …, { approvals });
holder.area = harness.area;                           // la MISMA
```

> **Antes de dar por bueno un test, pregúntate sobre qué objeto opera cada
> línea.** Dos `setup()` en un test es la señal.

Y como con las otras: rómpelo a propósito y comprueba que se pone rojo.

---

Ésta es la cuarta de la misma familia: el `await` intermedio, el test de
concurrencia que no se pone rojo, la edición automatizada que no casó, y ésta.
**Las cuatro son comprobaciones que parecen hechas y no lo están.**

## Git

- Conventional Commits en inglés, atómicos por unidad lógica
- **Sin** trailers `Co-Authored-By`
- **Nunca** auto-push. El push lo hace Alejandro desde su terminal.
- Rama única: `main`

## Modo de trabajo

- Manual-approve. Proponer estructura y estrategia en texto antes de escribir.
- Investigar y verificar antes de asumir (docs, `curl`, no memoria).
- Pausar al primer fallo de test o build y diagnosticar antes de seguir.
