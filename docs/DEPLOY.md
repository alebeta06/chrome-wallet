# Desplegar la dApp en Vercel

**Producción: https://chrome-wallet.vercel.app**

Solo se despliega `dapp/`. La extensión no se despliega en ninguna parte: se
carga en Chrome como *unpacked* desde `extension/dist/` (ver el
[README](../README.md)).

## Ajustes del proyecto

En [vercel.com](https://vercel.com) → **Add New… → Project** → importa el repo
`alebeta06/chrome-wallet`, y en la pantalla de configuración:

| Ajuste | Valor |
|---|---|
| **Root Directory** | `dapp` |
| **Framework Preset** | **Next.js** ← ponlo a mano, ver abajo |
| **Build Command** | `pnpm build` *(por defecto)* |
| **Install Command** | `pnpm install` *(por defecto)* |
| **Output Directory** | *(vacío — lo gestiona el preset)* |
| **Node.js Version** | 20.x o superior |
| **Environment Variables** | ninguna |

### El Framework Preset NO se autodetecta

Comprobado en el despliegue real: **el Framework Preset llegó vacío.** Vercel no
lo dedujo, pese a que el Root Directory apunta a `dapp/` y ahí hay un
`package.json` con `next` en las dependencias y una carpeta `src/app/`.

Ponlo a **Next.js** a mano antes del primer Deploy. Si ya has desplegado y ha
fallado, ve directo al [troubleshooting](#el-error-que-produce-un-preset-vacío).

### Por qué Root Directory `dapp` y no la raíz

`extension/` y `dapp/` son dos proyectos independientes, con un `package.json` y
un lockfile cada uno, y **no hay workspace de pnpm en la raíz**. Apuntando el
Root Directory a `dapp`, Vercel encuentra ahí el `package.json` y el
`pnpm-lock.yaml` e instala solo lo de la dApp: ni ethers, ni React del popup, ni
las dependencias de build de la extensión.

Si algún día se convierte el repo en un workspace, esto deja de ser cierto y hará
falta un Install Command a medida (`pnpm install --filter=dapp`).

## Troubleshooting

### El error que produce un preset vacío

```
Error: No Output Directory named "public" found after the Build completed.
```

**Este error no menciona el framework por ninguna parte**, y ahí está toda la
dificultad: habla de `public/`, que es una carpeta que este proyecto no tiene ni
tiene por qué tener, así que lo primero que uno hace es ir a buscar por qué falta
—cuando lo que falta es el preset.

Lo que despista todavía más: **el build termina bien.** En los logs se ve
`Compiled successfully`, el typecheck en verde y las tres rutas generadas:

```
Route (app)                                 Size  First Load JS
┌ ○ /                                    4.53 kB         107 kB
├ ○ /_not-found                            989 B         103 kB
└ ○ /frame                               1.06 kB         103 kB
```

O sea que Next hizo su trabajo entero. Lo que falla es el paso siguiente, la
**recogida del resultado**: sin preset, Vercel no sabe que esto es Next.js y cae
en su comportamiento por defecto de sitio estático, que consiste en buscar una
carpeta `public/`. El `.next/` que acaba de generarse lo ignora porque nadie le
ha dicho que mire ahí.

**Arreglo, sin volver a desplegar desde cero:**

1. **Settings → Build and Deployment → Framework Preset → Next.js** → Save
2. **Deployments** → el despliegue fallido → menú `⋯` → **Redeploy**

No hace falta ni tocar el código ni hacer un push: el preset es configuración del
proyecto, no del commit, y el redeploy reutiliza el mismo.

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

La URL pública —**https://chrome-wallet.vercel.app**— sirve para dos cosas:

1. **La demo.** En vez de abrir un archivo local, se entra a una web y se conecta
   la wallet. La página funciona contra tu Anvil local sin túnel ni
   configuración — el porqué está en el [README de la dApp](../dapp/README.md).
2. **Probar el modelo de cuenta por origen en la Fase 5.** La dApp en Vercel y la
   misma dApp en `localhost:3000` son **dos orígenes distintos**, así que cada
   uno puede tener su propia cuenta conectada. Con un solo origen eso no se puede
   demostrar, y es la mitad interesante del modelo.

Está anotada en las comprobaciones manuales
([`extension/docs/manual-checks.md`](../extension/docs/manual-checks.md)), que
conviene pasar por los dos orígenes.

## Preview deployments

Cada push a una rama que no sea `main` genera una URL de preview con su propio
origen. Para la Fase 5 eso es un tercer origen gratis con el que probar que los
permisos no se filtran entre sitios.
