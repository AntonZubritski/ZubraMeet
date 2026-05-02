import { SignalClient } from './signal';
import { PUBLIC_ICE_SERVERS } from './ice';
import {
  DEFAULT_SCREEN_QUALITY,
  getScreenQualityPreset,
  type ScreenQuality,
} from './screen-quality';
import type {
  Envelope,
  PeerInfo,
  ConnectionStats,
  WelcomeData,
  SDPData,
  ICEData,
} from '../types';

export interface MeetConnectionEvents {
  onLocalStream(stream: MediaStream): void;
  onRemoteTrack(peerId: string, track: MediaStreamTrack, stream: MediaStream): void;
  onPeerJoined(peer: PeerInfo): void;
  onPeerLeft(peerId: string): void;
  onConnectionState(state: RTCPeerConnectionState): void;
  onError(err: Error): void;
  onScreenShareStarted?(stream: MediaStream): void;
  onScreenShareStopped?(): void;
  onReconnecting?(attempt: number): void;
  onReconnected?(): void;
}

interface StatsSnapshot {
  ts: number;
  bytesSent: number;
  bytesReceived: number;
  packetsLost: number;
  packetsReceived: number;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = PUBLIC_ICE_SERVERS;

const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_BACKOFFS_MS = [1000, 2000, 4000, 8000, 8000];

export class MeetConnection {
  private readonly signal: SignalClient;
  private readonly events: MeetConnectionEvents;
  private readonly iceServers: RTCIceServer[];

  private publishPC: RTCPeerConnection | null = null;
  private subscribePC: RTCPeerConnection | null = null;

  private _clientId: string | null = null;
  private _isHost = false;

  private readonly unsubscribers: Array<() => void> = [];
  private lastSnapshot: StatsSnapshot | null = null;
  private closed = false;

  // Текущий локальный stream (камера+микрофон). Нужен для:
  // - replaceLocalTracks (sleep/wake recovery)
  // - перезапуска publishPC после reconnect.
  private currentLocalStream: MediaStream | null = null;

  // Скрин-стрим, если активен screen sharing.
  private screenStream: MediaStream | null = null;
  // Sender'ы для screen-треков на publishPC (чтобы removeTrack по ним).
  private readonly screenSenders: Set<RTCRtpSender> = new Set();

  // Reconnect state.
  private reconnecting = false;
  private offSignalClose: (() => void) | null = null;

  constructor(signal: SignalClient, events: MeetConnectionEvents, iceServers?: RTCIceServer[]) {
    this.signal = signal;
    this.events = events;
    this.iceServers = iceServers && iceServers.length > 0 ? iceServers : DEFAULT_ICE_SERVERS;

    this.unsubscribers.push(
      this.signal.on<WelcomeData>('welcome', (env) => this.handleWelcome(env)),
    );
    this.unsubscribers.push(
      this.signal.on<PeerInfo>('peer-joined', (env) => this.handlePeerJoined(env)),
    );
    this.unsubscribers.push(
      this.signal.on<{ id: string }>('peer-left', (env) => this.handlePeerLeft(env)),
    );
    this.unsubscribers.push(
      this.signal.on<SDPData>('publish-answer', (env) => {
        void this.handlePublishAnswer(env);
      }),
    );
    this.unsubscribers.push(
      this.signal.on<SDPData>('subscribe-offer', (env) => {
        void this.handleSubscribeOffer(env);
      }),
    );
    this.unsubscribers.push(
      this.signal.on<ICEData>('ice', (env) => {
        void this.handleIce(env);
      }),
    );

    // Слушаем close сигналинга → запускаем reconnect-процедуру.
    this.offSignalClose = this.signal.onCloseEmitter((ev: CloseEvent) => {
      if (this.closed) return;
      // Уже идёт reconnect — игнорим (это close старого ws после reopen).
      if (this.reconnecting) return;
      try {
        this.events.onError(new Error(`signal disconnected (code=${ev.code})`));
      } catch {
        /* ignore */
      }
      void this.runReconnectLoop();
    });
  }

  get clientId(): string | null {
    return this._clientId;
  }

