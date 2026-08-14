import { describe, expect, it } from "vitest";

import { createSerializer } from "@/lib/serialize";

/** One microtask. Enough to let another task slip between a read and a write. */
function tick(): Promise<void> {
  return Promise.resolve();
}

/**
 * A read-modify-write against shared state, written the way storage forces it:
 * read, do something asynchronous, write back what you read plus your bit.
 *
 * 🇪🇸 NOTA: el `await` de en medio no es artificio del test — es exactamente lo
 * que hay en la vida real entre `storage.get` y `storage.set`. Sin él no hay
 * carrera que probar, porque el turno no se cede nunca.
 */
function appendSlowly(box: { items: string[] }, item: string): () => Promise<void> {
  return async () => {
    const seen = box.items;
    await tick();
    box.items = [...seen, item];
  };
}

describe("createSerializer", () => {
  /**
   * ------------------------------------------------------------------------
   * THE TEST THE WHOLE MODULE EXISTS FOR
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: las llamadas salen SIN `await` entre ellas y se espera al final.
   * Un `await` intermedio serializaría el test a mano y comprobaría un escenario
   * que el navegador no produce — que es justo cómo la carrera de la Fase 6
   * sobrevivió a un test en verde.
   */
  it("does not lose a write when several land at once", async () => {
    const serialize = createSerializer();
    const box = { items: [] as string[] };

    await Promise.all([
      serialize(appendSlowly(box, "a")),
      serialize(appendSlowly(box, "b")),
      serialize(appendSlowly(box, "c")),
    ]);

    expect(box.items).toEqual(["a", "b", "c"]);
  });

  it("runs tasks in the order they were handed over", async () => {
    const serialize = createSerializer();
    const finished: number[] = [];

    // Descending delays: without the chain, the shortest would finish first.
    await Promise.all([
      serialize(async () => {
        await tick();
        await tick();
        await tick();
        finished.push(1);
      }),
      serialize(async () => {
        await tick();
        await tick();
        finished.push(2);
      }),
      serialize(async () => {
        finished.push(3);
      }),
    ]);

    expect(finished).toEqual([1, 2, 3]);
  });

  it("never starts a task before the previous one has finished", async () => {
    const serialize = createSerializer();
    let running = 0;
    let overlapped = false;

    await Promise.all(
      Array.from({ length: 5 }, () =>
        serialize(async () => {
          running += 1;
          if (running > 1) overlapped = true;
          await tick();
          running -= 1;
        }),
      ),
    );

    expect(overlapped).toBe(false);
  });

  /**
   * 🇪🇸 NOTA: si `task` fuera solo a la rama de éxito del `then`, un fallo
   * dejaría la cadena rechazada para siempre y NADA volvería a escribirse. El
   * síntoma sería una wallet que deja de guardar en silencio.
   */
  it("keeps going after a task fails", async () => {
    const serialize = createSerializer();
    const box = { items: [] as string[] };

    const failed = serialize(async () => {
      await tick();
      throw new Error("the node was unreachable");
    });
    const after = serialize(appendSlowly(box, "written anyway"));

    await expect(failed).rejects.toThrow("the node was unreachable");
    await after;

    expect(box.items).toEqual(["written anyway"]);
  });

  it("hands the failure to whoever asked for it", async () => {
    const serialize = createSerializer();

    await expect(serialize(() => Promise.reject(new Error("mine")))).rejects.toThrow("mine");
  });

  it("resolves with whatever the task resolved with", async () => {
    const serialize = createSerializer();

    await expect(serialize(async () => "a value")).resolves.toBe("a value");
  });

  /**
   * 🇪🇸 NOTA: ésta es la razón de que sea una fábrica y no una cadena de módulo.
   * Dos dueños distintos —`cc:networks` y la cola del nonce— no comparten dato,
   * así que no tienen por qué esperarse. Una cadena global los acoplaría sin que
   * nada lo delatara salvo la lentitud.
   */
  it("gives each owner a chain of its own", async () => {
    const first = createSerializer();
    const second = createSerializer();
    const order: string[] = [];

    let releaseFirst = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const slow = first(async () => {
      await blocked;
      order.push("first");
    });
    const fast = second(async () => {
      order.push("second");
    });

    await fast;
    expect(order).toEqual(["second"]);

    releaseFirst();
    await slow;
    expect(order).toEqual(["second", "first"]);
  });
});
