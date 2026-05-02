// P2P-режим. Зеркалит интерфейс MeetConnection, но вместо SFU/WS-сигналинга
// использует Trystero — mesh-WebRTC + Nostr-relays для signaling.
//
// Topology: full mesh. Каждый клиент держит RTCPeerConnection ко ВСЕМ остальным.
// Подходит для маленьких комнат (≤6–8 человек) и хостов за CGNAT, у которых
// нет публичного IP/IPv6/UPnP для SFU.
//
// Отличия от SignalClient+MeetConnection:
// - нет своего WebSocket-сервера
// - нет publish/subscribe-PC; одна RTCPeerConnection-на-пира под капотом Trystero
// - peerId — selfId Trystero (≠ clientId SFU-сервера)
//
// Screen-share: реализован через room.addStream(stream, null, 'screen') —
// третий аргумент в Trystero — metadata, передаётся приёмнику в onPeerStream
// третьим аргументом. По нему различаем camera vs screen.

import { joinRoom, type Room, type ActionSender } from 'trystero';
import { PUBLIC_ICE_SERVERS } from './ice';

export type RemoteStreamKind = 'camera' | 'screen';

// Состояние мьютов на стороне peer'а. true = on, false = off.
// Передаётся явным action'ом 'media' через data-channel (Trystero) — это
// единственно надёжный способ узнать, что peer выключил камеру/мик: сам факт
// `track.enabled = false` НЕ триггерит track.muted/onmute на удалённой стороне.
//
// Index-signature нужна чтобы тип удовлетворял Trystero DataPayload (JsonValue).
export interface P2PMediaState {
  cam: boolean;
  mic: boolean;
  [key: string]: boolean;
}

export interface P2PMeetEvents {
  onLocalStream(stream: MediaStream): void;
  // kind — 'camera' (default) | 'screen'. Опционален для backwards compat:
  // существующие потребители получают undefined и могут трактовать как camera.
  onRemoteStream(
    peerId: string,
    stream: MediaStream,
    name: string,
    kind?: RemoteStreamKind,
  ): void;
  onPeerJoined(peerId: string, name: string): void;
  onPeerLeft(peerId: string): void;
  onConnectionState(peerId: string, state: RTCPeerConnectionState): void;
  onError(err: Error): void;
  // Локальный screen-share API (mirror MeetConnection events).
  onScreenShareStarted?(stream: MediaStream): void;
  onScreenShareStopped?(): void;
  // Удалённый peer обновил cam/mic state. Используется для отрисовки
  // placeholder'а с аватаром (вместо последнего «застывшего» кадра).
  onPeerMediaState?(peerId: string, state: P2PMediaState): void;
}

const APP_ID = 'zubrameet';

// "name" action — каждый peer при подключении отправляет своё display-name.
// Payload — просто строка. Trystero сериализует JsonValue в data-channel под капотом.
type NamePayload = string;

// Метаданные стрима, которые Trystero пробрасывает в onPeerStream.
// Используем строку вместо объекта — короче и совместимо с Trystero JsonValue.
const STREAM_META_SCREEN = 'screen';

export class P2PMeetConnection {
  private readonly roomId: string;
  private readonly displayName: string;
  private readonly events: P2PMeetEvents;
  // Pre-shared password для Trystero E2EE. Если undefined/'' — без шифрования
  // (back-compat со старыми ссылками /p2p/<8charID> без hash).
  private readonly password: string | undefined;

  private room: Room | null = null;