  get isHost(): boolean {
    return this._isHost;
  }

  async start(localStream: MediaStream): Promise<void> {
    try {
      this.currentLocalStream = localStream;
      this.events.onLocalStream(localStream);

      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      this.publishPC = pc;

      for (const track of localStream.getTracks()) {
        pc.addTransceiver(track, { direction: 'sendonly', streams: [localStream] });
      }

      pc.onicecandidate = (ev: RTCPeerConnectionIceEvent): void => {
        if (!ev.candidate) return;
        try {
          this.signal.send<ICEData>('ice', {
            candidate: ev.candidate.toJSON(),
            role: 'publish',
          });
        } catch (err) {
          this.reportError(err, 'publish ice send');
        }
      };

      pc.onconnectionstatechange = (): void => {
        try {
          this.events.onConnectionState(pc.connectionState);
        } catch (err) {
          this.reportError(err, 'onConnectionState');
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signal.send<SDPData>('publish-offer', { sdp: offer.sdp ?? '' });
    } catch (err) {
      this.reportError(err, 'start');
    }
  }

  /**
   * Заменяет треки локального стрима на новые (того же kind) на существующих
   * sender'ах publishPC. Используется после wake-from-sleep когда камера/микрофон
   * "потерялись".
   */
  async replaceLocalTracks(stream: MediaStream): Promise<void> {
    const pc = this.publishPC;
    if (!pc) {
      // Нет PC — просто запоминаем новый стрим.
      this.currentLocalStream = stream;
      return;
    }

    const senders = pc.getSenders();
    const newTracks = stream.getTracks();

    for (const track of newTracks) {
      // Ищем sender, который раньше слал track такого же kind.
      // Не учитываем screen-sender'ы — они для скрин-шеринга.
      const sender = senders.find((s) => {
        if (this.screenSenders.has(s)) return false;
        return !!s.track && s.track.kind === track.kind;
      });
      if (!sender) {
        // Нет соответствующего sender'а (например, был только аудио, а сейчас+видео) —
        // молча пропускаем; полная renegotiation для MVP не делаем.
        continue;
      }
      try {
        await sender.replaceTrack(track);
      } catch (err) {
        this.reportError(err, `replaceTrack(${track.kind})`);
      }
    }

    this.currentLocalStream = stream;
  }

  // ─── screen sharing ────────────────────────────────────────────────────────

  /**
   * Запускает screen-share с заданным quality preset.
   *
   * @param quality preset (default 'hd'). Влияет на ideal width/height/frameRate
   *   в getDisplayMedia + maxBitrate в setParameters.
   */
  async startScreenShare(
    quality: ScreenQuality = DEFAULT_SCREEN_QUALITY,
  ): Promise<MediaStream> {
    if (this.screenStream) {
      return this.screenStream;
    }
    const pc = this.publishPC;
    if (!pc) {
      throw new Error('startScreenShare: publishPC not ready');
    }

    const preset = getScreenQualityPreset(quality);

    // Mobile browsers (iOS Safari, Android Chrome) не имеют getDisplayMedia.
    // Ловим до вызова чтобы дать понятную ошибку.
    if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
      throw new Error('Демонстрация экрана не поддерживается в этом браузере (мобильные iOS/Android не дают доступ к screen capture).');
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: preset.frameRate },
      },
      audio: false,
    });

