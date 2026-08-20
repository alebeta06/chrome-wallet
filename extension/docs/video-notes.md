# Material para el video

Momentos del código que merecen que la cámara entre. No es documentación de la
wallet: es la lista de sitios donde algo *parece* correcto y no lo es, o donde
una decisión pequeña cambia lo que el usuario puede juzgar.

---

## Fase 8

### El verificador que siempre habría dicho que sí

`src/lib/chain.ts` → `fetchChainId`

Cuando una dApp pide `wallet_addEthereumChain`, la wallet tiene que comprobar que
el RPC propuesto es de verdad la cadena que la dApp declara. La forma natural de
escribirlo en ethers es ésta:

```ts
const provider = createRpcProvider(candidate);
const actual = (await provider.getNetwork()).chainId;   // ← siempre coincide
```

Y **siempre** habría dicho que sí.

El provider de este proyecto se construye con la red en el constructor y
`staticNetwork: true`, precisamente para no gastar una petición detectándola
(está medido: ver la NOTA de `createRpcProvider`). Eso significa que
`getNetwork()` devuelve **lo que le dimos** — que es exactamente la afirmación
que estamos intentando verificar. El verificador confirmaría el dato con el
propio dato.

Lo que lo hace buen material es que no se ve al leerlo. El código dice
"pregúntale al proveedor en qué cadena está", parece que va a la red, compila,
pasa cualquier test escrito con un doble que devuelve lo esperado, y solo falla
en el único caso para el que existe: un endpoint que miente.

La forma correcta es bajar un nivel y hablar JSON-RPC crudo:

```ts
return (await provider.send("eth_chainId", [])) as string;
```

`send` va al cable. La optimización que hace rápido el resto de la wallet es la
que habría roto la única comprobación que no puede fiarse de nadie.

> Generalizable: **una optimización que evita preguntar es veneno para el código
> cuya razón de existir es preguntar.** Y el daño no se ve en la revisión,
> porque la línea envenenada es la que parece más limpia.

### La URL que no se acorta

`src/ui/notification/AddChainPrompt.tsx`

En toda la wallet las direcciones se acortan — `0xf39F…2266` — porque veinte
bytes en hexadecimal no los lee nadie y el prefijo basta para reconocerlos.

En la ventana de alta de red, la `rpcUrl` va **entera, sin truncar y en
monoespaciada**. Es la excepción, y es deliberada:

```
polygon-rpc.com
polygon-rpc.com.evil.io
```

Se distinguen **por el final**. Acortar por el medio —el patrón que se usa para
las direcciones— borraría justo la parte que decide si el usuario debe aprobar,
y dejaría dos URLs completamente distintas viéndose idénticas en pantalla.

> Generalizable: **truncar es una decisión sobre qué parte del dato importa.**
> En una dirección importa el principio; en un dominio importa el final. Aplicar
> el mismo formateador a los dos porque "los dos son cadenas largas" convierte un
> control de seguridad en decoración.

### El dueño de la wallet no se aprueba a sí mismo

`src/ui/network/` frente a `src/ui/notification/AddChainPrompt.tsx`

Añadir una red tiene dos entradas: una dApp pidiéndolo, y el usuario haciéndolo
desde la propia wallet. La tentación es que las dos pasen por la misma ventana de
aprobación — un solo camino, menos código, y suena a más seguro.

Es al revés. El usuario teclea cinco campos, pulsa "Add network", y le aparece
una ventana preguntándole si aprueba lo que acaba de escribir. Eso no protege de
nada: no hay tercero a quien nombrar, no hay nada que él no sepa ya, y la
respuesta es sí por construcción.

Lo que sí hace es **gastar la moneda**. Cada ventana de aprobación que aparece
para algo inevitable enseña a pulsar sin leer, y ese hábito se lo lleva puesto
después la ventana que sí importaba — la de una dApp pidiendo firmar algo.

> **Una aprobación que no puede acabar en "no" no es una aprobación: es un paso
> más.** Y devalúa a las que sí lo son.

Lo que se bifurca es **quién pregunta**. Lo que se verifica no:

```
finaliseAdd()          ← permiso concedido, eth_chainId comprobado,
   ↑         ↑            revocar si mintió, persistir
addChain   addNetworkFromWallet
 (dApp)      (nuestra UI)
   ↑            ↑
 APRUEBA     no aprueba
```

