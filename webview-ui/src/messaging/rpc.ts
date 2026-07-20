import type {
  ExtensionToWebview,
  RpcMethod,
  WebviewToExtension,
} from '@shared/webview.types';

interface VsCodeApi {
  postMessage(message: WebviewToExtension): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/**
 * `acquireVsCodeApi` may only be called once per page, so the handle is captured at module
 * scope and shared.
 */
export const vscodeApi: VsCodeApi = acquireVsCodeApi();

export function post(message: WebviewToExtension): void {
  vscodeApi.postMessage(message);
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

/** Generous: a model listing can involve a slow upstream API. */
const RPC_TIMEOUT_MS = 30_000;

/**
 * Sends a correlated request and waits for the matching reply.
 *
 * Ids come from `crypto.randomUUID()`, never a counter — a panel reload resets a counter to
 * zero while the host may still be answering an earlier request, and the reply would then
 * resolve the wrong promise.
 */
export function rpc<T>(method: RpcMethod, params: unknown): Promise<T> {
  const requestId = crypto.randomUUID();

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`${method} timed out.`));
    }, RPC_TIMEOUT_MS);

    pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timer });
    post({ type: 'rpcRequest', requestId, method, params });
  });
}

/**
 * Settles a pending request.
 *
 * @returns whether the message was a reply this module owns.
 */
export function resolveRpc(message: ExtensionToWebview): boolean {
  if (message.type !== 'rpcResponse') return false;

  const entry = pending.get(message.requestId);
  // An unknown id is the expected path after a client-side timeout, not an error — warning
  // here would produce console noise every time a user's network is slow.
  if (!entry) return true;

  pending.delete(message.requestId);
  clearTimeout(entry.timer);

  if (message.ok) entry.resolve(message.payload);
  else entry.reject(new Error(message.error ?? 'Request failed.'));

  return true;
}

/**
 * Fails every in-flight request. Called on mount: a reload strands the previous page's
 * resolvers, and their promises would otherwise never settle.
 */
export function rejectAllPending(reason: string): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
  pending.clear();
}
