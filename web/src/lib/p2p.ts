// P2P-режим. Зеркалит интерфейс MeetConnection, но вместо SFU/WS-сигналинга
// использует Trystero — mesh-WebRTC + Nostr-relays для signaling.
//
// Topology: full mesh. Каждый клиент держит RTCPeerConnection ко ВСЕМ остальным.
// Подходит для маленьких комнат (≤6–8 человек) и хостов за CGNAT, у которых
// нет публичного IP/IPv6/UPnP для SFU.
//
// Отличия от SignalClient+MeetConnection:
// - нет своего WebSocket-сервера
// - нет screen-share API (на этапе MVP)
// - нет publish/subscribe-PC; одна RTCPeerConnection-на-пира под капотом Trystero
// - peerId — selfId Trystero (≠ clientId SFU-сервера)

import { joinRoom, type Room, type ActionSender } from 'trystero';

export interface P2PMeetEvents {
  onLocalStream(stream: MediaStream): void;
  onRemoteStream(peerId: string, stream: MediaStream, name: string): void;
  onPeerJoined(peerId: string, name: string): void;
  onPeerLeft(peerId: string): void;
  onConnectionState(peerId: string, state: RTCPeerConnectionState): void;
  onError(err: Error): void;
}

const APP_ID = 'zubrameet';

// "name" action — каждый peer при подключении отправляет своё display-name.
// Payload — просто строка. Trystero сериализует JsonValue в data-channel под капотом.
type NamePayload = string;

export class P2PMeetConnection {
  private readonly roomId: string;
  private readonly displayName: string;
  private readonly events: P2PMeetEvents;

  private room: Room | null = null;

  private sendName: ActionSender<NamePayload> | null = null;
  // peerId → display name (может прийти ПОСЛЕ onPeerStream, поэтому буферизуем).
  private readonly peerNames: Map<string, string> = new Map();
  // peerId → MediaStream — храним стримы, чтобы при позднем приходе name
  // можно было перевыдать onRemoteStream-имя через отдельный path? Сейчас
  // upstream сам ребиндит имя через onPeerJoined. Стримы храним для replaceLocalStream.
  private readonly peerStreams: Map<string, MediaStream> = new Map();
  // peerId → RTCPeerConnection — для отслеживания connectionstatechange.
  private readonly trackedPCs: Map<string, RTCPeerConnection> = new Map();

  private closed = false;
  // Чтобы start() нельзя было вызвать дважды.
  private started = false;

  constructor(roomId: string, displayName: string, events: P2PMeetEvents) {
    this.roomId = roomId;
    this.displayName = displayName;
    this.events = events;
  }

  get peerCount(): number {
    return this.peerNames.size;
  }

  async start(localStream: MediaStream): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      try {
        this.events.onLocalStream(localStream);
      } catch (err) {
        this.reportError(err, 'onLocalStream');
      }

      let room: Room;
      try {
        room = joinRoom({ appId: APP_ID }, this.roomId);
      } catch (err) {
        this.reportError(err, 'joinRoom');
        return;
      }
      this.room = room;

      // name-action — двусторонний обмен display-name через data-channel.
      const [sendName, getName] = room.makeAction<NamePayload>('name');
      this.sendName = sendName;

      getName((data, peerId) => {
        try {
          if (typeof data !== 'string') return;
          this.peerNames.set(peerId, data);
          this.events.onPeerJoined(peerId, data);
        } catch (err) {
          this.reportError(err, 'getName');
        }
      });

      // Публикуем локальный stream — Trystero сам сделает addTrack ко всем
      // активным peer-PC и будет повторять для будущих peer'ов.
      try {
        const pubPromises = room.addStream(localStream);
        // addStream может вернуть массив промисов (по одному на пира). Не ждём,
        // но логируем ошибки.
        for (const p of pubPromises) {
          p.catch((err: unknown) => {
            this.reportError(err, 'addStream');
          });
        }
      } catch (err) {
        this.reportError(err, 'addStream');
      }

      room.onPeerJoin((peerId) => {
        try {
          // Уведомляем сразу с placeholder-именем; настоящее придёт через
          // sendName ниже и перевыпустит onPeerJoined.
          if (!this.peerNames.has(peerId)) {
            this.events.onPeerJoined(peerId, 'Участник');
          }
          // Шлём своё имя новому пиру (только ему — targetPeers).
          if (this.sendName) {
            void this.sendName(this.displayName, peerId).catch((err: unknown) => {
              this.reportError(err, 'sendName(onPeerJoin)');
            });
          }
          // Подвешиваемся на connectionstatechange низлежащего PC.
          this.trackPeerPC(peerId);
        } catch (err) {
          this.reportError(err, 'onPeerJoin');
        }
      });

      room.onPeerLeave((peerId) => {
        try {
          this.peerNames.delete(peerId);
          this.peerStreams.delete(peerId);
          this.trackedPCs.delete(peerId);
          this.events.onPeerLeft(peerId);
        } catch (err) {
          this.reportError(err, 'onPeerLeave');
        }
      });

      room.onPeerStream((stream, peerId) => {
        try {
          this.peerStreams.set(peerId, stream);
          const name = this.peerNames.get(peerId) ?? 'Участник';
          this.events.onRemoteStream(peerId, stream, name);
        } catch (err) {
          this.reportError(err, 'onPeerStream');
        }
      });
    } catch (err) {
      this.reportError(err, 'start');
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    const room = this.room;
    this.room = null;
    this.sendName = null;
    this.peerNames.clear();
    this.peerStreams.clear();
    this.trackedPCs.clear();

    if (room) {
      try {
        // leave() — async, но мы не ждём; cleanup-best-effort.
        void room.leave().catch(() => {
          /* ignore */
        });
      } catch {
        /* ignore */
      }
    }
    // localStream принадлежит caller'у — не стопим.
  }

  // ─── private ──────────────────────────────────────────────────────────────

  /**
   * Вытаскивает RTCPeerConnection для peerId через room.getPeers() и
   * подвешивает onconnectionstatechange. Trystero может создать PC чуть позже
   * onPeerJoin — поэтому ретраим несколько раз.
   */
  private trackPeerPC(peerId: string, attempt = 0): void {
    if (this.closed || !this.room) return;
    const peers = this.room.getPeers();
    const pc = peers[peerId];
    if (!pc) {
      if (attempt < 10) {
        // 100ms × 10 = до 1с — обычно PC появляется почти сразу.
        window.setTimeout(() => {
          this.trackPeerPC(peerId, attempt + 1);
        }, 100);
      }
      return;
    }
    if (this.trackedPCs.has(peerId)) return;
    this.trackedPCs.set(peerId, pc);

    // Сразу emit'им текущее состояние.
    try {
      this.events.onConnectionState(peerId, pc.connectionState);
    } catch (err) {
      this.reportError(err, 'onConnectionState(initial)');
    }

    pc.addEventListener('connectionstatechange', () => {
      try {
        this.events.onConnectionState(peerId, pc.connectionState);
      } catch (err) {
        this.reportError(err, 'onConnectionState');
      }
    });
  }

  private reportError(err: unknown, ctx: string): void {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      this.events.onError(new Error(`p2p[${ctx}]: ${msg}`));
    } catch {
      /* swallow */
    }
  }
}
