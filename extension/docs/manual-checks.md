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
