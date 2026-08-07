# Backlog de Playwright — Fase 10

Escenarios que la Fase 8 identificó y **no** automatiza. No es deuda por
descuido: Playwright es la Fase 10 y no está instalado en ninguno de los dos
proyectos, así que automatizarlos ahora significaría montar el harness entero
—Chrome con `--load-extension`, resolver el id de la extensión en runtime,
esperas de eventos entre pestañas— dentro de una fase que va de redes.

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

---

## Recordatorio para quien monte esto

Un test que necesita un `await` intermedio para pasar probablemente no está
probando el caso real: si el navegador no pone esa espera, quítala y mira si
sigue verde. Los tests concurrentes lanzan las llamadas sin `await` entre ellas
y esperan al final.
