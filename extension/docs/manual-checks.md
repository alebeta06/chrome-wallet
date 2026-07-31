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
