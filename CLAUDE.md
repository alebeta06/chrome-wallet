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

> **En Chrome la wallet NO PUEDE revocar ningún permiso de host. Lo que sigue
> describe lo que DECIDE, no lo que consigue.**

`chrome.permissions.remove()` lanza `You cannot remove required permissions` para
cualquier origen http/https mientras el manifest declare un content script con
`<all_urls>` — que es lo que declara una wallet, porque se inyecta en cualquier
sitio o no es una wallet. La cadena entera, con los archivos de Chromium, está en
la cabecera de `lib/permissions.ts`.

**Está medido en Chrome** (comprobación 79), y en las dos direcciones: con el
content script estrecho revoca de verdad, y con `<all_urls>` sigue lanzando
aunque se quite el comodín de `optional_host_permissions`. La variable causal es
`content_scripts[0].matches`. No se re-litigue con los patrones opcionales: esa
hipótesis se midió y es falsa.

> **Revocar un permiso por host es incompatible con una extensión que se inyecta
> en todos los sitios.** No es un accidente de nuestro manifest: es la forma de
> la API. Las dos salidas aparentes se cierran solas — estrechar los `matches`
> deja de ser una wallet, y registrar el content script en runtime exige permiso
> de host sobre esos orígenes, que reintroduce el mismo error por la otra rama.

Que la decisión siga escrita —y probada— no es ceremonia: es la parte cara de
razonar, y si Chrome cambia funciona sola. Lo que no vale es leer la tabla como
si describiera efectos.

El eje es **quién decide**, no qué ha pasado. Sin eso la tabla parece seis reglas
sueltas y son dos:

- las filas de *conservar* son casos en los que la wallet estaría decidiendo sola
  y sin justificación;
- las de *revocar* son la única en que tiene justificación (mintió) y la única en
  que no está decidiendo ella (el usuario borró la red).

"Mintió" significa una cosa concreta y comprobable: `eth_chainId` contra el RPC
propuesto devuelve una cadena distinta de la declarada. Nada más.

| Camino | Decisión | Efecto real en Chrome | Respuesta |
|---|---|---|---|
| `eth_chainId` devuelve otra cadena | **revocar** | **no toma** ‡ | -32602 |
| el usuario borra la red que lo usaba | **revocar** † | **no toma** | — |
| `eth_chainId` no responde | conservar | conservado | 4901 |
| el usuario rechaza | conservar | conservado | 4001 |
| cierra la ventana con la X | conservar | conservado | 4001 |
| el worker muere antes de verificar | conservar | conservado | (sin respuesta) |

La columna que cambia es la del medio, y es nueva. La de *Respuesta* no cambia
nada: los códigos son correctos y siguen siéndolo, porque no dependen de haber
podido limpiar detrás.

† **Solo si ninguna otra red del catálogo tiene el MISMO PATRÓN de origen** — no
el mismo host — y calculado **dentro del mismo turno serializado** que el
borrado, o un alta concurrente del mismo patrón se queda sin permiso entre el
cálculo y la revocación.

Por patrón y no por host porque el spike de la Fase 8 midió que Chrome guarda el
puerto dentro del permiso: `localhost:8545` y `localhost:8546` son **grants
independientes**, así que borrar la red de uno no puede tocar la del otro. Y al
revés, `https://x.com/a` y `https://x.com/b` comparten patrón —la ruta no cuenta—
así que borrar una no puede revocarle el permiso a la otra.

‡ **Éste no es un huérfano como los otros, y no se mezclan.** Las seis filas
acaban ahora en un permiso que se queda, pero cinco de ellas dejan un host del
que no sabemos nada malo —sobra un permiso y ya— y ésta deja concedido un host
que **mintió sobre su identidad** y que la wallet decidió que no quería. Eso es
una **degradación de seguridad real**, no residuo equivalente. Igualarlos hace
que el lector concluya que da lo mismo, y no da lo mismo. Lo único que sobrevive
del intento es un `console.error` con cuatro datos —quién lo pidió, la `rpcUrl`,
la cadena declarada y la que reportó el nodo—. **Y no hay salida que ofrecer:
`chrome://extensions` no da control por host** (medido en la segunda tanda de la
Fase 8), así que ni la wallet ni el usuario pueden retirarlo. El mensaje no
sugiere ninguna, porque mandar a buscar algo que no existe es peor que callar.

Las cinco filas benignas dejan un **permiso huérfano**: un host alcanzable
que ninguna red del catálogo usa. Se acepta, y el motivo no es que sea inofensivo
—que lo es— sino que **la alternativa es peor**. Para recogerlos habría que
llevar nuestra propia lista de lo que hemos pedido: estado mutable en un worker
que muere, que es exactamente la lección de la Fase 6. Y no hay atajo por la API:
el spike de la Fase 8 midió que `chrome.permissions.getAll()` devuelve
`<all_urls>` por los `matches` del content script, así que **no sirve para
enumerar lo concedido**. Que reintentar el alta funcione sin segundo diálogo es
el consuelo, no la justificación.

Ese razonamiento ha quedado **discutible por arriba**: hoy da igual lo buena que
fuera la lista, porque no habría con qué retirarlos. Se deja escrito porque
describe bien por qué no se intentó, y porque volvería a aplicar entero el día
que revocar sea posible.