  private sendName: ActionSender<NamePayload> | null = null;
  // 'media' action — broadcast cam/mic state. Запоминаем отправлятор чтобы
  // setMediaState() мог его дёрнуть.
  private sendMediaState: ActionSender<P2PMediaState> | null = null;
  // Текущее локальное cam/mic state. По умолчанию обе включены — это
  // отражает поведение acquireMedia + setMicOn(true)/setCamOn(true) в Meeting.tsx.
  private localMediaState: P2PMediaState = { cam: true, mic: true };
  // peerId → последнее известное cam/mic state. Кешируем чтобы повторные
  // отправки от того же peer'а не вызывали лишних onPeerMediaState (хотя
  // потребитель уже умеет diff'ить по prev — это просто дополнительный layer).
  private readonly peerMediaStates: Map<string, P2PMediaState> = new Map();
  // peerId → display name (может прийти ПОСЛЕ onPeerStream, поэтому буферизуем).
  private readonly peerNames: Map<string, string> = new Map();
  // peerId → MediaStream — храним стримы, чтобы при позднем приходе name
  // можно было перевыдать onRemoteStream-имя через отдельный path? Сейчас
  // upstream сам ребиндит имя через onPeerJoined. Стримы храним для replaceLocalStream.
  private readonly peerStreams: Map<string, MediaStream> = new Map();
  // peerId → RTCPeerConnection — для отслеживания connectionstatechange.
  private readonly trackedPCs: Map<string, RTCPeerConnection> = new Map();

  // Локальный camera+mic стрим (передан в start()). Храним чтобы пушить
  // вновь подключающимся peer'ам в onPeerJoin (Trystero v0.24 не реплеит
  // ранее добавленные стримы автоматически).
  private cameraStream: MediaStream | null = null;
  // Локальный screen-share стрим, если активен.
  private screenStream: MediaStream | null = null;

  private closed = false;
  // Чтобы start() нельзя было вызвать дважды.
  private started = false;

  constructor(
    roomId: string,
    displayName: string,
    events: P2PMeetEvents,
    password?: string,
  ) {
    this.roomId = roomId;
    this.displayName = displayName;
    this.events = events;
    // Пустую строку трактуем как отсутствие пароля.
    this.password = password && password.length > 0 ? password : undefined;
  }

  get peerCount(): number {
    return this.peerNames.size;
  }

