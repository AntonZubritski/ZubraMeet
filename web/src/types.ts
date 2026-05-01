// Зеркало signal/Envelope — см. PROTOCOL.md в корне репо.

export type MsgType =
  | 'welcome'
  | 'peer-joined'
  | 'peer-left'
  | 'publish-offer'
  | 'publish-answer'
  | 'subscribe-offer'
  | 'subscribe-answer'
  | 'ice'
  | 'leave'
  | 'error';

export interface Envelope<T = unknown> {
  type: MsgType;
  from?: string;
  data?: T;
}

export interface PeerInfo {
  id: string;
  name: string;
}

export interface WelcomeData {
  clientId: string;
  isHost: boolean;
  peers: PeerInfo[];
}

export interface SDPData {
  sdp: string;
}

export type ICERole = 'publish' | 'subscribe';

export interface ICEData {
  candidate: RTCIceCandidateInit;
  role: ICERole;
}

export interface ErrorData {
  message: string;
}

export interface RoomCreateResp {
  id: string;
  inviteUrl: string;
}

export interface ConnectionStats {
  outboundBitrateKbps: number;
  inboundBitrateKbps: number;
  rttMs: number;
  packetLossPct: number;
}
