import { SignalClient } from './signal';
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
}

interface StatsSnapshot {
  ts: number;
  bytesSent: number;
  bytesReceived: number;
  packetsLost: number;
  packetsReceived: number;
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

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
  }

  get clientId(): string | null {
    return this._clientId;
  }

  get isHost(): boolean {
    return this._isHost;
  }

  async start(localStream: MediaStream): Promise<void> {
    try {
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
    // NOTE: do not stop localStream tracks — caller owns the stream.
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
