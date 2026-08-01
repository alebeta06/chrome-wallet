# CodeCrypto Wallet

Wallet de Ethereum como extensión de Chrome (MV3), escrita desde cero para el
Máster CodeCrypto. Sin smart contracts en el alcance.

El repo tiene **dos proyectos independientes**, cada uno con su `package.json` y
su lockfile:

| Carpeta | Qué es |
|---|---|
| `extension/` | La wallet: service worker, popup y provider inyectado |
| `dapp/` | Una dApp Next.js que consume el provider desde fuera, como lo haría cualquier web |

No comparten código a propósito. La dApp conoce EIP-1193 y EIP-6963 —que son
estándares públicos— y nada más, igual que si estuviera escrita contra MetaMask.

## Requisitos

- **Node** ≥ 20.19 (probado en 24.x)
- **pnpm** 11
- **[Foundry](https://book.getfoundry.sh/getting-started/installation)** para
  `anvil`, el nodo local

## Instalar la extensión

```bash
cd extension
pnpm install
pnpm build
```

Luego, en Chrome:

1. Abre `chrome://extensions`
2. Activa **Developer mode** (arriba a la derecha)
3. **Load unpacked** → selecciona `extension/dist/`

> Después de cada `pnpm build` hay que pulsar recargar (↻) en la tarjeta de la
> extensión. El service worker no se actualiza solo.

Para tener saldos con los que jugar, levanta el nodo local en otra terminal:

```bash
anvil    # http://localhost:8545 · chainId 31337 (0x7a69)
```

La frase de desarrollo de Anvil —pública y solo para pruebas— es:

```
test test test test test test test test test test test junk
```

## Levantar la dApp

```bash
cd dapp
pnpm install
pnpm dev        # http://localhost:3000
```

Con la extensión cargada, la dApp la descubre por EIP-6963 y aparece en la lista
junto a cualquier otra wallet que tengas instalada.

## Comprobar que funciona

```bash
cd extension && pnpm test:run    # tests de la wallet
cd dapp      && pnpm test:run    # tests de la dApp
```

Lo que los tests no pueden cubrir —que la extensión cargada de verdad responda
por `chrome.runtime`— está en
[`extension/docs/manual-checks.md`](extension/docs/manual-checks.md).

## Desplegar la dApp

Ver [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Documentación

- [`CLAUDE.md`](CLAUDE.md) — arquitectura, reglas del proyecto y stack fijado
- [`extension/docs/manual-checks.md`](extension/docs/manual-checks.md) — comprobaciones manuales por fase
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — despliegue de la dApp a Vercel
- [`dapp/README.md`](dapp/README.md) — cómo habla la dApp con la wallet
