# Desplegar la dApp en Vercel

Solo se despliega `dapp/`. La extensión no se despliega en ninguna parte: se
carga en Chrome como *unpacked* desde `extension/dist/` (ver el
[README](../README.md)).

## Ajustes del proyecto

En [vercel.com](https://vercel.com) → **Add New… → Project** → importa el repo
`alebeta06/chrome-wallet`, y en la pantalla de configuración:

| Ajuste | Valor |
|---|---|
| **Root Directory** | `dapp` |
| **Framework Preset** | **Next.js** |
| **Build Command** | `pnpm build` *(por defecto)* |
| **Install Command** | `pnpm install` *(por defecto)* |
| **Output Directory** | *(vacío — lo gestiona el preset)* |
| **Node.js Version** | 20.x o superior |
| **Environment Variables** | ninguna |

Con eso, **Deploy**. No hace falta tocar nada más.

### El gotcha del Framework Preset

Tiene que ser **Next.js**, no "Other". Con "Other" Vercel no reconoce el App
Router: no genera las funciones del servidor, sirve la carpeta como estático y el
resultado es un 404 o una página en blanco, sin ningún error en el log del build
—que es lo que lo hace difícil de diagnosticar—. Si Vercel lo autodetecta bien
(lo normal, al haber `next` en las dependencias), déjalo como está.

### Por qué Root Directory `dapp` y no la raíz

`extension/` y `dapp/` son dos proyectos independientes, con un `package.json` y
un lockfile cada uno, y **no hay workspace de pnpm en la raíz**. Apuntando el
Root Directory a `dapp`, Vercel encuentra ahí el `package.json` y el
`pnpm-lock.yaml` e instala solo lo de la dApp: ni ethers, ni React del popup, ni
las dependencias de build de la extensión.

Si algún día se convierte el repo en un workspace, esto deja de ser cierto y hará
falta un Install Command a medida (`pnpm install --filter=dapp`).

## Nada de variables de entorno

La dApp no tiene backend, no llama a ninguna API y no lee ninguna clave. Todo lo
que hace ocurre en el navegador contra `window.codecrypto`. Si en una fase futura
aparece una variable, tiene que ir además documentada aquí.

## Sobre `sharp` y `pnpm install`

`dapp/pnpm-workspace.yaml` autoriza el script postinstall de `sharp` (dependencia
opcional de Next para optimizar imágenes). **No lo borres:** pnpm 11 bloquea los
postinstall por defecto y sin esa autorización `pnpm install` termina con código
1 — el build de Vercel falla antes de compilar nada.

## Después del deploy

La URL pública (`https://<proyecto>.vercel.app`) sirve para dos cosas:

1. **La demo.** En vez de abrir un archivo local, se entra a una web y se conecta
   la wallet. La página funciona contra tu Anvil local sin túnel ni
   configuración — el porqué está en el [README de la dApp](../dapp/README.md).
2. **Probar el modelo de cuenta por origen en la Fase 5.** La dApp en Vercel y la
   misma dApp en `localhost:3000` son **dos orígenes distintos**, así que cada
   uno puede tener su propia cuenta conectada. Con un solo origen eso no se puede
   demostrar, y es la mitad interesante del modelo.

Anota la URL en las comprobaciones manuales
([`extension/docs/manual-checks.md`](../extension/docs/manual-checks.md)) cuando
la tengas.

## Preview deployments

Cada push a una rama que no sea `main` genera una URL de preview con su propio
origen. Para la Fase 5 eso es un tercer origen gratis con el que probar que los
permisos no se filtran entre sitios.