  async start(localStream: MediaStream): Promise<void> {
    if (this.started) return;
    this.started = true;
    console.info('[zubrameet/p2p] start', { roomId: this.roomId, name: this.displayName });
    try {
      try {
        this.events.onLocalStream(localStream);
      } catch (err) {
        this.reportError(err, 'onLocalStream');
      }

      let room: Room;
      try {
        // rtcConfig: бесплатные публичные STUN+TURN из ice.ts. TURN критичен
        // для symmetric NAT (≈15–20% сетей), без него P2P-mesh не пробьётся.
        // password (если задан): Trystero шифрует ВЁС signaling через Nostr-relays
        // и data-channel сообщения. Peer без правильного password не сможет
        // расшифровать SDP/ICE → peer-connection не установится.
        const config: { appId: string; rtcConfig: { iceServers: typeof PUBLIC_ICE_SERVERS }; password?: string } = {
          appId: APP_ID,
          rtcConfig: { iceServers: PUBLIC_ICE_SERVERS },
        };
        if (this.password) {
          config.password = this.password;
        }
        room = joinRoom(config, this.roomId);
        console.info(
          '[zubrameet/p2p] joined room via Trystero/Nostr',
          this.password ? '(E2EE)' : '(no password)',
        );
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

      // media-action — broadcast cam/mic mute state. Регистрируем СРАЗУ,
      // ДО onPeerJoin, чтобы action был готов к отправке вместе с первым
      // peer'ом (Trystero может пушить ранние сообщения если действие уже
      // зарегистрировано на момент handshake).
      const [sendMediaState, getMediaState] =
        room.makeAction<P2PMediaState>('media');
      this.sendMediaState = sendMediaState;

      getMediaState((data, peerId) => {
        try {
          // Защищаемся от мусора в data-channel (битый payload, кривая версия).
          if (
            !data ||
            typeof data !== 'object' ||
            typeof (data as P2PMediaState).cam !== 'boolean' ||
            typeof (data as P2PMediaState).mic !== 'boolean'
          ) {
            return;
          }
          const state: P2PMediaState = {
            cam: (data as P2PMediaState).cam,
            mic: (data as P2PMediaState).mic,
          };
          const prev = this.peerMediaStates.get(peerId);
          if (prev && prev.cam === state.cam && prev.mic === state.mic) return;
          this.peerMediaStates.set(peerId, state);
          this.events.onPeerMediaState?.(peerId, state);
        } catch (err) {
          this.reportError(err, 'getMediaState');
        }
      });

      // Сохраняем локальный stream — onPeerJoin будет пушить его новым
      // peer'ам. Trystero v0.24 НЕ реплеит ранее добавленные стримы автоматом.
      this.cameraStream = localStream;

      // Initial publish — для уже-подключённых peer'ов (если room не пуст).
      try {
        const pubResult = room.addStream(localStream);
        // В разных версиях Trystero addStream возвращает либо void, либо
        // Promise[]. Защищённо: если итерируется — ловим ошибки.
        if (pubResult && typeof (pubResult as { length?: number }).length === 'number') {
          for (const p of pubResult as Promise<unknown>[]) {
            p?.catch?.((err: unknown) => {
              this.reportError(err, 'addStream(initial)');
            });
          }
        }
      } catch (err) {
        this.reportError(err, 'addStream(initial)');
      }

      room.onPeerJoin((peerId) => {
        console.info('[zubrameet/p2p] peer joined:', peerId);
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
          // КРИТИЧНО: сразу шлём текущее cam/mic state новому peer'у. Если мы
          // зашли с выключенной камерой и кто-то заходит позже — без этого он
          // увидел бы у нас «track есть, но кадров нет» = чёрный экран без
          // аватара. Trystero не реплеит ранние action-payload'ы.
          if (this.sendMediaState) {
            void this.sendMediaState(this.localMediaState, peerId).catch(
              (err: unknown) => {
                this.reportError(err, 'sendMediaState(onPeerJoin)');
              },
            );
          }
          // КРИТИЧНО: пушим основной camera+mic stream новому peer'у.
          // Trystero v0.24 НЕ реплеит ранее добавленные стримы — без этого
          // новый peer никогда не увидит наше видео.
          if (this.cameraStream && this.room) {
            try {
              const promises = this.room.addStream(this.cameraStream, peerId);
              if (promises && typeof (promises as { length?: number }).length === 'number') {
                for (const p of promises as Promise<unknown>[]) {
                  p?.catch?.((err: unknown) => {
                    this.reportError(err, 'addStream(camera,newPeer)');
                  });
                }
              }
              console.info('[zubrameet/p2p] pushed camera stream to', peerId);
            } catch (err) {
              this.reportError(err, 'addStream(camera,newPeer)');
            }
          }
          // Если у нас уже активен screen-share — пушим его новому пиру тоже.
          if (this.screenStream && this.room) {
            try {
              const promises = this.room.addStream(
                this.screenStream,
                peerId,
                STREAM_META_SCREEN,
              );
              if (promises && typeof (promises as { length?: number }).length === 'number') {
                for (const p of promises as Promise<unknown>[]) {
                  p?.catch?.((err: unknown) => {
                    this.reportError(err, 'addStream(screen,newPeer)');
                  });
                }
              }
            } catch (err) {
              this.reportError(err, 'addStream(screen,newPeer)');
            }
          }
          // Подвешиваемся на connectionstatechange низлежащего PC.
          this.trackPeerPC(peerId);
        } catch (err) {
          this.reportError(err, 'onPeerJoin');
        }
      });

      room.onPeerLeave((peerId) => {
        console.info('[zubrameet/p2p] peer left:', peerId);
        try {
          this.peerNames.delete(peerId);
          this.peerStreams.delete(peerId);
          this.peerMediaStates.delete(peerId);
          this.trackedPCs.delete(peerId);
          this.events.onPeerLeft(peerId);
        } catch (err) {
          this.reportError(err, 'onPeerLeave');
        }
      });

      room.onPeerStream((stream, peerId, metadata) => {
        console.info('[zubrameet/p2p] peer stream:', peerId, 'meta=', metadata);
        try {
          // metadata третьим аргументом приходит из room.addStream(stream, peers, metadata)
          // на отправляющей стороне. Если metadata === 'screen' — это screen-share,
          // иначе считаем камерой (default).
          const kind: RemoteStreamKind =
            metadata === STREAM_META_SCREEN ? 'screen' : 'camera';
          if (kind === 'camera') {
            this.peerStreams.set(peerId, stream);
          }
          const name = this.peerNames.get(peerId) ?? 'Участник';
          this.events.onRemoteStream(peerId, stream, name, kind);
        } catch (err) {
          this.reportError(err, 'onPeerStream');
        }
      });
    } catch (err) {
      this.reportError(err, 'start');
    }
  }