    // Защита от mirror-loop: пользователь мог через native browser-picker
    // выбрать саму вкладку ZubraMeet → бесконечная рекурсия видео-в-видео.
    // Чек: displaySurface === 'browser' (вкладка) + label содержит наш hostname.
    // На Firefox/Safari label иногда пуст — тогда полагаемся только на displaySurface.
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
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        }
        throw new Error(
          'Нельзя демонстрировать саму вкладку ZubraMeet — это создаст бесконечную рекурсию. Выберите другую вкладку, окно или весь экран.',
        );
      }
    }

    // Запоминаем до renegotiate, чтобы отслеживать onended даже если SDP-обмен фейлит.
    this.screenStream = stream;

    // contentHint='detail' для screen-tracks: encoder приоритезирует резкость
    // деталей (текст, UI) над плавностью движения. Для камер уже выставлен
    // 'motion' upstream'ом (Meeting.tsx → start) — здесь не трогаем не свои треки.
    for (const track of stream.getVideoTracks()) {
      try {
        track.contentHint = 'detail';
      } catch {
        /* ignore */
      }
    }

    const screenSenders: RTCRtpSender[] = [];
    for (const track of stream.getTracks()) {
      const transceiver = pc.addTransceiver(track, {
        direction: 'sendonly',
        streams: [stream],
      });
      this.screenSenders.add(transceiver.sender);
      if (track.kind === 'video') {
        screenSenders.push(transceiver.sender);
      }
      // Если пользователь нажал "Stop sharing" в браузерном UI — стопим сами.
      track.onended = () => {
        // Чтобы не перевызвать stop рекурсивно, защищаемся проверкой.
        if (this.screenStream === stream) {
          void this.stopScreenShare();
        }
      };
    }

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signal.send<SDPData>('publish-offer', { sdp: offer.sdp ?? '' });
    } catch (err) {
      this.reportError(err, 'startScreenShare renegotiate');
    }

    // После renegotiate выставляем encoding-параметры для screen-sender'ов:
    //  - maxBitrate из preset (cap чтобы не уйти в overshoot на быстром канале)
    //  - degradationPreference 'maintain-resolution' — при просадке канала
    //    роняем fps, но НЕ разрешение. Текст должен оставаться читабельным.
    //  - networkPriority 'high'
    for (const sender of screenSenders) {
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        for (const e of params.encodings) {
          e.maxBitrate = preset.maxBitrate;
          e.networkPriority = 'high';
        }
        params.degradationPreference = 'maintain-resolution';
        await sender.setParameters(params);
      } catch (err) {
        this.reportError(err, 'startScreenShare setParameters');
      }
    }

    try {
      this.events.onScreenShareStarted?.(stream);
    } catch (err) {
      this.reportError(err, 'onScreenShareStarted');
    }

    return stream;
  }

  async stopScreenShare(): Promise<void> {
    const stream = this.screenStream;
    const pc = this.publishPC;
    if (!stream) return;

    // Снимаем senders, останавливаем треки.
    if (pc) {
      for (const sender of this.screenSenders) {
        try {
          pc.removeTrack(sender);
        } catch (err) {
          this.reportError(err, 'stopScreenShare removeTrack');
        }
      }
    }
    this.screenSenders.clear();

    for (const track of stream.getTracks()) {
      try {
        track.onended = null;
        track.stop();
      } catch {
        /* ignore */
      }
    }
    this.screenStream = null;

    if (pc) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.signal.send<SDPData>('publish-offer', { sdp: offer.sdp ?? '' });
      } catch (err) {
        this.reportError(err, 'stopScreenShare renegotiate');
      }
    }

    try {
      this.events.onScreenShareStopped?.();
    } catch (err) {
      this.reportError(err, 'onScreenShareStopped');
    }
  }

  async getStats(): Promise<ConnectionStats> {
    const empty: ConnectionStats = {
      outboundBitrateKbps: 0,
      inboundBitrateKbps: 0,
      rttMs: 0,
      packetLossPct: 0,
    };

    try {
      let bytesSent = 0;
      let bytesReceived = 0;
      let packetsLost = 0;
      let packetsReceived = 0;
      let rttMs = 0;

      const reportsList: RTCStatsReport[] = [];
      if (this.publishPC) {
        reportsList.push(await this.publishPC.getStats());
      }
      if (this.subscribePC) {
        reportsList.push(await this.subscribePC.getStats());
      }
      if (reportsList.length === 0) return empty;

      for (const reports of reportsList) {
        reports.forEach((value) => {
          const report = value as Record<string, unknown>;
          const type = report['type'];
          if (type === 'outbound-rtp') {
            const v = report['bytesSent'];
            if (typeof v === 'number') bytesSent += v;
          } else if (type === 'inbound-rtp') {
            const vb = report['bytesReceived'];
            if (typeof vb === 'number') bytesReceived += vb;
            const vl = report['packetsLost'];
            if (typeof vl === 'number') packetsLost += vl;
            const vr = report['packetsReceived'];
            if (typeof vr === 'number') packetsReceived += vr;
          } else if (type === 'candidate-pair') {
            const nominated = report['nominated'];
            const selected = report['selected'];
            const state = report['state'];
            const isSelected =
              selected === true || nominated === true || state === 'succeeded';
            if (isSelected) {
              const rtt = report['currentRoundTripTime'];
              if (typeof rtt === 'number' && rtt > 0 && rttMs === 0) {
                rttMs = rtt * 1000;
              }
            }
          }
        });
      }

      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const prev = this.lastSnapshot;

      let outboundBitrateKbps = 0;
      let inboundBitrateKbps = 0;
      if (prev) {
        const dtSec = (now - prev.ts) / 1000;
        if (dtSec > 0) {
          const dOut = Math.max(0, bytesSent - prev.bytesSent);
          const dIn = Math.max(0, bytesReceived - prev.bytesReceived);
          outboundBitrateKbps = (dOut * 8) / 1000 / dtSec;
          inboundBitrateKbps = (dIn * 8) / 1000 / dtSec;
        }
      }

      let packetLossPct = 0;
      if (prev) {
        const dLost = Math.max(0, packetsLost - prev.packetsLost);
        const dRecv = Math.max(0, packetsReceived - prev.packetsReceived);
        const total = dLost + dRecv;
        if (total > 0) {
          packetLossPct = (dLost / total) * 100;
        }
      }

      this.lastSnapshot = {
        ts: now,
        bytesSent,
        bytesReceived,
        packetsLost,
        packetsReceived,
      };

      return {
        outboundBitrateKbps: Math.round(outboundBitrateKbps * 10) / 10,
        inboundBitrateKbps: Math.round(inboundBitrateKbps * 10) / 10,
        rttMs: Math.round(rttMs * 10) / 10,
        packetLossPct: Math.round(packetLossPct * 10) / 10,
      };
    } catch (err) {
      this.reportError(err, 'getStats');
      return empty;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.offSignalClose) {
      try {
        this.offSignalClose();
      } catch {
        /* ignore */
      }
      this.offSignalClose = null;
    }

    for (const off of this.unsubscribers) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    this.unsubscribers.length = 0;

    if (this.publishPC) {
      try {
        this.publishPC.close();
      } catch {
        /* ignore */
      }
      this.publishPC = null;
    }
    if (this.subscribePC) {
      try {
        this.subscribePC.close();
      } catch {
        /* ignore */
      }
      this.subscribePC = null;
    }

    // Стопим только screen-стрим (мы его создали). localStream — caller's.
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
    this.screenSenders.clear();
    // NOTE: do not stop localStream tracks — caller owns the stream.
  }

  // ─── reconnect ─────────────────────────────────────────────────────────────

  private async runReconnectLoop(): Promise<void> {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;

    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt++) {
      if (this.closed) {
        this.reconnecting = false;
        return;
      }
      try {
        this.events.onReconnecting?.(attempt);
      } catch {
        /* ignore */
      }
      const delay = RECONNECT_BACKOFFS_MS[attempt - 1] ?? 8000;
      await sleep(delay);
      if (this.closed) {
        this.reconnecting = false;
        return;
      }
      try {
        await this.signal.reconnect();
        // Signal снова открыт. Пересоздаём PC и заново шлём publish-offer.
        this.rebuildPeerConnections();
        const stream = this.currentLocalStream;
        if (stream) {
          // Не трогаем currentLocalStream — start выставит его сам.
          await this.start(stream);
        }
        this.reconnecting = false;
        try {
          this.events.onReconnected?.();
        } catch {
          /* ignore */
        }
        return;
      } catch (err) {
        lastErr = err;
        // Continue.
      }
    }

    this.reconnecting = false;
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown');
    this.reportError(new Error(`reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts: ${msg}`), 'reconnect');
  }

  private rebuildPeerConnections(): void {
    if (this.publishPC) {
      try {
        this.publishPC.close();
      } catch {
        /* ignore */
      }
      this.publishPC = null;
    }
    if (this.subscribePC) {
      try {
        this.subscribePC.close();
      } catch {
        /* ignore */
      }
      this.subscribePC = null;
    }
    // Скрин-сендеры были привязаны к старому PC — они невалидны.
    this.screenSenders.clear();
    // Скрин-стрим тоже сбрасываем — после reconnect screen sharing нужно начинать заново.
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
      try {
        this.events.onScreenShareStopped?.();
      } catch {
        /* ignore */
      }
    }
    // clientId сбросим — сервер выдаст новый при welcome.
    this._clientId = null;
    this._isHost = false;
    this.lastSnapshot = null;
  }

  // ─── handlers ──────────────────────────────────────────────────────────────

  private handleWelcome(env: Envelope<WelcomeData>): void {
    try {
      const data = env.data;
      if (!data) return;
      this._clientId = data.clientId;
      this._isHost = !!data.isHost;
      const peers = Array.isArray(data.peers) ? data.peers : [];
      for (const p of peers) {
        try {
          this.events.onPeerJoined(p);
        } catch (err) {
          this.reportError(err, 'onPeerJoined(welcome)');
        }
      }
    } catch (err) {
      this.reportError(err, 'welcome');
    }
  }

  private handlePeerJoined(env: Envelope<PeerInfo>): void {
    try {
      const data = env.data;
      if (!data || typeof data.id !== 'string') return;
      this.events.onPeerJoined(data);
    } catch (err) {
      this.reportError(err, 'peer-joined');
    }
  }

  private handlePeerLeft(env: Envelope<{ id: string }>): void {
    try {
      const data = env.data;
      if (!data || typeof data.id !== 'string') return;
      this.events.onPeerLeft(data.id);
    } catch (err) {
      this.reportError(err, 'peer-left');
    }
  }

  private async handlePublishAnswer(env: Envelope<SDPData>): Promise<void> {
    try {
      const data = env.data;
      if (!data || typeof data.sdp !== 'string') return;
      const pc = this.publishPC;
      if (!pc) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    } catch (err) {
      this.reportError(err, 'publish-answer');
    }
  }

  private async handleSubscribeOffer(env: Envelope<SDPData>): Promise<void> {
    try {
      const data = env.data;
      if (!data || typeof data.sdp !== 'string') return;

      let pc = this.subscribePC;
      if (!pc) {
        pc = new RTCPeerConnection({ iceServers: this.iceServers });
        this.subscribePC = pc;

        pc.ontrack = (ev: RTCTrackEvent): void => {
          try {
            const stream = ev.streams[0];
            if (!stream) return;
            // TODO: mid→peerId mapping when SFU sends transceiver metadata.
            const peerId = stream.id;
            this.events.onRemoteTrack(peerId, ev.track, stream);
          } catch (err) {
            this.reportError(err, 'ontrack');
          }
        };

        pc.onicecandidate = (ev: RTCPeerConnectionIceEvent): void => {
          if (!ev.candidate) return;
          try {
            this.signal.send<ICEData>('ice', {
              candidate: ev.candidate.toJSON(),
              role: 'subscribe',
            });
          } catch (err) {
            this.reportError(err, 'subscribe ice send');
          }
        };
      }

      await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signal.send<SDPData>('subscribe-answer', { sdp: answer.sdp ?? '' });
    } catch (err) {
      this.reportError(err, 'subscribe-offer');
    }
  }

  private async handleIce(env: Envelope<ICEData>): Promise<void> {
    try {
      const data = env.data;
      if (!data || !data.candidate) return;
      if (data.role === 'publish') {
        const pc = this.publishPC;
        if (!pc) return;
        await pc.addIceCandidate(data.candidate);
      } else if (data.role === 'subscribe') {
        const pc = this.subscribePC;
        if (!pc) return;
        await pc.addIceCandidate(data.candidate);
      }
    } catch (err) {
      this.reportError(err, 'ice');
    }
  }

  private reportError(err: unknown, ctx: string): void {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      this.events.onError(new Error(`webrtc[${ctx}]: ${msg}`));
    } catch {
      /* swallow */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
