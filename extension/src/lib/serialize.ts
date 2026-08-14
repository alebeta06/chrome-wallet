/**
 * @file lib/serialize.ts
 * @description One chain of promises, so that a read-modify-write cannot be
 * interleaved with another one against the same data.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: `chrome.storage.local` no tiene transacciones, y los handlers de
 * `chrome.runtime.onMessage` se despachan CONCURRENTES. Cualquier clave que
 * guarde un Record o un array entero se actualiza leyendo, modificando y
 * escribiendo, y eso es una carrera:
 *
 *     petición A: lee {}          petición B: lee {}
 *     petición A: escribe {a}     petición B: escribe {b}   ← se come la A
 *
 * El síntoma NO es un error. No hay excepción, ni log, ni nada en consola: hay
 * un dato que desapareció. Por eso el proyecto no confía en detectarlo cuando
 * ocurra, sino en que no pueda ocurrir.
 *
 * ---------------------------------------------------------------------------
 * ONE CHAIN PER OWNER, NEVER ONE CHAIN FOR EVERYTHING
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: esto es una FÁBRICA, no una cadena compartida, y la diferencia es el
 * motivo de que exista el archivo. Cada módulo que posee una clave crea la suya
 * dentro de su propio closure —`cc:pendingRequests`, `cc:networks`, la cola del
 * nonce— y no se ven entre sí. Una sola cadena global pondría cada escritura de
 * log a esperar detrás de una aprobación con la que no comparte ni un dato.
 *
 * Y NUNCA a nivel de módulo: dos instancias en un test tienen que poder ignorarse
 * la una a la otra, y el service worker no puede arrastrar nada entre
 * suspensiones.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO. READ BEFORE TRUSTING IT
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: serializar cierra el read-modify-write sobre UN dato compartido. NO
 * ordena dos operaciones independientes.
 *
 * Lo que SÍ cierra — dos escrituras que leen y modifican lo mismo:
 *
 *     sin cadena:  A lee {A,B} → decide → escribe
 *                  B lee {A,B} → decide → escribe   ← pisa a A
 *     con cadena:  A lee, decide, escribe → B lee lo que dejó A   ✓
 *
 * Lo que NO cierra — un borrado y un alta que no comparten lectura: la escritura
 * del alta va después y punto. La cadena no cambia quién llega primero, solo
 * impide que se pisen.
 *
 * Antes de escribir "serializado, luego seguro", pregunta si las dos operaciones
 * tocan el mismo dato. Si no lo tocan, la cadena no tiene nada que decir sobre
 * ellas.
 *
 * ---------------------------------------------------------------------------
 * IT DOES NOT SURVIVE THE WORKER, AND THAT IS CORRECT
 * ---------------------------------------------------------------------------
 * 🇪🇸 NOTA: Chrome suspende el service worker a los ~30 s y se lleva la cadena.
 * No es una limitación que haya que compensar: si el worker murió, no hay
 * escrituras EN VUELO contra las que serializar. La cadena solo tiene que
 * ordenar lo que está pasando ahora mismo, y "ahora mismo" muere con el worker.
 */

/**
 * Runs tasks one at a time, in the order they were handed over.
 *
 * The returned promise settles with whatever the task settled with, so a caller
 * still sees its own failure.
 */
export type Serializer = <T>(task: () => Promise<T>) => Promise<T>;

export function createSerializer(): Serializer {
  let chain: Promise<unknown> = Promise.resolve();

  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task);

    /**
     * ------------------------------------------------------------------------
     * ESTA LÍNEA ES LA QUE SOSTIENE "UN FALLO NO ATASCA LA CADENA"
     * ------------------------------------------------------------------------
     * 🇪🇸 NOTA: la cadena guarda la versión NEUTRALIZADA, así que `chain` NUNCA
     * está rechazada y la tarea siguiente siempre arranca. El llamador se lleva
     * `next` tal cual, con su rechazo intacto: el error llega a quien lo pidió.
     *
     * Sin esto, una escritura que falla dejaría `chain` rechazada para siempre y
     * ninguna posterior volvería a ejecutarse — la wallet dejaría de guardar en
     * silencio. Lo fija el test "keeps going after a task fails", y ese test se
     * pone rojo si se quita esta línea. Compruébalo antes de tocarla.
     *
     * Aquí hubo además un `chain.then(task, task)`: pasar la tarea también por
     * la rama de rechazo conseguía lo mismo por otro camino. Se quitó porque los
     * dos mecanismos juntos hacían a los dos INSABOTEABLES — con `.catch()`
     * puesto, `chain` no rechaza nunca y la segunda rama era inalcanzable; con
     * la rama doble puesta, quitar el `.catch()` no rompía nada. Medido: la
     * suite entera (703) seguía verde quitando cualquiera de los dos por
     * separado. Un trozo que ningún test puede falsar no está protegido, solo
     * parece estarlo.
     *
     * Se conservó `.catch()` y no la otra porque hace lo mismo MÁS una cosa: un
     * llamador que ignore la promesa devuelta —`void serialize(…)`— no deja un
     * rechazo sin recoger. Medido en Node: 0 `unhandledRejection` con `.catch()`,
     * 1 con la rama doble. Hoy no se alcanza —los nueve puntos de uso hacen
     * `return serialize(…)`— así que es un seguro, no un arreglo.
     */
    chain = next.catch(() => undefined);

    return next;
  };
}
