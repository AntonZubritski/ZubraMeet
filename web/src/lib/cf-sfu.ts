// CF SFU режим. Каждый клиент держит ОДИН RTCPeerConnection к Cloudflare
// Realtime SFU (вместо N peer-connections к каждому участнику в P2P-mesh).
// Все аудио/видео идут через CF anycast edge — нет NAT-traversal'а между
// клиентами, нет TURN, низкая latency cross-country.
//
// Преимущества над P2P-mesh для нашего сценария (cross-country, мобильные
// провайдеры за CGNAT):
//  - не нужен TURN (CF SFU сам ретранслирует, бесплатно 1TB/мес)
//  - подключение в ~1-1.5 сек вместо 4 сек (нет ICE-handshake между peers,
//    только peer↔CF, который anycast и pre-warmed)
//  - линейный масштаб по нагрузке клиента: один upstream + N downstream'ов,
//    вместо N upstream'ов в P2P-mesh
//
// Архитектура:
//  1. Каждый клиент создаёт CF Realtime session (POST /sessions/new) →
//     получает sessionId
//  2. Публикует свои аудио/видео tracks (POST /sessions/{id}/tracks/new
//     с location='local' и нашим SDP offer'ом) → CF возвращает answer
//  3. Через signaling Worker (Durable Object на комнату) обменивается
//     sessionId с другими peer'ами в комнате
//  4. Когда узнаёт о новом peer'е с sessionId — pull'ит его tracks
//     (POST /sessions/{id}/tracks/new с location='remote', sessionId,
//     trackName) → CF присылает свой offer (renegotiate), мы отвечаем
//     answer'ом, начинают приходить ontrack-события
//
// Чат/реакции/mediaState идут через тот же signaling Worker (точечная
// пересылка peer→peer). У CF SFU нет арбитрарных data-channels между
// клиентами — только media. Latency для chat ~200ms, что приемлемо.
//
// API совместим с P2PMeetConnection — Meeting.tsx может использовать оба
// без изменений (только тип конструктора другой).

import {
  DEFAULT_SCREEN_QUALITY,
  getScreenQualityPreset,
  type ScreenQuality,
} from './screen-quality';
import type {
  RemoteStreamKind,
  P2PMediaState,
  P2PScreenState,
  ChatMessage,
  ReactionPayload,
  GifReactionPayload,
  P2PMeetEvents,
} from './p2p';

// Реэкспортируем — Meeting.tsx может импортировать всё из cf-sfu.ts.
export type {
  RemoteStreamKind,
  P2PMediaState,
  P2PScreenState,
  ChatMessage,
  ReactionPayload,
  GifReactionPayload,
  P2PMeetEvents,
} from './p2p';

const SIGNAL_WS_BASE = 'wss://zubrameet-signal.ant-zubritski.workers.dev/room';
const SFU_API_BASE = 'https://zubrameet-sfu-proxy.ant-zubritski.workers.dev';

// Имена tracks как они известны CF SFU. Должны совпадать на publisher и
// subscriber'ах — иначе CF не найдёт что pull'ить.
const TRACK_MIC = 'mic';
const TRACK_CAMERA = 'camera';
const TRACK_SCREEN_VIDEO = 'screen-video';
// Системный звук со экрана (если пользователь включил «Share audio» в picker'е).
// Поддержка getDisplayMedia({audio:true}) платформо-зависима — Chrome/Edge на
// Windows/macOS работают, Firefox не отдаёт системный звук, Safari ограничен
// одной вкладкой. Если audio-track не пришёл — просто публикуем без него.
const TRACK_SCREEN_AUDIO = 'screen-audio';

// Bundle-policy 'max-bundle' — все tracks через один transport. Рекомендуется
// CF docs, минимизирует количество ICE-кандидатов.
const PC_CONFIG: RTCConfiguration = {
  iceServers: [],  // CF SFU обрабатывает ICE на своей стороне
  bundlePolicy: 'max-bundle',
};

interface PeerEntry {
  peerId: string;
  sessionId: string | null;
  name: string;
  // Один MediaStream под audio+video peer'а. Создаётся при первом ontrack.
  cameraStream: MediaStream | null;
  // Уже отправили ли onRemoteStream для этого peer'а (чтобы не дублировать).
  emittedCamera: boolean;
  // Отдельный stream под screen-share этого peer'а — Meeting.tsx ждёт две
  // независимые tile (камера + screen) на одного peer'а.
  screenStream: MediaStream | null;
  emittedScreen: boolean;
  // Поставлен в true когда peer прислал screen-state{active:true}. Сбрасывается
  // в false при screen-state{active:false}. Используется periodic re-pull'ом
  // чтобы понять: peer демонстрирует экран, но мы ещё не получили его треки
  // (та же гонка что и с камерой — publisher tracks/new ещё в полёте на CF,
  // наш первый pull уезжает раньше).
  wantsScreen: boolean;
}

// Что хранится в response.tracks от CF после pull-запроса. Мы маппим mid → peerId
// чтобы при ontrack-событии знать, какой peer приехал.
interface MidMapping {
  peerId: string;
  kind: RemoteStreamKind;
  trackName: string;
}

