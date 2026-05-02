# ZubraMeet

P2P-видеоконференции, где **создатель мита становится локальным SFU-сервером**. Один Go-бинарник: Pion SFU + WebSocket-сигналинг + embedded React-app. uTorrent-модель.

## P2P-режим (для хостов за CGNAT)

Веб-клиент задеплоен на GitHub Pages: https://antonzubritski.github.io/ZubraMeet/

Когда хост за CGNAT, ZubraMeet автоматически переключается в P2P-mesh-режим
с decentralized signaling через Nostr-relay'и (через библиотеку trystero).
Видео идёт прямо peer-to-peer, никакого сервера не требуется.

Гость открывает https://antonzubritski.github.io/ZubraMeet/p2p/<roomId> →
браузер находит хоста через Nostr → WebRTC mesh.

## Стек

- **Backend**: Go 1.26 + [Pion WebRTC](https://github.com/pion/webrtc) + [coder/websocket](https://github.com/coder/websocket)
- **Frontend**: React 18 + TypeScript + Vite, нативные WebRTC API
- **Deploy**: один бинарник с embedded SPA (Go `embed`)
- **NAT**: STUN, опционально TURN (Coturn)
- **(roadmap)** Wails — нативное окно вокруг WebView

## Структура

```
ZubraMeet/
├── main.go                — entry point
├── embed.go               — //go:embed all:web/dist
├── go.mod
├── PROTOCOL.md            — WS-сигналинг (источник правды)
├── internal/
│   ├── room/              — реестр комнат + клиенты
│   ├── signal/            — WS-хаб, диспетчинг сообщений
│   ├── sfu/               — Pion SFU (publish/subscribe PC, форвардинг треков)
│   └── server/            — HTTP-сервер, роутинг, embed-FS
└── web/                   — Vite + React + TS
    ├── package.json
    ├── vite.config.ts
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── types.ts        — зеркало signal/Envelope
        ├── lib/            — webrtc.ts, signal.ts, stats.ts
        ├── pages/          — Landing, Meeting
        └── components/     — VideoTile, VideoGrid, Controls
```

## Dev (два терминала)

```bash
# 1) фронт с HMR на :5173
cd web && npm install && npm run dev

# 2) бэк на :7777
go run .
```

Открывай `http://localhost:5173`. Vite проксирует `/api` и `/ws` в Go.

## Production build

```bash
make build       # web bundle → embed → zubrameet.exe
./zubrameet.exe  # слушает :7777
```

## Документация

- [`PROTOCOL.md`](PROTOCOL.md) — WS-сигналинг
- [`projects-history/ZubraMeet/`](https://github.com/AntonZubritski/ZubraMeet) — контекст для Claude (вне репо)