  // ─── screen sharing ────────────────────────────────────────────────────────

  /**
   * Запускает screen-share: берёт displayMedia, публикует в room с metadata='screen',
   * вешает onended на video-track (на случай "Stop sharing" из браузерного UI).
   * Возвращает полученный MediaStream — caller может использовать для локального preview.
   * Идемпотентен: повторный вызов при активном screen-share вернёт уже полученный стрим.
   */
  async startScreenShare(): Promise<MediaStream> {
    if (this.screenStream) {
      return this.screenStream;
    }
    const room = this.room;
    if (!room) {
      throw new Error('startScreenShare: room not ready');
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 } },
      audio: false,
    });

    // Запоминаем до addStream, чтобы onended-handler знал что мы это запустили.
    this.screenStream = stream;

    // "Stop sharing" из браузерного UI кончает video-track → стопим всё.
    for (const track of stream.getTracks()) {
      track.onended = () => {
        if (this.screenStream === stream) {
          void this.stopScreenShare();
        }
      };
    }

    try {
      // Второй аргумент null = всем активным peer'ам, третий = metadata.
      const promises = room.addStream(stream, null, STREAM_META_SCREEN);
      for (const p of promises) {
        p.catch((err: unknown) => {
          this.reportError(err, 'addStream(screen)');
        });
      }
    } catch (err) {
      this.reportError(err, 'addStream(screen)');
    }

    try {
      this.events.onScreenShareStarted?.(stream);
    } catch (err) {
      this.reportError(err, 'onScreenShareStarted');
    }

    return stream;
  }

  /**
   * Останавливает screen-share: снимает стрим со всех пиров, стопит локальные
   * треки, вызывает onScreenShareStopped. Идемпотентен: если screen-share не
   * активен — no-op.
   */
  async stopScreenShare(): Promise<void> {
    const stream = this.screenStream;
    if (!stream) return;
    // Сразу обнуляем чтобы onended не зашёл рекурсивно.
    this.screenStream = null;

    const room = this.room;
    if (room) {
      try {
        // Trystero room.removeStream возвращает void (см. types.d.mts).
        room.removeStream(stream);
      } catch (err) {
        this.reportError(err, 'removeStream(screen)');
      }
    }

    for (const track of stream.getTracks()) {
      try {
        track.onended = null;
        track.stop();
      } catch {
        /* ignore */
      }
    }

    try {
      this.events.onScreenShareStopped?.();
    } catch (err) {
      this.reportError(err, 'onScreenShareStopped');
    }
  }

  // ─── media state ──────────────────────────────────────────────────────────

  /**
   * Обновляет локальное cam/mic state и broadcast'ит всем peer'ам через
   * 'media' action. Вызывать сразу ПОСЛЕ track.enabled = ... в Meeting.tsx.
   *
   * Идемпотентен: если state не менялся — broadcast всё равно идёт (на случай
   * если у peer'а потерялся data-channel-message; стоимость пакета — десяток
   * байт, дешевле чем долго искать "почему собеседник не видит mute").
   *
   * Если start() ещё не отработал (сценарий «нажали mic toggle до того, как
   * Trystero room поднялся») — просто запоминаем localMediaState; первый
   * onPeerJoin отправит свежее значение новому peer'у.
   */
  setMediaState(state: P2PMediaState): void {
    this.localMediaState = { cam: state.cam, mic: state.mic };
    if (!this.sendMediaState) {
      // Action ещё не зарегистрирован (start() в процессе). Свежее значение
      // отправится при первом onPeerJoin через sendMediaState(localMediaState).
      return;
    }
    try {
      // Без второго аргумента → broadcast всем peer'ам Trystero. Возвращает
      // Promise<void[]> (один на всех). Просто .catch — если у одного peer'а
      // отвалилось, остальным сообщение всё равно ушло.
      const result: unknown = this.sendMediaState(this.localMediaState);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).catch((err: unknown) => {
          this.reportError(err, 'sendMediaState(broadcast)');
        });
      }
    } catch (err) {
      this.reportError(err, 'sendMediaState(broadcast)');
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    // Стопим screen-share треки если активен (мы их создавали — мы и убираем).
    if (this.screenStream) {
      for (const t of this.screenStream.getTracks()) {
        try {
          t.onended = null;
          t.stop();
        } catch {
          /* ignore */
        }
      }
      this.screenStream = null;
    }

    const room = this.room;
    this.room = null;
    this.sendName = null;
    this.sendMediaState = null;
    this.cameraStream = null;
    this.peerNames.clear();
    this.peerStreams.clear();
    this.peerMediaStates.clear();
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

    // Снимаем дефолтный жёсткий потолок битрейта (~500 kbps в P2P) и
    // оставляем браузерному WebRTC bandwidth-estimation адаптировать
    // реальный битрейт по каналу. Жёсткий cap не ставим — пусть на
    // быстром Ethernet идёт хоть 5 Mbps, на 3G автоматически опустится.
    void this.tuneVideoEncoding(pc).catch((err: unknown) => {
      this.reportError(err, 'tuneVideoEncoding');
    });
  }

  // Настраивает encoding-параметры для всех sendonly video-треков этого PC:
  //  - снимает дефолтный maxBitrate (≈500 kbps)
  //  - degradationPreference 'balanced' — при перегрузке сети браузер
  //    балансированно роняет и framerate, и resolution (вместо того чтобы
  //    держать разрешение и фризить)
  //  - networkPriority 'high' — приоритет видео-пакетов над data-channel
  // Безопасно вызывать многократно (setParameters идемпотентен).
  // Ретраит до 5 раз с интервалом 500ms, потому что senders создаются
  // асинхронно после addStream.
  private async tuneVideoEncoding(
    pc: RTCPeerConnection,
    attempt = 0,
  ): Promise<void> {
    let videoSenders = 0;
    for (const sender of pc.getSenders()) {
      if (!sender.track || sender.track.kind !== 'video') continue;
      videoSenders++;
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      let changed = false;
      for (const e of params.encodings) {
        // Снимаем cap — пусть adaptive bandwidth estimation решает.
        if (e.maxBitrate !== undefined) {
          delete e.maxBitrate;
          changed = true;
        }
        if (e.networkPriority !== 'high') {
          e.networkPriority = 'high';
          changed = true;
        }
      }
      // degradationPreference — на уровне всего sender, не encoding.
      if (params.degradationPreference !== 'balanced') {
        params.degradationPreference = 'balanced';
        changed = true;
      }
      if (changed) {
        await sender.setParameters(params);
      }
    }
    if (videoSenders === 0 && attempt < 5 && !this.closed) {
      window.setTimeout(() => {
        void this.tuneVideoEncoding(pc, attempt + 1);
      }, 500);
    }
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