interface AppSignalEnvelope {
  kind: 'name' | 'media' | 'screen-state' | 'chat' | 'reaction' | 'gif-reaction';
  // shape зависит от kind
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export class CFSFUConnection {
  private readonly roomId: string;
  private readonly displayName: string;
  private readonly events: P2PMeetEvents;
  private readonly peerId: string;

  private sessionId: string | null = null;
  private pc: RTCPeerConnection | null = null;
  private ws: WebSocket | null = null;

  // Локальное cam/mic state, синхронизируется с peer'ами через signal/media.
  private localMediaState: P2PMediaState = { cam: true, mic: true };

  // Активный screen-share стрим (от getDisplayMedia). null когда трансляция
  // не запущена. Используется как локальный preview + источник track'а для
  // /sessions/{id}/tracks/new, и как guard от двойного start'а.
  private screenStream: MediaStream | null = null;
  // Senders, которые мы создали под текущий screen-publish. Сохраняем чтобы
  // на stop сделать replaceTrack(null) и не оставлять «висящие» transceiver'ы
  // в PC, которые при следующем start ломают негошацию.
  private screenSenders: RTCRtpSender[] = [];

  private readonly peers: Map<string, PeerEntry> = new Map();
  // mid → (peerId, kind). Заполняется из ответов /tracks/new (location='remote').
  private readonly midToPeer: Map<string, MidMapping> = new Map();
  // peerId → set of mids — для cleanup при peer-left.
  private readonly peerToMids: Map<string, Set<string>> = new Map();

  // Чтобы pulls для нескольких peer'ов разом батчились в один tracks/new вызов.
  private readonly pullQueue: Set<string> = new Set();
  private pullTimer: number | null = null;

  // Renegotiation мьютекс — параллельные tracks/new ломают SDP state.
  private negotiationLock: Promise<void> = Promise.resolve();

  // WS reconnect state. CF Workers Durable Object иногда обрывает WS без
  // close-frame (code 1006), и наш announce/app-signals (chat, mediaState,
  // screen-state, name) после этого молча перестают доходить. Реконнектим с
  // expo-backoff, после reconnect повторно announce'им наш sessionId — DO
  // пришлёт welcome с актуальным списком peers, и handlePeerKnown идемпотентно
  // переподпишется на новых.
  private wsReconnectAttempt = 0;
  private wsReconnectTimer: number | null = null;

  // Periodic re-pull. После того как сосед делает announce, его tracks могут
  // ещё не быть готовы в CF SFU (его собственный tracks/new (publish) HTTP в
  // полёте). Наш первый pull через 100ms debounce уезжает раньше — CF либо
  // отдаёт пустой data.tracks, либо requiresImmediateRenegotiation:false, и
  // мы подписку не делаем. Worker про это не пинает повторно. До reload
  // соседа не видно. Решение — каждые 2 сек проверять: есть peers с
  // sessionId, но без cameraStream → ещё раз pull. Останавливается когда
  // подписан хотя бы один track (peer.cameraStream !== null).
  private periodicPullTimer: number | null = null;
  private static readonly PERIODIC_PULL_INTERVAL_MS = 2000;

  private closed = false;
  private started = false;

  constructor(
    roomId: string,
    displayName: string,
    events: P2PMeetEvents,
    // password принят для API-совместимости с P2PMeetConnection, но в CF SFU
    // режиме не используется — CF сам шифрует SRTP. Доступ к комнате
    // регулируется уникальностью roomId. Если нужна явная авторизация —
    // добавим серверную проверку в signaling Worker'е.
    _password?: string,
  ) {
    this.roomId = roomId;
    this.displayName = displayName;
    this.events = events;
    // peerId persisted в sessionStorage per-room. Это критично для reload UX:
    // при перезагрузке страницы сохраняется тот же peerId, DO видит дубликат
    // в this.peers, закрывает старое WebSocket-соединение и принимает новое.
    // Без этого reload генерил бы новый peerId, и для остальных участников
    // он выглядел как ещё один отдельный пир рядом со старым (старый ещё не
    // успел timeout'нуться) — копились stale tile'ы и duplicate event'ы.
    this.peerId = getStablePeerId(roomId);
  }

  get peerCount(): number {
    return this.peers.size;
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  async start(localStream: MediaStream): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Логируем что реально пришло в localStream — без этого диагностировать
    // «он меня не слышит» невозможно: не видно, был ли вообще audio-track,
    // включён ли он, и не пришёл ли он muted.
    const audioTracks = localStream.getAudioTracks();
    const videoTracks = localStream.getVideoTracks();
    console.info('[zubrameet/cf-sfu] start', {
      roomId: this.roomId,
      name: this.displayName,
      peerId: this.peerId,
      audio: audioTracks.map((t) => ({
        enabled: t.enabled,
        muted: t.muted,
        readyState: t.readyState,
        label: t.label,
      })),
      video: videoTracks.map((t) => ({
        enabled: t.enabled,
        muted: t.muted,
        readyState: t.readyState,
        label: t.label,
      })),
    });

    try {
      this.events.onLocalStream(localStream);
    } catch (err) {
      this.reportError(err, 'onLocalStream');
    }

    // Параллелим signaling-connect и SFU-publish — обе сетевые операции
    // независимы до момента announce.
    const signalP = this.connectSignal();
    const publishP = this.setupPCAndPublish(localStream);

    try {
      await Promise.all([signalP, publishP]);
    } catch (err) {
      this.reportError(err, 'start');
      return;
    }

    // Сообщаем всем в комнате наш sessionId — чтобы они начали pull нашего media.
    this.announceSession();

    // Запускаем периодический re-pull (см. periodicPullTimer комментарий).
    this.startPeriodicPull();
  }

  private startPeriodicPull(): void {
    if (this.periodicPullTimer !== null) return;
    this.periodicPullTimer = window.setInterval(() => {
      if (this.closed) return;
      let cameraQueued = 0;
      const screenPeers: string[] = [];
      for (const [peerId, entry] of this.peers) {
        if (!entry.sessionId) continue;
        // Подписаны только когда хотя бы один track реально пришёл и emit'ился
        // в UI. До этого момента peer может стоять в peers Map с sessionId,
        // но без живого cameraStream — это и есть «висячий» пир, которого
        // надо retry.
        if (!entry.emittedCamera) {
          this.pullQueue.add(peerId);
          cameraQueued++;
        }
        // Тот же механизм для screen: если peer сообщил что демонстрирует
        // (wantsScreen=true), но мы ещё не приклеили его screen-track —
        // повторим pull. pullScreenFromPeer защищён negotiationLock, так что
        // параллельные вызовы безопасны (и идемпотентны: внутри проверяется
        // emittedScreen). См. ниже добавленный early-return.
        if (entry.wantsScreen && !entry.emittedScreen) {
          screenPeers.push(peerId);
        }
      }
      if (cameraQueued > 0 && this.pullTimer === null) {
        this.pullTimer = window.setTimeout(() => {
          this.pullTimer = null;
          const list = Array.from(this.pullQueue);
          this.pullQueue.clear();
          console.info('[zubrameet/cf-sfu] periodic re-pull for', list.length, 'peer(s)');
          void this.runPull(list);
        }, 100);
      }
      for (const pid of screenPeers) {
        console.info('[zubrameet/cf-sfu] periodic re-pull screen from', pid);
        void this.pullScreenFromPeer(pid);
      }
    }, CFSFUConnection.PERIODIC_PULL_INTERVAL_MS);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pullTimer !== null) {
      window.clearTimeout(this.pullTimer);
      this.pullTimer = null;
    }
    if (this.wsReconnectTimer !== null) {
      window.clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.periodicPullTimer !== null) {
      window.clearInterval(this.periodicPullTimer);
      this.periodicPullTimer = null;
    }
    // Останавливаем screen-share треки — мы их создавали (getDisplayMedia),
    // мы и убираем. localStream (камера) принадлежит caller'у, не трогаем.
    if (this.screenStream) {
      for (const t of this.screenStream.getTracks()) {
        try { t.onended = null; t.stop(); } catch { /* ignore */ }
      }
      this.screenStream = null;
    }
    this.screenSenders = [];
    if (this.pc) {
      try { this.pc.close(); } catch { /* ignore */ }
      this.pc = null;
    }
    if (this.ws) {
      try { this.ws.close(1000, 'leaving'); } catch { /* ignore */ }
      this.ws = null;
    }
    this.peers.clear();
    this.midToPeer.clear();
    this.peerToMids.clear();
    this.pullQueue.clear();
  }

  // ─── signaling ─────────────────────────────────────────────────────────────

