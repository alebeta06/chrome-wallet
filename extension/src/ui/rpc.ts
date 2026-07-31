/**
 * @file ui/rpc.ts
 * @description The UI's only way to talk to the background.
 *
 * 🇪🇸 NOTA: este archivo es la razón de que la UI no necesite ethers. El popup
 * no deriva, no consulta la cadena y no sabe qué es una clave privada: pide
 * cosas por nombre y recibe datos ya formateados por el contrato. Todo lo que
 * necesita ethers vive al otro lado del puente.
 */

import {
  ErrorCode,
  type InternalRpcMethod,
  type RpcParams,
  type RpcRequestMessage,
  type RpcResponseMessage,
  type RpcResult,
  type SerializedProviderError,
} from "@/types/messages";

/** A wire error rebuilt into something the UI can `catch` and branch on. */
export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(serialized: SerializedProviderError) {
    super(serialized.message);
    this.name = "RpcError";
    this.code = serialized.code;
    this.data = serialized.data;
  }

  /** The node is unreachable — the wallet itself is fine. See lib/chain.ts. */
  get isChainUnreachable(): boolean {
    return this.code === ErrorCode.CHAIN_DISCONNECTED;
  }
}

export function toRpcError(cause: unknown): RpcError {
  if (cause instanceof RpcError) return cause;
  return new RpcError({
    code: ErrorCode.INTERNAL,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

/**
 * Calls an internal method on the background, fully typed against the contract.
 *
 * The rest parameter is the method's own params tuple, so both the arguments and
 * the return type come from RpcMap:
 *
 *   callBackground("wallet_getState")                        -> WalletSnapshot
 *   callBackground("wallet_getBalances", { addresses })       -> Record<Address, Hex>
 *   callBackground("wallet_importMnemonic", { phrase, ... })  -> Address[]
 */
export async function callBackground<M extends InternalRpcMethod>(
  method: M,
  ...params: RpcParams<M>
): Promise<RpcResult<M>> {
  const request: RpcRequestMessage = {
    type: "CODECRYPTO_RPC",
    id: crypto.randomUUID(),
    method,
    params: params as unknown[],
  };

  let response: RpcResponseMessage | undefined;

  try {
    response = await chrome.runtime.sendMessage<RpcRequestMessage, RpcResponseMessage | undefined>(
      request,
    );
  } catch {
    // sendMessage REJECTS when there is no receiver at all — typically the
    // extension was reloaded while the popup stayed open.
    throw new RpcError({
      code: ErrorCode.DISCONNECTED,
      message: "The wallet background is not reachable. Reload the extension and try again.",
    });
  }

  // ...and RESOLVES with undefined when the channel closed before an answer.
  // Both have to be handled: neither surfaces as an ok:false response.
  if (response === undefined) {
    throw new RpcError({
      code: ErrorCode.INTERNAL,
      message: "The wallet background closed the channel without answering.",
    });
  }

  if (!response.ok) throw new RpcError(response.error);

  return response.result as RpcResult<M>;
}
