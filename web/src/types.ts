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

export type EndpointKind = 'local' | 'lan' | 'internet';

export interface Endpoint {
  kind: EndpointKind;
  host: string;
  port: number;
  scheme: 'http' | 'https';
  url: string;
  family?: 'ipv4' | 'ipv6';
}

export type ReachabilityStatus = 'ok' | 'lan-only' | 'behind-cgnat';

export type ReachabilityReason =
  | 'cgnat-detected'
  | 'no-ipv6'
  | 'no-upnp'
  | 'upnp-private-ip';

export interface Diagnosis {
  status: ReachabilityStatus;
  publicIPv4: string; // "" если нет
  publicIPv6: string; // "" если нет
  upnpWorked: boolean;
  behindCGNAT: boolean;
  reasons: ReachabilityReason[];
}

export interface ConnectivityResp {
  endpoints: Endpoint[];
  diagnosis: Diagnosis;
}
