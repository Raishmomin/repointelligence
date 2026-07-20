// ═══════════════════════════════════════════════════════════════
// EventBus — Typed publish/subscribe for decoupled communication
// ═══════════════════════════════════════════════════════════════

import { ScanResult, ScannedFile, FrameworkInfo } from './types';

/**
 * Event map defining all events and their payload types.
 * Adding a new event? Add its type here — TypeScript will enforce
 * correct payloads at every emit/on call site.
 */
export interface EventMap {
  // Scan lifecycle
  'scan:started': { rootPath: string };
  'scan:progress': { phase: string; current: number; total: number; message: string };
  'scan:completed': ScanResult;
  'scan:error': { error: Error; rootPath: string };

  // File changes (from FileSystemWatcher)
  'file:created': { path: string };
  'file:changed': { path: string };
  'file:deleted': { path: string };

  // Indexing
  'index:started': { fileCount: number };
  'index:progress': { current: number; total: number };
  'index:completed': { duration: number; filesIndexed: number };

  // Framework detection
  'framework:detected': FrameworkInfo;

  // Database
  'db:initialized': { path: string };
  'db:migrated': { version: number };

  // Ollama
  'ollama:connected': { url: string; models: string[] };
  'ollama:disconnected': { url: string; error: string };

  // Chat
  'chat:messageReceived': { sessionId: string; role: string; content: string };
  'chat:streamChunk': { sessionId: string; chunk: string };
  'chat:streamEnd': { sessionId: string };

  // Agent run lifecycle. The webview subscribes to these to render a live step timeline.
  // Delta events fire per token, so consumers must batch before posting to a webview —
  // one postMessage per token will pin the extension host.
  'agent:runStarted': { runId: string; prompt: string; mode: string };
  'agent:turnStarted': { runId: string; turn: number; maxTurns: number };
  'agent:textDelta': { runId: string; text: string };
  'agent:thinkingDelta': { runId: string; text: string };
  'agent:toolCallStarted': { runId: string; toolCallId: string; name: string };
  'agent:toolCallInput': { runId: string; toolCallId: string; partialJson: string };
  'agent:toolCallResult': {
    runId: string;
    toolCallId: string;
    name: string;
    ok: boolean;
    preview: string;
  };
  'agent:approvalRequired': {
    runId: string;
    changeSetIds: string[];
    commandIds: string[];
  };
  'agent:runFinished': {
    runId: string;
    status: string;
    turns: number;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
  };
  'agent:error': { runId: string; message: string };
}

type EventHandler<T> = (payload: T) => void;

/**
 * Type-safe event bus for decoupled communication between modules.
 * Avoids tight coupling between the scanner, database, UI, and AI layers.
 *
 * Usage:
 *   eventBus.on('scan:completed', (result) => { ... });
 *   eventBus.emit('scan:completed', scanResult);
 */
export class EventBus {
  private static instance: EventBus;
  private handlers = new Map<string, Set<EventHandler<any>>>();

  static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  on<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  once<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): () => void {
    const wrappedHandler: EventHandler<EventMap[K]> = (payload) => {
      this.off(event, wrappedHandler);
      handler(payload);
    };
    return this.on(event, wrappedHandler);
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(payload);
        } catch (err) {
          console.error(`[EventBus] Error in handler for "${String(event)}":`, err);
        }
      }
    }
  }

  off<K extends keyof EventMap>(event: K, handler: EventHandler<EventMap[K]>): void {
    this.handlers.get(event)?.delete(handler);
  }

  removeAllListeners(event?: keyof EventMap): void {
    if (event) {
      this.handlers.delete(event);
    } else {
      this.handlers.clear();
    }
  }
}
