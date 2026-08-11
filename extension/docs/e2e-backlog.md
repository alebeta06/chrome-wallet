# Backlog de Playwright — Fase 10

Escenarios que la Fase 8 identificó y **no** automatiza. Los tres primeros no son
deuda por descuido: Playwright es la Fase 10 y no está instalado en ninguno de
los dos proyectos, así que automatizarlos ahora significaría montar el harness
entero —Chrome con `--load-extension`, resolver el id de la extensión en runtime,
esperas de eventos entre pestañas— dentro de una fase que va de redes.

**El cuarto es de otra clase**: no se eligió dejarlo fuera, lo perdimos. Léelo
con eso en la cabeza.

Lo que sí se cubre hoy está en `tests/events.test.ts` (a quién llega
`chainChanged`) y en las comprobaciones manuales de `manual-checks.md`.

---

## 1. `chainChanged` llega a dos pestañas reales

Cambiar de red desde el popup con dos pestañas abiertas y afirmar que **las dos**
reciben `chainChanged` a través de su content script.

**Qué añade sobre el test unitario.** El unitario fija a quién se dirige el
evento —`eventTargets` con `EVENT_SCOPE.chainChanged === "global"`— pero se
detiene en el `chrome.tabs.sendMessage`. Lo que no puede comprobar es el tramo
que va de ahí a la dApp: que el content script lo relaye a la página, que
`inject.ts` lo emita por su `EventTarget`, y que el `expectedOrigin: null` de un
evento global no se caiga en la comprobación de origen del content script.

**El caso que más importa: dos pestañas del MISMO origen.** Con dos orígenes
distintos, un filtro por origen mal puesto pasaría igualmente. Con dos pestañas
del mismo origen se caza además cualquier dedupe accidental —quedarse con
`tabs[0]`, que es el error clásico— y ese es exactamente el fallo que deja una
pestaña mostrando la red vieja mientras la otra ya cambió.

## 2. `wallet_addEthereumChain` — NO automatizable

Queda como **comprobación manual**, no como test pendiente.

El flujo pasa por `chrome.permissions.request()`, que abre un diálogo **nativo
de Chrome**: no es DOM, no está en el árbol de accesibilidad de la página y
Playwright no lo alcanza. No hay forma de aceptarlo desde el test.

Pre-conceder el permiso en el perfil para saltarse el diálogo tampoco sirve:
eliminaría del test justamente el paso que se quiere comprobar, y lo que
quedaría —que el background persiste una red— ya está cubierto en
`tests/network-store.test.ts`.

## 3. Aprobación pendiente con el chainId desviado

Abrir una firma, cambiar de red mientras la ventana está abierta, aprobar, y
afirmar que se **rechaza** en vez de firmar contra la red equivocada.

**Por qué el unitario no basta.** El caso vive en el tiempo: la solicitud captura
el chainId al crearse y el cambio ocurre *entre* la creación y la aprobación. Un
test unitario puede simular esa secuencia, y lo hace, pero no puede reproducir
lo que la hace posible en el navegador — que la ventana de aprobación siga viva
mientras el service worker se suspende y despierta por debajo.

## 4. La UI de una red sin acceso

Tres piezas concretas, sin cobertura de ningún tipo desde el 10 de agosto de 2026:

1. **La fila de la red inalcanzable**: atenuada, tachada y con el chip
   `no access`. Sigue en la lista a propósito — si desapareciera, el usuario
   iría a añadirla otra vez, que es la acción equivocada porque ya la tiene.
2. **El botón *Restore***: abre la ventana de red con los datos rellenos, en modo
   *"Restore access"*, con **los campos bloqueados** —se reconcede lo que la
   wallet tiene guardado, no lo que el usuario escriba— y un aviso explicando qué
   pasó.
3. **El banner de red inalcanzable**, arriba del popup y **separado del banner de
   saldos**. Son dos cosas distintas con arreglos distintos: "no llego al nodo" y
   "no tengo permiso" no se resuelven igual, y fundirlas en un aviso genérico
   deja al usuario sin saber cuál de las dos le pasa.

