import { describe, expect, it, vi } from "vitest";

import {
  NOTIFICATION_ICON,
  NOTIFICATION_TEXT,
  createNotifier,
  notificationIdFor,
  requestIdFromNotification,
  type NotificationsPort,
} from "@/lib/notifications";

const REQUEST_ID = "6f1d1f9c-0000-4000-8000-000000000000";

function fakePort(options: { failCreate?: boolean; failClear?: boolean } = {}) {
  const created: Array<{ id: string; title: string; message: string; iconUrl: string }> = [];
  const cleared: string[] = [];

  const port: NotificationsPort = {
    create: vi.fn(async (id, o) => {
      if (options.failCreate === true) throw new Error("notifications are off");
      created.push({ id, ...o });
    }),
    clear: vi.fn(async (id) => {
      if (options.failClear === true) throw new Error("nothing to clear");
      cleared.push(id);
    }),
  };

  return { port, created, cleared };
}

describe("notificationIdFor / requestIdFromNotification", () => {
  /**
   * 🇪🇸 NOTA: el ida y vuelta es lo que hace posible cerrar la notificación. Si
   * crear y cerrar compusieran el id por separado, un cambio de prefijo en uno
   * de los dos dejaría avisos que no se cierran nunca — y sin ningún error que
   * lo delatara.
   */
  it("round-trips a request id", () => {
    expect(requestIdFromNotification(notificationIdFor(REQUEST_ID))).toBe(REQUEST_ID);
  });

  it("namespaces the id so it cannot collide with another feature's", () => {
    expect(notificationIdFor(REQUEST_ID)).not.toBe(REQUEST_ID);
    expect(notificationIdFor(REQUEST_ID)).toContain(REQUEST_ID);
  });

  it("refuses a notification that is not ours", () => {
    expect(requestIdFromNotification("some-other-extension:42")).toBeNull();
    expect(requestIdFromNotification(REQUEST_ID)).toBeNull();
    expect(requestIdFromNotification("")).toBeNull();
  });
});

describe("createNotifier", () => {
  it("announces a request with its kind's text and the PNG icon", async () => {
    const { port, created } = fakePort();

    await createNotifier(port).announce(REQUEST_ID, "signature");

    expect(created).toHaveLength(1);
    expect(created[0]?.id).toBe(notificationIdFor(REQUEST_ID));
    expect(created[0]?.title).toBe(NOTIFICATION_TEXT.signature.title);
    // 🇪🇸 NOTA: PNG. chrome.notifications falla EN SILENCIO con un SVG.
    expect(created[0]?.iconUrl).toBe(NOTIFICATION_ICON);
    expect(NOTIFICATION_ICON.endsWith(".png")).toBe(true);
  });

  it.each(["connect", "signature", "add-chain"] as const)("has text for %s", async (kind) => {
    const { port, created } = fakePort();

    await createNotifier(port).announce(REQUEST_ID, kind);

    expect(created[0]?.title.length).toBeGreaterThan(0);
    expect(created[0]?.message.length).toBeGreaterThan(0);
  });

  it("dismisses by the same id it announced with", async () => {
    const { port, created, cleared } = fakePort();
    const notifier = createNotifier(port);

    await notifier.announce(REQUEST_ID, "connect");
    await notifier.dismiss(REQUEST_ID);

    expect(cleared).toEqual([created[0]?.id]);
  });

  /**
   * ------------------------------------------------------------------------
   * COURTESY, NEVER MECHANISM
   * ------------------------------------------------------------------------
   * 🇪🇸 NOTA: con las notificaciones desactivadas a nivel de sistema operativo,
   * `create` no avisa de nada. Aquí se fuerza el caso ruidoso —que lance— porque
   * es el único que se puede provocar: lo que se está fijando es que NINGÚN
   * fallo suyo se propaga. La ventana de aprobación es el mecanismo, y tiene que
   * seguir abriéndose aunque el aviso no salga.
   */
  it("swallows a failure to announce", async () => {
    const complain = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { port } = fakePort({ failCreate: true });

    await expect(createNotifier(port).announce(REQUEST_ID, "connect")).resolves.toBeUndefined();
    expect(complain).toHaveBeenCalled();
  });

  it("swallows a failure to dismiss", async () => {
    const complain = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { port } = fakePort({ failClear: true });

    await expect(createNotifier(port).dismiss(REQUEST_ID)).resolves.toBeUndefined();
    expect(complain).toHaveBeenCalled();
  });
});
