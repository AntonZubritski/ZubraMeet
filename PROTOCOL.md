# ZubraMeet — сигналинг-протокол

WebSocket: `ws://<host>:7777/ws?room=<roomID>&name=<displayName>`

Топология: SFU. Каждый клиент держит ОДНО `RTCPeerConnection` к серверу. Сервер форвардит чужие треки.

## Конверт

```json
{ "type": "<MsgType>", "from": "<clientID>", "data": { ... } }
```

`from` устанавливает сервер при ретрансляции. Клиент его не отправляет.

## Сообщения

### client → server

| type | data | назначение |
|---|---|---|
| `publish-offer` | `{ "sdp": "<SDP>" }` | клиент предлагает publishing-PC, шлёт свои треки серверу |
| `subscribe-answer` | `{ "sdp": "<SDP>" }` | ответ на subscribe-offer от сервера |
| `ice` | `{ "candidate": <RTCIceCandidateInit>, "role": "publish"\|"subscribe" }` | ICE-кандидаты |
| `leave` | `null` | явный выход |

### server → client

| type | data | назначение |
|---|---|---|
| `welcome` | `{ "clientId": "<id>", "isHost": bool, "peers": [{"id":"...","name":"..."}] }` | сразу после WS-апгрейда |
| `publish-answer` | `{ "sdp": "<SDP>" }` | ответ сервера на publish-offer |
| `subscribe-offer` | `{ "sdp": "<SDP>" }` | сервер инициирует subscribe-PC у клиента (когда есть треки от других) |
| `peer-joined` | `{ "id": "<id>", "name": "<name>" }` | новый участник |
| `peer-left` | `{ "id": "<id>" }` | участник ушёл |
| `ice` | `{ "candidate": <RTCIceCandidateInit>, "role": "publish"\|"subscribe" }` | ICE от сервера |
| `error` | `{ "message": "<text>" }` | ошибка |

## HTTP-endpoint'ы

| path | назначение |
|---|---|
| `GET /` | embedded React-app (SPA fallback на index.html) |
| `GET /api/health` | `{ "ok": true, "version": "<v>" }` |
| `GET /api/rooms/:id` | `{ "id": "...", "hostId": "...", "peers": [...] }` (404 если нет) |
| `POST /api/rooms` | создать комнату; body `{ "displayName": "<host>" }`; возвращает `{ "id": "<roomID>", "inviteUrl": "<url>" }` |
| `GET /ws` | upgrade в WebSocket (см. выше) |

## Roles внутри SFU

- **Publishing PC** (один на клиента): клиент шлёт треки серверу. Recvonly со стороны сервера.
- **Subscribing PC** (один на клиента): сервер шлёт треки чужих клиентов этому клиенту. Sendonly со стороны сервера.

Две PC, чтобы независимо renegotiate'ить добавление/удаление треков других участников.

## Идентификаторы

- `clientID` — UUID v4, выдаёт сервер при welcome
- `roomID` — короткий 8-символьный crockford base32 (без I, L, O, U)

## Ошибки

`{ "type": "error", "data": { "message": "<text>" } }` и закрытие WS с кодом 1011.