El permiso de Chrome y la verificación del chainId son obligatorios en los dos
caminos, y viven en un solo sitio. La aprobación es lo único que sobra cuando el
que pide es el dueño.

### La revocación que la plataforma no deja hacer

`src/lib/permissions.ts` → `revoke`

La wallet tiene una regla de seguridad clara: si el RPC que una dApp propone
**miente** sobre qué cadena sirve —lo declara `0x2a` y `eth_chainId` responde
otra cosa—, la red no se añade y se le retira el permiso de host que el usuario
acababa de conceder. Es el único caso en que la wallet le quita al usuario algo
que él dio, y está escrito, comentado y probado.

No funciona. **No puede funcionar.**

```
chrome.permissions.remove({ origins: ["http://localhost:8546/*"] })
  → THREW: You cannot remove required permissions
```

Y el host no está en el manifest. Es un host limpio. Falla igual.

La causa no está donde se busca. La primera hipótesis —la que cualquiera
tendría— es que el comodín `https://*` de `optional_host_permissions` sea
demasiado ancho. Se midió, y es falsa. La causa es ésta:

```jsonc
"content_scripts": [{ "matches": ["<all_urls>"], … }]
```

Chrome instala los `matches` de un content script como permisos **requeridos**, y
`remove()` se niega a tocar cualquier patrón contenido en los requeridos.
`<all_urls>` contiene todos. Con esa línea en el manifest, la extensión no puede
revocar **ningún** host, nunca.

Y una wallet no puede quitarla: se inyecta en cualquier sitio o no es una wallet.

Lo bonito de contarlo es que las dos mitades del experimento dicen lo contrario
la una de la otra, y se ven en una pantalla:

```
content script estrecho + comodín intacto    →  revoca de verdad
<all_urls>       + comodín estrechado a uno  →  sigue lanzando
```

> Generalizable: **hay decisiones de diseño que la plataforma no te deja tomar, y
> no te lo dice al compilar.** El código estaba bien escrito, los tests pasaban,
> y la invariante que el proyecto afirmaba de sí mismo era falsa desde el primer
> día. Solo se cae midiendo — y midiendo sobre el artefacto que envías, no sobre
> uno parecido.

---

## Fase 9

### Corrección de hecho: quién caza el cierre de la ventana

**Antes de grabar nada sobre el flujo de aprobación, esto:** el rechazo `4001`
cuando el usuario cierra la ventana con la X **NO** lo produce
`chrome.windows.onRemoved`. Este proyecto **no usa esa API en ningún sitio**.

Lo caza el **`onDisconnect` del puerto keep-alive** que `connect.html` y
`notification.html` abren contra el service worker (`background.ts`). El nombre
del puerto lleva el `requestId` dentro, así que se sabe exactamente qué solicitud
rechazar.

Y la diferencia no es de nombres, que es lo que la hace contable:

| | cierra con la X | la página crashea | la página navega a otro sitio |
|---|---|---|---|
| `windows.onRemoved` | sí | **no** | **no** |
| `port.onDisconnect` | sí | **sí** | **sí** |

En los tres casos la ventana deja de poder decidir, así que en los tres hay que
rechazar. El puerto los cubre porque **cae por sí solo**: no hay que enumerar los
motivos por los que una ventana deja de estar.

> Generalizable, y es el ángulo para la cámara: **el mecanismo que se cae solo
> gana al que hay que acordarse de disparar.** Un listener de "ventana cerrada"
> obliga a enumerar todas las formas de dejar de estar; un puerto que se
> desconecta no distingue entre ellas porque no le hace falta.

**El límite, que también va dicho:** si el service worker ya está suspendido, no
hay puerto que caiga, así que cerrar la ventana no rechaza nada y la dApp espera
los 120 s completos sin recibir error. Está medido (comprobación 89) y anotado
junto al propio `onDisconnect`.

> **Ojo al guion:** el enunciado del proyecto (§7.4) dice `windows.onRemoved`. Es
> un error de hecho del documento, no del código. Si el guion lo copia, el vídeo
> explica un mecanismo que la wallet no tiene.