  private connectSignal(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = `${SIGNAL_WS_BASE}/${encodeURIComponent(this.roomId)}?peerId=${this.peerId}`;
      const ws = new WebSocket(url);
      this.ws = ws;

      const onOpen = () => {
        ws.removeEventListener('error', onError);
        console.info('[zubrameet/cf-sfu] signal connected');
        this.wsReconnectAttempt = 0;
        resolve();
      };
      const onError = () => {
        ws.removeEventListener('open', onOpen);
        reject(new Error('signal connect failed'));
      };
      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });

      ws.addEventListener('message', (ev) => {
        let msg: unknown;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); }
        catch { return; }
        this.handleSignalMessage(msg);
      });

      ws.addEventListener('close', (ev) => {
        if (this.closed) return;
        // code 1000 = graceful (наш close()) — не реконнектим.
        // code 1006 = abnormal closure (CF Workers Durable Object иногда обрывает
        // соединение, особенно при idle > 60s). Реконнектим с expo-backoff.
        console.warn(`[zubrameet/cf-sfu] ws closed (code=${ev.code}), scheduling reconnect`);
        this.scheduleSignalReconnect();
      });
    });
  }

  private scheduleSignalReconnect(): void {
    if (this.closed) return;
    if (this.wsReconnectTimer !== null) return;
    const attempt = this.wsReconnectAttempt++;
    // 500ms, 1s, 2s, 4s, max 10s.
    const delay = Math.min(500 * Math.pow(2, attempt), 10_000);
    this.wsReconnectTimer = window.setTimeout(() => {
      this.wsReconnectTimer = null;
      if (this.closed) return;
      console.info(`[zubrameet/cf-sfu] ws reconnect attempt #${attempt + 1}`);
      this.connectSignal()
        .then(() => {
          // Перепредставляемся — DO пришлёт нам свежий welcome со списком
          // peers, handlePeerKnown пройдётся идемпотентно (для уже-known
          // peer'ов не дублирует tile, для новых поставит pull в очередь).
          this.announceSession();
        })
        .catch((err) => {
          console.warn('[zubrameet/cf-sfu] ws reconnect failed:', err);
          // Сначала фейл — потом снова scheduleSignalReconnect (срабатывает
          // из onclose listener'а нового неудачного WebSocket'а), backoff
          // продолжится. Если онклоуз не приедет (WebSocket вообще не открылся),
          // явно перепланируем.
          this.scheduleSignalReconnect();
        });
    }, delay);
  }

  private announceSession(): void {
    if (!this.sessionId || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({ type: 'announce', sessionId: this.sessionId }));
    } catch (err) {
      this.reportError(err, 'announceSession');
    }
  }

  private sendAppSignal(targetPeerId: string, payload: AppSignalEnvelope): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify({
        type: 'signal',
        target: targetPeerId,
        payload,
      }));
    } catch (err) {
      this.reportError(err, 'sendAppSignal');
    }
  }

  private broadcastAppSignal(payload: AppSignalEnvelope): void {
    for (const peerId of this.peers.keys()) {
      this.sendAppSignal(peerId, payload);
    }
  }

  private handleSignalMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string; [k: string]: unknown };
    switch (m.type) {
      case 'welcome': {
        const peers = m.peers as Array<{ peerId: string; sessionId: string | null }> | undefined;
        if (Array.isArray(peers)) {
          for (const p of peers) this.handlePeerKnown(p.peerId, p.sessionId);
        }
        break;
      }
      case 'peer-joined': {
        const peerId = m.peerId as string;
        const sessionId = (m.sessionId as string | null) ?? null;
        if (typeof peerId === 'string') this.handlePeerKnown(peerId, sessionId);
        break;
      }
      case 'peer-left': {
        const peerId = m.peerId as string;
        if (typeof peerId === 'string') this.handlePeerLeft(peerId);
        break;
      }
      case 'signal': {
        const from = m.from as string;
        const payload = m.payload as AppSignalEnvelope;
        if (typeof from === 'string' && payload && typeof payload === 'object') {
          this.handleAppSignal(from, payload);
        }
        break;
      }
    }
  }

  private handlePeerKnown(peerId: string, sessionId: string | null): void {
    let entry = this.peers.get(peerId);
    if (!entry) {
      entry = {
        peerId,
        sessionId,
        name: 'Участник',  // настоящее имя придёт через 'name' app-signal
        cameraStream: null,
        emittedCamera: false,
        screenStream: null,
        emittedScreen: false,
        wantsScreen: false,
      };
      this.peers.set(peerId, entry);
      try {
        this.events.onPeerJoined(peerId, entry.name);
      } catch (err) { this.reportError(err, 'onPeerJoined'); }

      // Точечно отправим этому peer'у наше display name + текущее media state.
      // Так каждый peer узнаёт friendly name остальных и видит mute-индикаторы.
      this.sendAppSignal(peerId, { kind: 'name', data: this.displayName });
      this.sendAppSignal(peerId, { kind: 'media', data: this.localMediaState });
      // Если у нас активен screen-share — сразу сообщим новому peer'у, чтобы
      // он зашёл и pull'нул наш screen-track. Иначе он увидит скрин только
      // если мы рестартанем share.
      if (this.screenStream) {
        this.sendAppSignal(peerId, {
          kind: 'screen-state',
          data: { active: true, streamId: this.screenStream.id },
        });
      }
    } else if (sessionId && entry.sessionId !== sessionId) {
      // sessionId сменился — peer перезагрузился или заново выпустил session.
      // Все наши mid-маппинги для старого sessionId теперь ссылаются на
      // мёртвые tracks. Очищаем чтобы новый pull создал чистый mapping и UI
      // не продолжал держать пустую/чёрную tile от старого stream'а.
      const oldMids = this.peerToMids.get(peerId);
      if (oldMids) {
        for (const mid of oldMids) this.midToPeer.delete(mid);
        this.peerToMids.delete(peerId);
      }
      entry.cameraStream = null;
      entry.emittedCamera = false;
      entry.screenStream = null;
      entry.emittedScreen = false;
      // wantsScreen тоже сбрасываем — после reload пир мог завершить
      // screen-share, и пока он не пришлёт нам новое screen-state{active:true},
      // periodic-pull дёргать screen бессмысленно.
      entry.wantsScreen = false;
      entry.sessionId = sessionId;
    }

    // Если у peer'а уже есть sessionId — поставим в очередь pull его tracks.
    if (entry.sessionId) this.queuePull(peerId);
  }

  private handlePeerLeft(peerId: string): void {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    this.peers.delete(peerId);
    // Чистим mid-маппинги (важно чтобы при следующем pull mid'ы не путались).
    const mids = this.peerToMids.get(peerId);
    if (mids) {
      for (const mid of mids) this.midToPeer.delete(mid);
      this.peerToMids.delete(peerId);
    }
    try {
      this.events.onPeerLeft(peerId);
    } catch (err) { this.reportError(err, 'onPeerLeft'); }
  }

  private handleAppSignal(fromPeerId: string, payload: AppSignalEnvelope): void {
    const entry = this.peers.get(fromPeerId);
    if (!entry) return;
    switch (payload.kind) {
      case 'name': {
        const name = typeof payload.data === 'string' ? payload.data.slice(0, 64) : '';
        if (name) {
          entry.name = name;
          try {
            // Перевыпускаем onPeerJoined — UI обновит имя над tile'ом.
            this.events.onPeerJoined(fromPeerId, name);
          } catch (err) { this.reportError(err, 'onPeerJoined(name)'); }
        }
        break;
      }
      case 'media': {
        const d = payload.data as P2PMediaState | undefined;
        if (d && typeof d.cam === 'boolean' && typeof d.mic === 'boolean') {
          try {
            this.events.onPeerMediaState?.(fromPeerId, { cam: d.cam, mic: d.mic });
          } catch (err) { this.reportError(err, 'onPeerMediaState'); }
        }
        break;
      }
      case 'screen-state': {
        const s = payload.data as P2PScreenState | undefined;
        if (s && typeof s.active === 'boolean') {
          const streamId = typeof s.streamId === 'string' ? s.streamId : '';
          if (s.active) {
            // Peer начал share — отмечаем намерение pull'а и тут же пробуем.
            // Если CF SFU ещё не успел зарегистрировать его screen-track
            // (его publish HTTP в полёте), наш pull вернётся с пустыми
            // tracks — periodic re-pull ниже повторит через 2с.
            entry.wantsScreen = true;
            void this.pullScreenFromPeer(fromPeerId);
          } else {
            // Peer остановил share — UI должен убрать screen-tile. Также
            // чистим локальный screenStream + emittedScreen, чтобы при
            // повторном старте share новый stream показался как новый tile.
            entry.wantsScreen = false;
            if (entry.screenStream) {
              entry.screenStream = null;
              entry.emittedScreen = false;
            }
            // КРИТИЧНО для stop→start цикла: publisher не renegotiate'ит CF
            // при stopScreenShare (CF tracks/close вернёт 400 на текущем
            // формате запроса — см. комментарий в stopScreenShare). У CF на
            // session'е остаются «висячие» screen mid'ы. При повторном start
            // на receiver'е могут прилететь ontrack-события на ТЕ ЖЕ mid'ы
            // — наш midToPeer всё ещё содержит {kind:'screen'} mapping для
            // них, handleRemoteTrack кладёт muted track в свежий screenStream
            // → у получателя чёрный экран. Чистим screen-mid'ы заранее,
            // чтобы при повторном start новый pull создал чистый mapping.
            const mids = this.peerToMids.get(fromPeerId);
            if (mids) {
              const toRemove: string[] = [];
              for (const mid of mids) {
                const meta = this.midToPeer.get(mid);
                if (meta?.kind === 'screen') {
                  this.midToPeer.delete(mid);
                  toRemove.push(mid);
                }
              }
              for (const mid of toRemove) mids.delete(mid);
            }
          }
          try {
            this.events.onPeerScreenState?.(fromPeerId, { active: s.active, streamId });
          } catch (err) { this.reportError(err, 'onPeerScreenState'); }
        }
        break;
      }
      case 'chat': {
        const m = payload.data as ChatMessage | undefined;
        if (m && typeof m.id === 'string' && typeof m.text === 'string') {
          const safe: ChatMessage = {
            id: m.id.slice(0, 64),
            text: m.text.slice(0, 2000),
            ts: typeof m.ts === 'number' ? m.ts : Date.now(),
            fromName: typeof m.fromName === 'string' ? m.fromName.slice(0, 64) : entry.name,
          };
          try { this.events.onChatMessage?.(fromPeerId, safe); }
          catch (err) { this.reportError(err, 'onChatMessage'); }
        }
        break;
      }
      case 'reaction': {
        const r = payload.data as ReactionPayload | undefined;
        if (r && typeof r.emoji === 'string') {
          const safe: ReactionPayload = {
            emoji: r.emoji.slice(0, 12),
            ts: typeof r.ts === 'number' ? r.ts : Date.now(),
            fromName: typeof r.fromName === 'string' ? r.fromName.slice(0, 64) : entry.name,
          };
          try { this.events.onReaction?.(fromPeerId, safe); }
          catch (err) { this.reportError(err, 'onReaction'); }
        }
        break;
      }
      case 'gif-reaction': {
        const g = payload.data as GifReactionPayload | undefined;
        if (g && typeof g.url === 'string' && g.url.startsWith('https://') && g.url.length < 2000) {
          const safe: GifReactionPayload = {
            url: g.url,
            width: clampDim(g.width),
            height: clampDim(g.height),
            ts: typeof g.ts === 'number' ? g.ts : Date.now(),
            fromName: typeof g.fromName === 'string' ? g.fromName.slice(0, 64) : entry.name,
          };
          try { this.events.onGifReaction?.(fromPeerId, safe); }
          catch (err) { this.reportError(err, 'onGifReaction'); }
        }
        break;
      }
    }
  }

  // ─── CF SFU: publish own tracks ───────────────────────────────────────────

  private async setupPCAndPublish(localStream: MediaStream): Promise<void> {
    const pc = new RTCPeerConnection(PC_CONFIG);
    this.pc = pc;

    pc.addEventListener('track', (event) => this.handleRemoteTrack(event));

    pc.addEventListener('connectionstatechange', () => {
      console.info('[zubrameet/cf-sfu] pc state:', pc.connectionState);
    });

    // CF Realtime API требует двух отдельных шагов:
    //  1) POST /sessions/new — обязателен валидный SDP offer (CF использует
    //     его только для setup ICE/DTLS-канала, media в нём игнорируется).
    //     Возвращает sessionId + answer для setup'а PC.
    //  2) POST /sessions/{id}/tracks/new — здесь уже подаётся offer С tracks
    //     (sendonly transceivers) + явный список { location:'local', mid, trackName }.
    //     CF принимает наши tracks и возвращает answer.
    //
    // Объединить в один запрос нельзя — sessions/new игнорирует media в SDP.

    // Bootstrap-этап: создаём sendonly transceiver'ы (без real tracks пока),
    // делаем минимальный offer, отправляем в sessions/new для получения sessionId.
    // КРИТИЧНО: храним ссылки на сами объекты, а не ищем потом через filter по
    // .receiver.track.kind — на sendonly transceiver'ах receiver direction
    // inactive, kind может быть unset, и lookup ломается (mic тогда replace'ится
    // в video-trx → CF получает audio под video-mid → audio mid вообще без
    // трека → peer'ы tracks/new(mic) получают пустоту и тебя не слышат).
    const audioTrx = pc.addTransceiver('audio', { direction: 'sendonly' });
    const videoTrx = pc.addTransceiver('video', { direction: 'sendonly' });

    const bootstrapOffer = await pc.createOffer();
    await pc.setLocalDescription(bootstrapOffer);
    await iceGatheringComplete(pc, 3000);

    const sessionRes = await fetch(`${SFU_API_BASE}/sessions/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionDescription: pc.localDescription }),
    });
    if (!sessionRes.ok) {
      throw new Error(`sessions/new failed: ${sessionRes.status} ${await sessionRes.text()}`);
    }
    const sessionData = (await sessionRes.json()) as {
      sessionId?: string;
      sessionDescription?: RTCSessionDescriptionInit;
    };
    if (!sessionData.sessionId || !sessionData.sessionDescription) {
      throw new Error('sessions/new: missing sessionId or sessionDescription');
    }
    this.sessionId = sessionData.sessionId;
    await pc.setRemoteDescription(sessionData.sessionDescription);
    console.info('[zubrameet/cf-sfu] session created:', this.sessionId);

    // Race recovery: пока мы создавали session, signaling Worker мог уже
    // прислать welcome со списком других peer'ов. Их queuePull сработал, но
    // pullTracksImpl увидел this.sessionId === null и тихо вышел. Теперь
    // sessionId есть — переинициируем pull для всех известных peer'ов с
    // готовым sessionId. Без этого тот кто зашёл первым НЕ увидит других
    // (асимметрия: второй видит первого через welcome, первый первого нет).
    for (const [peerId, entry] of this.peers) {
      if (entry.sessionId) this.queuePull(peerId);
    }

    // Publish-этап: подменяем сохранённым выше sendonly transceiver'ам real
    // tracks от localStream через replaceTrack (не требует renegotiation),
    // потом делаем offer и шлём в tracks/new с явным mid+trackName маппингом.
    const audioTrack = localStream.getAudioTracks()[0];
    const videoTrack = localStream.getVideoTracks()[0];

    if (audioTrack) await audioTrx.sender.replaceTrack(audioTrack);
    if (videoTrack) await videoTrx.sender.replaceTrack(videoTrack);

    // Make offer уже с реальными tracks.
    const publishOffer = await pc.createOffer();
    await pc.setLocalDescription(publishOffer);

    const tracks: Array<{ location: 'local'; mid: string; trackName: string }> = [];
    if (audioTrx.mid && audioTrack) {
      tracks.push({ location: 'local', mid: audioTrx.mid, trackName: TRACK_MIC });
    }
    if (videoTrx.mid && videoTrack) {
      tracks.push({ location: 'local', mid: videoTrx.mid, trackName: TRACK_CAMERA });
    }
    console.info('[zubrameet/cf-sfu] publishing tracks:', tracks, {
      audioMid: audioTrx.mid,
      videoMid: videoTrx.mid,
      hasAudio: !!audioTrack,
      hasVideo: !!videoTrack,
    });
    if (tracks.length === 0) {
      console.warn('[zubrameet/cf-sfu] no local tracks to publish (no audio/video?)');
      // Откатываем publishOffer — без этого PC застрянет в have-local-offer,
      // и любой последующий pull renegotiate (CF присылает свой offer) упадёт
      // в InvalidStateError. Симптом: ты никого не видишь/не слышишь, потому
      // что setRemoteDescription для pull'нутых tracks тихо падает.
      try { await pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit); }
      catch (err) { console.warn('[zubrameet/cf-sfu] rollback failed', err); }
      return;
    }

    const tracksRes = await fetch(
      `${SFU_API_BASE}/sessions/${this.sessionId}/tracks/new`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionDescription: pc.localDescription,
          tracks,
        }),
      },
    );
    if (!tracksRes.ok) {
      throw new Error(`tracks/new (publish) failed: ${tracksRes.status} ${await tracksRes.text()}`);
    }
    const tracksData = (await tracksRes.json()) as {
      sessionDescription: RTCSessionDescriptionInit;
    };
    await pc.setRemoteDescription(tracksData.sessionDescription);
    console.info('[zubrameet/cf-sfu] published local tracks');

    // Через 3 сек после publish'а снимаем outbound-rtp stats — если для audio
    // packetsSent == 0, значит трек дошёл до CF но реально RTP не льётся
    // (track muted, audio source молчит, RNNoise worklet не пропускает звук).
    // Это финальный критерий «реально ли peer слышит меня».
    window.setTimeout(() => {
      if (!this.pc || this.closed) return;
      void this.pc.getStats().then((stats) => {
        const summary: Array<{ kind: string; packets: number; bytes: number; mid?: string }> = [];
        stats.forEach((report) => {
          if (report.type === 'outbound-rtp') {
            const r = report as RTCOutboundRtpStreamStats & { mid?: string };
            summary.push({
              kind: r.kind,
              packets: r.packetsSent ?? 0,
              bytes: r.bytesSent ?? 0,
              mid: r.mid,
            });
          }
        });
        console.info('[zubrameet/cf-sfu] outbound-rtp after 3s:', summary);
      }).catch(() => { /* getStats может фейлить — ничего страшного */ });
    }, 3000);
  }

  // ─── CF SFU: pull peer tracks ─────────────────────────────────────────────

  private queuePull(peerId: string): void {
    this.pullQueue.add(peerId);
    if (this.pullTimer !== null) return;
    // Дебаунс — если несколько peer'ов появились один за другим, сделаем один
    // батчевый pull. 100ms — компромисс между batching-эффектом и UX-задержкой.
    this.pullTimer = window.setTimeout(() => {
      this.pullTimer = null;
      const queued = Array.from(this.pullQueue);
      this.pullQueue.clear();
      void this.runPull(queued);
    }, 100);
  }

  private async runPull(peerIds: string[]): Promise<void> {
    // Сериализуем negotiation — параллельные SDP-операции на одном PC ломают state.
    const prev = this.negotiationLock;
    let release!: () => void;
    this.negotiationLock = new Promise<void>((res) => { release = res; });
    await prev;
    try {
      await this.pullTracksImpl(peerIds);
    } catch (err) {
      this.reportError(err, 'runPull');
    } finally {
      release();
    }
  }

  private async pullTracksImpl(peerIds: string[]): Promise<void> {
    if (!this.pc || this.closed) return;
    // sessionId ещё не готов — setupPCAndPublish не успел вернуться. Не теряем
    // peerIds: вернём их в pullQueue. setupPCAndPublish сам триггернёт повторный
    // pull когда sessionId установится (см. вызов queuePull в конце publish-flow).
    if (!this.sessionId) {
      for (const pid of peerIds) this.pullQueue.add(pid);
      return;
    }

    // Собираем list remote-tracks, попутно запоминая порядок чтобы потом
    // смаппить ответ обратно на peerId.
    const requestTracks: Array<{ location: 'remote'; sessionId: string; trackName: string }> = [];
    const order: Array<{ peerId: string; kind: RemoteStreamKind; trackName: string }> = [];
    for (const pid of peerIds) {
      const peer = this.peers.get(pid);
      if (!peer || !peer.sessionId) continue;
      requestTracks.push({ location: 'remote', sessionId: peer.sessionId, trackName: TRACK_MIC });
      order.push({ peerId: pid, kind: 'camera', trackName: TRACK_MIC });
      requestTracks.push({ location: 'remote', sessionId: peer.sessionId, trackName: TRACK_CAMERA });
      order.push({ peerId: pid, kind: 'camera', trackName: TRACK_CAMERA });
    }
    if (requestTracks.length === 0) return;

    const res = await fetch(
      `${SFU_API_BASE}/sessions/${this.sessionId}/tracks/new`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracks: requestTracks }),
      },
    );
    if (!res.ok) {
      throw new Error(`tracks/new (pull) failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as {
      requiresImmediateRenegotiation?: boolean;
      sessionDescription?: RTCSessionDescriptionInit;
      tracks?: Array<{ mid?: string; trackName?: string }>;
    };

    // Маппим ответ tracks → (peerId, kind). Раньше полагались на порядок,
    // но при гонке announce/publish CF может вернуть частичный ответ
    // (например только camera, без mic пока publish ещё не доехал) — тогда
    // length-проверка отбрасывала весь mapping и pull пропадал в пустоту.
    // Теперь матчим по trackName из ответа, что робастно к частичным
    // ответам; periodic re-pull позже подтянет недостающие.
    if (data.tracks) {
      if (data.tracks.length !== order.length) {
        console.warn(
          '[zubrameet/cf-sfu] partial pull response:',
          `requested=${order.length} returned=${data.tracks.length}`,
          'peers=', peerIds,
        );
      }
      for (let i = 0; i < data.tracks.length; i++) {
        const t = data.tracks[i];
        const mid = t.mid;
        if (typeof mid !== 'string') continue;
        // Сначала пробуем смаппить по trackName (если CF вернул) на нашу
        // order-запись с тем же trackName. Это устойчиво к перемешиванию или
        // пропускам в ответе.
        const meta = (typeof t.trackName === 'string'
          ? order.find((o) => o.trackName === t.trackName)
          : null) ?? order[i];
        if (!meta) continue;
        this.midToPeer.set(mid, meta);
        let mids = this.peerToMids.get(meta.peerId);
        if (!mids) {
          mids = new Set();
          this.peerToMids.set(meta.peerId, mids);
        }
        mids.add(mid);
      }
    }

    if (data.requiresImmediateRenegotiation && data.sessionDescription) {
      await this.pc.setRemoteDescription(data.sessionDescription);
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      const renegotiateRes = await fetch(
        `${SFU_API_BASE}/sessions/${this.sessionId}/renegotiate`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionDescription: this.pc.localDescription }),
        },
      );
      if (!renegotiateRes.ok) {
        throw new Error(`renegotiate failed: ${renegotiateRes.status} ${await renegotiateRes.text()}`);
      }
      console.info('[zubrameet/cf-sfu] renegotiated for', peerIds.length, 'peer(s)');
    }
  }

  private handleRemoteTrack(event: RTCTrackEvent): void {
    const mid = event.transceiver.mid;
    if (!mid) {
      console.warn('[zubrameet/cf-sfu] remote track has no mid, skipping');
      return;
    }
    const meta = this.midToPeer.get(mid);
    if (!meta) {
      // mid не маппится — track пришёл раньше чем мы успели сохранить mapping.
      // Маловероятно (мы сохраняем до setRemoteDescription), но безопасно warn.
      console.warn('[zubrameet/cf-sfu] no mapping for mid', mid);
      return;
    }
    const peer = this.peers.get(meta.peerId);
    if (!peer) {
      console.warn('[zubrameet/cf-sfu] track for unknown peer', meta.peerId);
      return;
    }

    if (meta.kind === 'screen') {
      // Screen-share: отдельный MediaStream под screen-track, рендерится
      // как отдельный tile в VideoGrid. У screen в нашей реализации только
      // video (без audio) — он там не нужен и упрощает API.
      if (!peer.screenStream) {
        peer.screenStream = new MediaStream();
      }
      peer.screenStream.addTrack(event.track);
      if (!peer.emittedScreen) {
        peer.emittedScreen = true;
        try {
          this.events.onRemoteStream(peer.peerId, peer.screenStream, peer.name, 'screen');
        } catch (err) { this.reportError(err, 'onRemoteStream(screen)'); }
      }
      return;
    }

    // camera (default): аггрегируем audio + video одного peer'а в один
    // MediaStream — UI ожидает именно так (один <video> с обоими треками).
    if (!peer.cameraStream) {
      peer.cameraStream = new MediaStream();
    }
    peer.cameraStream.addTrack(event.track);
    console.info(
      '[zubrameet/cf-sfu] remote track attached',
      { peerId: meta.peerId, kind: event.track.kind, trackName: meta.trackName, mid },
    );

    if (!peer.emittedCamera) {
      peer.emittedCamera = true;
      try {
        this.events.onRemoteStream(peer.peerId, peer.cameraStream, peer.name, 'camera');
      } catch (err) { this.reportError(err, 'onRemoteStream'); }
    }
  }

  // ─── CF SFU: pull peer screen-track ───────────────────────────────────────

  private async pullScreenFromPeer(peerId: string): Promise<void> {
    if (!this.pc || this.closed) return;
    const peer = this.peers.get(peerId);
    if (!peer || !peer.sessionId) return;
    // Идемпотентность для periodic re-pull'а: если screen-track уже пришёл и
    // отдан UI'ю — больше pull'ить не нужно. Без этого мы бы плодили дубли
    // recvonly transceiver'ов и getting "no mapping for mid" warnings.
    if (peer.emittedScreen) return;
    if (!this.sessionId) {
      // Не готово ещё — повторим когда setupPCAndPublish закончит. Простейший
      // способ — кладём в обычную pullQueue, и в финальной проверке там
      // отработает (camera tracks тоже подтянутся, не страшно).
      this.pullQueue.add(peerId);
      return;
    }

    // Сериализуем negotiation. Параллельный pull camera + screen может
    // случиться если screen-state приходит вплотную к peer-joined — без lock'а
    // setRemoteDescription может улететь в InvalidStateError.
    const prev = this.negotiationLock;
    let release!: () => void;
    this.negotiationLock = new Promise<void>((res) => { release = res; });
    await prev;
    try {
      // Pull обе trackName — video обязательно, audio если у publisher'а есть.
      // CF возвращает 404-подобную ошибку на отсутствующий track, поэтому шлём
      // оба запроса; если audio не был опубликован, CF просто не отдаст его mid
      // (или вернёт ошибку для всего request, что обрабатывается ниже).
      const requestTracks = [
        { location: 'remote' as const, sessionId: peer.sessionId, trackName: TRACK_SCREEN_VIDEO },
        { location: 'remote' as const, sessionId: peer.sessionId, trackName: TRACK_SCREEN_AUDIO },
      ];
      let res = await fetch(
        `${SFU_API_BASE}/sessions/${this.sessionId}/tracks/new`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tracks: requestTracks }),
        },
      );
      // Если CF не нашёл audio (publisher делил без звука) — повторим только
      // с video. Без этого fallback'а весь pull падает и screen вообще не
      // приходит.
      if (!res.ok) {
        const fallback = await fetch(
          `${SFU_API_BASE}/sessions/${this.sessionId}/tracks/new`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tracks: [requestTracks[0]],  // только video
            }),
          },
        );
        if (!fallback.ok) {
          throw new Error(`tracks/new (pull screen) failed: ${res.status} ${await res.text()}`);
        }
        res = fallback;
      }
      const data = (await res.json()) as {
        requiresImmediateRenegotiation?: boolean;
        sessionDescription?: RTCSessionDescriptionInit;
        tracks?: Array<{ mid?: string; trackName?: string }>;
      };
      console.info(
        '[zubrameet/cf-sfu] pullScreen response',
        { peerId, tracks: data.tracks, renegotiate: data.requiresImmediateRenegotiation },
      );
      if (data.tracks) {
        for (const t of data.tracks) {
          if (typeof t.mid !== 'string') continue;
          // trackName из CF — может быть screen-video или screen-audio.
          // Оба маппим под kind='screen', чтобы handleRemoteTrack
          // одинаково собрал их в один screenStream.
          const trackName = typeof t.trackName === 'string' ? t.trackName : TRACK_SCREEN_VIDEO;
          this.midToPeer.set(t.mid, {
            peerId,
            kind: 'screen',
            trackName,
          });
          let mids = this.peerToMids.get(peerId);
          if (!mids) { mids = new Set(); this.peerToMids.set(peerId, mids); }
          mids.add(t.mid);
        }
      }
      if (data.requiresImmediateRenegotiation && data.sessionDescription) {
        await this.pc.setRemoteDescription(data.sessionDescription);
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        const renegotiateRes = await fetch(
          `${SFU_API_BASE}/sessions/${this.sessionId}/renegotiate`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionDescription: this.pc.localDescription }),
          },
        );
        if (!renegotiateRes.ok) {
          throw new Error(`renegotiate (screen) failed: ${renegotiateRes.status}`);
        }
        console.info('[zubrameet/cf-sfu] pulled screen from', peerId);
      }
    } catch (err) {
      this.reportError(err, 'pullScreenFromPeer');
    } finally {
      release();
    }
  }

  // ─── public API: chat/reactions/media-state ───────────────────────────────

  setMediaState(state: P2PMediaState): void {
    this.localMediaState = { cam: state.cam, mic: state.mic };
    this.broadcastAppSignal({ kind: 'media', data: this.localMediaState });
  }

  sendChatMessage(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const msg: ChatMessage = {
      id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      text: trimmed.slice(0, 2000),
      ts: Date.now(),
      fromName: this.displayName,
    };
    this.broadcastAppSignal({ kind: 'chat', data: msg });
    try { this.events.onChatMessage?.('self', msg); }
    catch (err) { this.reportError(err, 'onChatMessage(self)'); }
  }

  sendReaction(emoji: string): void {
    const trimmed = emoji.trim();
    if (trimmed.length === 0) return;
    const payload: ReactionPayload = {
      emoji: trimmed.slice(0, 12),
      ts: Date.now(),
      fromName: this.displayName,
    };
    this.broadcastAppSignal({ kind: 'reaction', data: payload });
    try { this.events.onReaction?.('self', payload); }
    catch (err) { this.reportError(err, 'onReaction(self)'); }
  }

  sendGifReaction(url: string, width: number, height: number): void {
    if (typeof url !== 'string' || !url.startsWith('https://') || url.length > 2000) return;
    const payload: GifReactionPayload = {
      url,
      width: clampDim(width),
      height: clampDim(height),
      ts: Date.now(),
      fromName: this.displayName,
    };
    this.broadcastAppSignal({ kind: 'gif-reaction', data: payload });
    try { this.events.onGifReaction?.('self', payload); }
    catch (err) { this.reportError(err, 'onGifReaction(self)'); }
  }

  // ─── screen share ─────────────────────────────────────────────────────────

  /**
   * Запускает screen-share через CF SFU: getDisplayMedia → новый sendonly
   * transceiver на нашей PC → publish через /sessions/{id}/tracks/new →
   * broadcast через signaling 'screen-state'={active:true}, чтобы peers
   * pull'нули наш screen-track.
   *
   * @param quality preset (HD/FullHD/4K) — влияет на resolution и frameRate
   *   в getDisplayMedia + maxBitrate в encoding params.
   */
  async startScreenShare(quality: ScreenQuality = DEFAULT_SCREEN_QUALITY): Promise<MediaStream> {
    if (this.screenStream) return this.screenStream;
    if (!this.pc || !this.sessionId) {
      throw new Error('startScreenShare: SFU connection not ready');
    }
    if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
      throw new Error('Демонстрация экрана не поддерживается в этом браузере (мобильные iOS/Android не дают доступ к screen capture).');
    }

    const preset = getScreenQualityPreset(quality);
    // audio: true — просим браузер показать в picker'е чекбокс «Share audio».
    // Если пользователь его не выберет (или платформа не поддерживает —
    // Firefox, Safari в большинстве случаев) — getDisplayMedia вернёт stream
    // только с video-track, и мы это нормально обработаем.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: preset.frameRate },
      },
      audio: true,
    });

    // Защита от mirror-loop: если пользователь через picker выбрал саму
    // вкладку ZubraMeet — отменяем (бесконечная рекурсия + ужасный feedback).
    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack) {
      const settings = videoTrack.getSettings() as MediaTrackSettings & {
        displaySurface?: string;
      };
      const isBrowserTab = settings.displaySurface === 'browser';
      const labelHasOwnHost =
        typeof window !== 'undefined' &&
        videoTrack.label.length > 0 &&
        videoTrack.label.includes(window.location.hostname);
      if (isBrowserTab && labelHasOwnHost) {
        for (const t of stream.getTracks()) {
          try { t.stop(); } catch { /* ignore */ }
        }
        throw new Error(
          'Нельзя демонстрировать саму вкладку ZubraMeet — это создаст бесконечную рекурсию. Выберите другую вкладку, окно или весь экран.',
        );
      }
      // contentHint='detail' — encoder приоритезирует резкость для текста/UI
      // над плавностью движения.
      try { videoTrack.contentHint = 'detail'; } catch { /* ignore */ }
    }

    this.screenStream = stream;

    // "Stop sharing" из browser overlay → стопим всё.
    for (const track of stream.getTracks()) {
      track.onended = () => {
        if (this.screenStream === stream) {
          void this.stopScreenShare();
        }
      };
    }

    if (!videoTrack) {
      // Без video-track делать нечего — getDisplayMedia вернул пустой stream.
      this.screenStream = null;
      throw new Error('startScreenShare: не получен video-track');
    }

    // Аудио экрана может быть, может не быть — зависит от того согласился ли
    // пользователь в picker'е и поддерживает ли браузер. Используем всё что
    // выдали; будем publish только реально присутствующие tracks.
    const audioTrack = stream.getAudioTracks()[0] ?? null;

    // Отдельные sendonly transceiver'ы под screen-video и (опционально)
    // screen-audio. Сериализуем под negotiationLock — параллельно может
    // работать pull новых peer'ов.
    const prev = this.negotiationLock;
    let release!: () => void;
    this.negotiationLock = new Promise<void>((res) => { release = res; });
    await prev;
    let videoSender: RTCRtpSender | null = null;
    // Очищаем список с прошлого share — на случай неполного cleanup'а
    // (например, ошибка в середине предыдущего start'а).
    this.screenSenders = [];
    try {
      // VP9 SVC (Scalable Video Coding) — внутри ОДНОГО RTP-потока зашиваем
      // несколько scalability layers (3 spatial × 3 temporal в режиме K_SVC).
      // Upload остаётся равен preset.maxBitrate, как у обычного single-layer
      // encoding — никакого +1.5× simulcast tax. При этом CF SFU умеет
      // отбрасывать «верхние» layers для каждого получателя независимо: у
      // кого слабый канал — получит низкое разрешение и/или меньше fps;
      // у кого быстрый — полный поток. Это работает только если CF получит
      // VP9-поток (H.264 SVC в браузерах не поддерживается, VP8 SVC —
      // только temporal). Поэтому ниже принудительно ставим VP9 в codec
      // preferences ДО createOffer.
      //
      // L3T3_KEY = 3 spatial × 3 temporal с aligned key-frames (важно для
      // screen-share — позволяет SFU чисто переключаться между layers без
      // визуальных артефактов). Если encoder/браузер не поддержит — поле
      // scalabilityMode будет проигнорировано и поток поедет single-layer.
      // scalabilityMode пока не описан в стандартном lib.dom.d.ts (это
      // относительно свежий WebRTC SVC API), поэтому передаём через cast.
      // Браузеры которые не понимают поле — просто игнорируют.
      const videoTrx = this.pc.addTransceiver(videoTrack, {
        direction: 'sendonly',
        streams: [stream],
        sendEncodings: [{
          scalabilityMode: 'L3T3_KEY',
        } as RTCRtpEncodingParameters],
      });
      videoSender = videoTrx.sender;
      this.screenSenders.push(videoTrx.sender);

      // Принудительно VP9 — ставим его первым в codec preferences. Без этого
      // Chrome для screen-share может выбрать VP8 или H.264 (зависит от
      // negotiation), а у обоих proper SVC не работает: VP8 — только
      // temporal scalability, H.264 — никакого SVC в браузере.
      try {
        const caps = RTCRtpSender.getCapabilities?.('video');
        if (caps && typeof videoTrx.setCodecPreferences === 'function') {
          const vp9 = caps.codecs.filter((c) => c.mimeType.toLowerCase() === 'video/vp9');
          const others = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== 'video/vp9');
          if (vp9.length > 0) {
            videoTrx.setCodecPreferences([...vp9, ...others]);
          }
        }
      } catch (err) {
        // setCodecPreferences может падать на старых браузерах — ничего
        // страшного, поедем тем codec'ом что выберет negotiation.
        console.warn('[zubrameet/cf-sfu] setCodecPreferences(VP9) failed', err);
      }
      const audioTrx = audioTrack
        ? this.pc.addTransceiver(audioTrack, { direction: 'sendonly', streams: [stream] })
        : null;
      if (audioTrx) this.screenSenders.push(audioTrx.sender);

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      const trackList: Array<{ location: 'local'; mid: string; trackName: string }> = [];
      if (videoTrx.mid) trackList.push({ location: 'local', mid: videoTrx.mid, trackName: TRACK_SCREEN_VIDEO });
      if (audioTrx?.mid) trackList.push({ location: 'local', mid: audioTrx.mid, trackName: TRACK_SCREEN_AUDIO });

      const tracksRes = await fetch(
        `${SFU_API_BASE}/sessions/${this.sessionId}/tracks/new`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionDescription: this.pc.localDescription,
            tracks: trackList,
          }),
        },
      );
      if (!tracksRes.ok) {
        throw new Error(`tracks/new (publish screen) failed: ${tracksRes.status} ${await tracksRes.text()}`);
      }
      const tracksData = (await tracksRes.json()) as {
        sessionDescription: RTCSessionDescriptionInit;
      };
      await this.pc.setRemoteDescription(tracksData.sessionDescription);
      console.info(
        '[zubrameet/cf-sfu] published screen track' + (audioTrack ? ' + audio' : ''),
      );
    } catch (err) {
      // Откатить — иначе зависнет в half-state.
      for (const t of stream.getTracks()) {
        try { t.onended = null; t.stop(); } catch { /* ignore */ }
      }
      this.screenStream = null;
      release();
      throw err;
    }
    release();

    // maxBitrate из preset — потолок upstream'а к CF SFU. degradationPreference
    // 'maintain-resolution' — при упоре в потолок роняем fps, а не resolution.
    // Для screen-share (текст / UI / документы) чёткость важнее плавности.
    // networkPriority 'high' — приоритет полосы над фоновыми соединениями.
    // scalabilityMode уже выставлен в addTransceiver — здесь его сохраняем.
    if (videoSender) {
      try {
        const params = videoSender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        for (const enc of params.encodings) {
          enc.maxBitrate = preset.maxBitrate;
          enc.networkPriority = 'high';
        }
        params.degradationPreference = 'maintain-resolution';
        await videoSender.setParameters(params);

        // Диагностика: после applyParameters читаем что реально применилось.
        // Если scalabilityMode не сохранилось — значит браузер/encoder его
        // не поддерживает и поток едет single-layer, без SVC-преимуществ.
        const applied = videoSender.getParameters();
        const enc0 = applied.encodings?.[0] as
          | (RTCRtpEncodingParameters & { scalabilityMode?: string })
          | undefined;
        const negotiatedCodec = (applied as RTCRtpSendParameters & {
          codecs?: ReadonlyArray<{ mimeType?: string }>;
        }).codecs?.[0]?.mimeType;
        console.info(
          '[zubrameet/cf-sfu] screen encoder:',
          `codec=${negotiatedCodec ?? '?'}`,
          `scalabilityMode=${enc0?.scalabilityMode ?? 'none'}`,
          `maxBitrate=${enc0?.maxBitrate ?? '?'}`,
        );
      } catch (err) {
        console.warn('[zubrameet/cf-sfu] setParameters(screen) failed', err);
      }
    }

    // Уведомляем peers — они начнут pull нашего screen.
    this.broadcastAppSignal({
      kind: 'screen-state',
      data: { active: true, streamId: stream.id },
    });

    try { this.events.onScreenShareStarted?.(stream); }
    catch (err) { this.reportError(err, 'onScreenShareStarted'); }

    return stream;
  }

  /**
   * Останавливает screen-share. Идемпотентен.
   */
  async stopScreenShare(): Promise<void> {
    const stream = this.screenStream;
    if (!stream) return;
    this.screenStream = null;

    // Сразу broadcast — receiver'ы уберут screen-tile даже не дожидаясь
    // нашего sender cleanup'а.
    this.broadcastAppSignal({
      kind: 'screen-state',
      data: { active: false, streamId: stream.id },
    });

    // КРИТИЧНО: replaceTrack(null) + removeTrack для всех наших screen-sender'ов
    // ДО stop()/close(). Без этого при следующем startScreenShare PC окажется
    // с двумя transceiver'ами под screen-video (stopped + новый), CF не понимает
    // SDP и возвращает 400 на tracks/new — у получателей чёрный экран.
    // pc.removeTrack помечает transceiver как direction=inactive, и при
    // следующей negotiation он не участвует.
    if (this.pc) {
      for (const sender of this.screenSenders) {
        try { await sender.replaceTrack(null); } catch { /* ignore */ }
        try { this.pc.removeTrack(sender); } catch { /* ignore */ }
      }
    }
    this.screenSenders = [];

    // Стопим local tracks (это останавливает захват с экрана).
    for (const track of stream.getTracks()) {
      try {
        track.onended = null;
        track.stop();
      } catch { /* ignore */ }
    }

    // Намеренно НЕ вызываем CF tracks/close здесь — текущий формат запроса
    // ({trackName}) возвращает 400 Bad Request, а правильная сигнатура
    // зависит от mid/sessionId на стороне receiver'ов и не документирована
    // в публичном API на этом уровне детализации. removeTrack выше уже
    // фактически освобождает sender для CF (он увидит пустой transceiver
    // в следующем SDP). При close PeerConnection слот в любом случае
    // освободится. Если когда-нибудь понадобится ранний cleanup на CF
    // стороне — добавим renegotiate с новым SDP, в котором screen-track'и
    // отсутствуют.

    try { this.events.onScreenShareStopped?.(); }
    catch (err) { this.reportError(err, 'onScreenShareStopped'); }
  }

  // ─── private ──────────────────────────────────────────────────────────────

  private reportError(err: unknown, ctx: string): void {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[zubrameet/cf-sfu] ${ctx}: ${msg}`);
    try {
      this.events.onError(new Error(`cf-sfu[${ctx}]: ${msg}`));
    } catch { /* swallow */ }
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function generatePeerId(): string {
  // 16 hex chars — достаточно для уникальности в комнате.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Возвращает стабильный per-room peerId. Хранится в sessionStorage —
// живёт пока вкладка открыта (включая reload), исчезает при close. Это
// делает reload незаметным для других участников: тот же peerId → DO
// закрывает старый WebSocket и переиспользует entry; не плодим дубликаты.
function getStablePeerId(roomId: string): string {
  const key = `zubrameet.peer.${roomId}`;
  try {
    const cached = window.sessionStorage.getItem(key);
    if (cached && /^[a-f0-9]{16}$/.test(cached)) return cached;
  } catch { /* sessionStorage может быть отключён */ }
  const fresh = generatePeerId();
  try { window.sessionStorage.setItem(key, fresh); } catch { /* ignore */ }
  return fresh;
}

function clampDim(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 240;
  if (n > 4096) return 4096;
  return Math.round(n);
}

// CF Realtime API ожидает полный SDP без trickle ICE — т.е. мы должны
// дождаться завершения ICE-gathering перед отправкой offer'а. Возвращает
// promise который резолвится при iceGatheringState='complete' или по таймауту
// (если gathering зависнет — отправим то что собрали).
function iceGatheringComplete(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', onChange);
      window.clearTimeout(t);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') cleanup();
    };
    pc.addEventListener('icegatheringstatechange', onChange);
    const t = window.setTimeout(cleanup, timeoutMs);
  });
}
