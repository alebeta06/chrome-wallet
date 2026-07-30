import { beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCode, ProviderErrors } from "@/types/messages";
import { ProviderError, invalidParams, toSerializedError } from "@/lib/errors";

describe("toSerializedError", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("passes a ProviderError through unchanged, whoever is asking", () => {
    const error = new ProviderError(ProviderErrors.userRejected());

    expect(toSerializedError(error, true)).toEqual(error.serialized);
    expect(toSerializedError(error, false)).toEqual(error.serialized);
  });

  /**
   * 🇪🇸 NOTA: la asimetría es deliberada. Hacia una dApp, un error interno se
   * redacta: su mensaje puede describir estructura interna o estado. Hacia la UI
   * propia se deja pasar entero, porque redactarlo solo consigue que el fallo se
   * vea en una consola y la causa haya que buscarla en otra.
   */
  it("redacts an unexpected error when a web page is asking", () => {
    const serialized = toSerializedError(new Error("connection to 10.0.0.7 refused"), true);

    expect(serialized.code).toBe(ErrorCode.INTERNAL);
    expect(serialized.message).not.toContain("10.0.0.7");
    expect(serialized.data).toBeUndefined();
  });

  it("keeps the detail when the extension UI is asking", () => {
    const serialized = toSerializedError(new Error("connection to 10.0.0.7 refused"), false);

    expect(serialized.code).toBe(ErrorCode.INTERNAL);
    expect(serialized.message).toBe("connection to 10.0.0.7 refused");
    expect(serialized.data).toMatchObject({ name: "Error", message: "connection to 10.0.0.7 refused" });
  });

  /**
   * chrome.runtime serialises messages as JSON, so `data` has to survive
   * JSON.stringify. An Error object put there raw would arrive as `{}`.
   */
  it("puts a JSON-survivable copy in data, not the Error itself", () => {
    const serialized = toSerializedError(new Error("boom"), false);
    const roundTripped = JSON.parse(JSON.stringify(serialized)) as { data?: { message?: string } };

    expect(roundTripped.data?.message).toBe("boom");
  });

  it("handles a thrown non-Error", () => {
    expect(toSerializedError("just a string", false).message).toBe("just a string");
    expect(toSerializedError("just a string", true).message).not.toContain("just a string");
  });

  it("logs to the service worker console in both directions", () => {
    toSerializedError(new Error("boom"), true);
    toSerializedError(new Error("boom"), false);

    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it("does not log a ProviderError — it is expected control flow", () => {
    toSerializedError(invalidParams("bad input"), false);

    expect(console.error).not.toHaveBeenCalled();
  });
});
