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
