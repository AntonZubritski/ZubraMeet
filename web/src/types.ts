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

// Mode — рекомендованный режим работы клиента (определяет /api/mode по
// результату server-side диагностики).
export type ServerMode = 'sfu' | 'p2p';

export interface ModeResp {
  mode: ServerMode;
  reason: string;
  diagnosis: Diagnosis;
}

// CloudProviderRegion — один регион cloud-провайдера.
export interface CloudProviderRegion {
  code: string;
  name: string;
}

// CloudProviderInfo — описание одного cloud-провайдера для UI Settings.
export interface CloudProviderInfo {
  id: string;
  name: string;
  regions: CloudProviderRegion[];
  tokenUrl: string;
  estimateNote: string;
}

// CloudConfigResp — ответ GET /api/cloudconfig.
// hasToken=true — токен сохранён; саму строку сервер не возвращает.
export interface CloudConfigResp {
  provider: string;
  region: string;
  hasToken: boolean;
  enabled: boolean;
  providers: CloudProviderInfo[];
}

// CloudConfigSavePayload — body для POST /api/cloudconfig. Если apiToken
// пустая строка — сервер сохранит существующий токен (см. handlers.go).
export interface CloudConfigSavePayload {
  provider: string;
  apiToken: string;
  region: string;
  enabled: boolean;
}

// RelayInfo — публичные поля активного relay-сервера.
export interface RelayInfo {
  id: string;
  provider: string;
  region: string;
  publicIP: string;
  turnPort: number;
  turnUrl: string;
  turnUser: string;
  turnPass: string;
  createdAt: string; // ISO-8601
  destroyTTL: string; // ISO-8601
  costNote: string;
}

// RelayStatusResp — ответ GET /api/relay/status. Если active=false — других
// полей может не быть.
export type RelayStatusResp =
  | ({ active: true } & RelayInfo)
  | { active: false };