> **Actualización del 10 de agosto de 2026 — el agujero se cerró en parte.** La
> comprobación 80 encontró la vía: mover Site access a *On click* retira los
> permisos, así que las 76 y 77 vuelven a ser ejecutables a mano y esta UI vuelve
> a tener quien la mire. Lo que sigue faltando es la automatización, que es lo
> que se pide aquí — y sigue mereciendo la pena por lo de siempre: una
> comprobación manual se pasa cuando alguien se acuerda.

### Por qué este agujero es distinto de los otros tres

Los tres de arriba se dejaron sin automatizar **por una decisión**: Playwright es
la Fase 10 y montar el harness dentro de una fase de redes no salía a cuenta.
Éste **se abrió solo**. Lo cubrían las comprobaciones manuales 76 y 77, que se
pasaban y encontraban cosas, hasta que el 10 de agosto de 2026 se midió que
`chrome://extensions` ya no ofrece control por host: sin forma de revocar un
permiso —ni a mano ni por código, ver la comprobación 79— el estado que esas dos
comprobaciones necesitaban dejó de ser alcanzable.

**No es deuda por descuido, y no es deuda por prioridad: es cobertura que el
navegador retiró.** Importa al leerlo porque cambia qué hacer con ello. Una
comprobación que nadie escribió se escribe; ésta ya estaba escrita y era buena,
así que el trabajo no es diseñarla sino **encontrarle un camino nuevo al mismo
estado**.

### Un camino candidato, SIN medir — y sigue haciendo falta

El estado que hace falta es *"red en el catálogo cuyo host no está concedido"*, y
retirar permisos no es la única forma de llegar: **sembrar el catálogo
directamente** con una red cuyo host nunca se concedió debería producir el mismo
observable, porque `unusableChainIds` se deriva en vivo con `contains()` y no se
persiste nunca (ver `dispatch.ts`). Desde la consola de una página de la
extensión, escribir en `cc:networks` una entrada con un `rpcUrl` jamás concedido.

**La comprobación 80 lo dejó NO URGENTE, no inútil.** El interruptor de Site
access ya desbloquea las 76 y 77, así que esto ha dejado de ser la única vía. Lo
que no ha dejado de ser es **la única que aísla UNA red al RETIRARLA**.

Y aquí hay una asimetría que conviene tener clara antes de diseñar el e2e, medida
el 10 de agosto de 2026 al pasar la 76:

| Dirección | ¿Distingue hosts? |
|---|---|
| **retirar** — interruptor de Site access | **no**: se lleva todas a la vez |
| **recuperar** — `permissions.request()` desde la ventana Restore | **sí**: se restauró Anvil Two dejando Anvil Local y Sepolia tachadas |

Así que se puede llegar a "una sola red sin permiso" **por resta**: retirar todas
con el interruptor y recuperar las que sobran una a una. Sirve, pero es un
camino largo, con un diálogo nativo por red —el mismo que el punto 2 dice que
Playwright no alcanza— y con el estado dependiendo del orden. Para un test
automatizado, sembrar `cc:networks` sigue siendo la vía limpia.

Quién lo necesita, en concreto:

- **La comprobación 59b**, que medía que perder el permiso de una red que **no**
  era la activa te deja donde estabas. Por el interruptor es irreproducible —la
  activa cae siempre—, y sin sembrado no tiene camino manual ninguno.
- **Playwright en esta fase**, con bastante probabilidad: un e2e que mueva un
  ajuste de `chrome://extensions` está fuera del DOM de la página, exactamente
  el mismo problema que el diálogo nativo del punto 2. Sembrar storage sí es
  alcanzable desde un test.

Dos advertencias antes de fiarse:

- **Está sin medir.** Es una deducción a partir de cómo se calcula
  `unusableChainIds`, no una comprobación hecha.
- **No cubre la transición.** Da el estado, no el evento: no dispara
  `permissions.onRemoved` ni la caída de la red activa. Para eso está el
  interruptor, que ya se midió y sirve.

---

## Recordatorio para quien monte esto

Un test que necesita un `await` intermedio para pasar probablemente no está
probando el caso real: si el navegador no pone esa espera, quítala y mira si
sigue verde. Los tests concurrentes lanzan las llamadas sin `await` entre ellas
y esperan al final.
