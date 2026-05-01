import type { Envelope, MsgType } from '../types';

type Handler<T = unknown> = (env: Envelope<T>) => void;
type CloseHandler = (ev: CloseEvent) => void;

export class SignalClient {
  private readonly url: string;
  private ws: WebSocket | null = null;
  private readonly handlers: Map<MsgType, Set<Handler>> = new Map();
  private readonly closeHandlers: Set<CloseHandler> = new Set();

  constructor(url: string) {
    this.url = url;
  }

  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        settled = true;
        resolve();
      };

      ws.onerror = (ev: Event) => {
        if (!settled) {
          settled = true;
          reject(new Error('signal: websocket error'));
        }
        // After open, errors are surfaced via close.
        void ev;
      };

      ws.onmessage = (ev: MessageEvent) => {
        this.dispatchMessage(ev);
      };

      ws.onclose = (ev: CloseEvent) => {
        if (!settled) {
          settled = true;
          reject(new Error(`signal: closed before open (code=${ev.code})`));
        }
        for (const cb of this.closeHandlers) {
          try {
            cb(ev);
          } catch (err) {
            console.error('signal: close handler threw', err);
          }
        }
      };
    });
  }

  send<T>(type: MsgType, data?: T): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('signal: not connected');
    }
    const envelope: Envelope<T> = data === undefined ? { type } : { type, data };
    ws.send(JSON.stringify(envelope));
  }

  on<T>(type: MsgType, handler: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const generic = handler as Handler;
    set.add(generic);
    return () => {
      const current = this.handlers.get(type);
      if (!current) return;
      current.delete(generic);
      if (current.size === 0) {
        this.handlers.delete(type);
      }
    };
  }

  onCloseEmitter = (cb: CloseHandler): (() => void) => {
    this.closeHandlers.add(cb);
    return () => {
      this.closeHandlers.delete(cb);
    };
  };

  close(code?: number, reason?: string): void {
    const ws = this.ws;
    if (!ws) return;
    try {
      if (code === undefined) {
        ws.close();
      } else if (reason === undefined) {
        ws.close(code);
      } else {
        ws.close(code, reason);
      }
    } catch (err) {
      console.error('signal: close threw', err);
    }
  }

  get readyState(): number {
    return this.ws ? this.ws.readyState : WebSocket.CLOSED;
  }

  private dispatchMessage(ev: MessageEvent): void {
    let parsed: Envelope;
    try {
      const raw = typeof ev.data === 'string' ? ev.data : '';
      if (!raw) {
        console.error('signal: non-string message data');
        return;
      }
      parsed = JSON.parse(raw) as Envelope;
    } catch (err) {
      console.error('signal: failed to parse message', err);
      return;
    }
    if (!parsed || typeof parsed.type !== 'string') {
      console.error('signal: invalid envelope', parsed);
      return;
    }
    const set = this.handlers.get(parsed.type);
    if (!set || set.size === 0) return;
    for (const h of set) {
      try {
        h(parsed);
      } catch (err) {
        console.error(`signal: handler for "${parsed.type}" threw`, err);
      }
    }
  }
}

export function buildWsUrl(roomId: string, name: string): string {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = loc.host;
  const room = encodeURIComponent(roomId);
  const displayName = encodeURIComponent(name);
  return `${proto}//${host}/ws?room=${room}&name=${displayName}`;
}