Revocar por un nodo que no contesta castigaría un parpadeo con el diálogo nativo
entero otra vez, y no sabemos nada malo del endpoint: solo que ahora mismo no
está.

**La revocación se verifica igualmente, y ahora más.** No basta con mirar el
booleano de `remove()`: se vuelve a preguntar con `contains()`, que es la única
fuente que ha demostrado no mentir. Si no se pudo revocar —o sea, siempre— el
-32602 se devuelve igual: no se da de alta una red que mintió solo porque no
pudimos limpiar el permiso.

**Anomalía abierta, no explicada.** En Brave se vio `remove()` resolver `true`
sin revocar nada durante el spike de la Fase 8. La cadena de Chromium predice que
Brave debería **lanzar** igual que Chrome. O el fork diverge, o aquella anotación
está mal tomada. No se ha vuelto a medir y no se da por cerrada; queda escrita
como pregunta, que es lo honesto mientras nadie la mida.

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

## El límite de la cadena serializada (aprendido en la Fase 8)

La cadena serializada está en tres módulos y es la herramienta por defecto contra
las carreras de este proyecto. Por eso hace falta saber **qué no arregla**, o se
convierte en amuleto: se pone, se da el problema por cerrado, y el que quedaba
abierto no se busca.

> **Serializar cierra el read-modify-write sobre un dato compartido. NO ordena
> dos operaciones independientes.**

El caso, del borrado de redes. Al borrar una red hay que revocar su permiso de
host, pero solo si ninguna otra red usa el mismo patrón de origen.

**Lo que la cadena SÍ cierra** — dos borrados de redes que comparten patrón,
lanzados a la vez:

```
sin cadena:  A lee {A,B} → ve a B → conserva
             B lee {A,B} → ve a A → conserva     ← nadie revoca, huérfano
con cadena:  A borra → quedan {B} → ve a B → conserva
             B borra → quedan {}  → nadie más   → revoca   ✓
```

Las dos leen y escriben **el mismo dato**, y la cadena las pone en fila. Eso es
un read-modify-write, y es exactamente para lo que sirve.

**Lo que NO cierra** — un borrado y un alta que usa ese mismo patrón:

```
borrado: no queda nadie → revoca
alta:    (su escritura llega después) → red nueva sin permiso
```

Aquí no hay lectura-modificación-escritura compartida que ordenar: la escritura
del alta **va después y punto**. Serializar no cambia quién llega primero, solo
impide que se pisen. Un test que afirme "el alta concurrente conserva su permiso"
falla **con la cadena puesta**, porque afirma algo que la cadena nunca prometió.

Qué hacer con lo que queda abierto: no fingir que no está. Si el desenlace es
**visible y reversible** —aquí la red nueva sale en `unusableChainIds` con su
botón de reconceder— se documenta y se acepta. Lo que no vale es un comentario
diciendo que la cadena lo cubre.

> **Antes de escribir "serializado, luego seguro", pregunta si las dos
> operaciones tocan el mismo dato.** Si no lo tocan, la cadena no tiene nada que
> decir sobre ellas.

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

## Una medición sobre otro artefacto no es una medición (Fase 8, segunda tanda)

> **Antes de llevar una medición a una decisión de diseño, pregunta sobre qué
> binario y qué manifest se tomó. Si no fue el que envía, no vale.**

El spike del GATE 2 midió `contains()` **en Chrome** —con fecha y número: 0.409
ms, `unusableChainIds: []`— y `remove()` **en Brave**, donde resolvió `true` sin
revocar nada. De ahí se dio por bueno que la revocación funcionaba. `remove()` no
se midió en Chrome ni una sola vez.

La conclusión que sí se sacó era correcta —"el booleano miente, re-pregunta con
`contains()`"— y arrastró sin decirlo una suposición que nadie midió en ningún
sitio: *que por lo demás `remove()` hace su trabajo*. No la hacía, y no podía:
`content_scripts.matches: ["<all_urls>"]` estaba en el **primer** manifest, nueve
días antes del spike.

El repo hizo bien la mitad difícil — los cinco sitios donde anotó esto decían
"medido en Brave", con el nombre del navegador delante. Y aun así la conclusión
viajó a Chrome sin que nadie lo notara al releerlo. **Escribir de dónde salió el
dato no basta si al leerlo nadie comprueba que sigue aplicando.**

El síntoma, como siempre en esta familia, no es un error: el código degradaba
bien, los tests pasaban, y lo que estaba roto era lo que el proyecto **afirmaba**
de sí mismo. Una invariante documentada describía un efecto que el navegador
nunca permitió.

---

Ésta es la quinta de la misma familia: el `await` intermedio, el test de
concurrencia que no se pone rojo, la edición automatizada que no casó, el test
sobre dos instancias, y ésta. **Las cinco son comprobaciones que parecen hechas y
no lo están.** Y ésta es la peor: una medición caducada al menos fue cierta
alguna vez sobre el objeto medido — ésta no lo fue nunca.

## Git

- Conventional Commits en inglés, atómicos por unidad lógica
- **Sin** trailers `Co-Authored-By`
- **Nunca** auto-push. El push lo hace Alejandro desde su terminal.
- Rama única: `main`

## Modo de trabajo

- Manual-approve. Proponer estructura y estrategia en texto antes de escribir.
- Investigar y verificar antes de asumir (docs, `curl`, no memoria).
- Pausar al primer fallo de test o build y diagnosticar antes de seguir.
