// Package signal — WebSocket-сигналинг между клиентами и SFU.
//
// Контракт (заполняется агентом):
//
//   - NewHub(rooms *room.Registry, sfu sfu.SFU) *Hub
//   - (*Hub) Handle(w http.ResponseWriter, r *http.Request) — апгрейд WS, парсинг ?room= & ?name=
//   - (*Hub) Broadcast(roomID string, except room.ClientID, msg Envelope) — отправить всем кроме указанного
//   - (*Hub) SendTo(clientID room.ClientID, msg Envelope) error
//
// Envelope формат — см. PROTOCOL.md в корне репо.
//
// Поведение:
//  1. На WS-апгрейде — Welcome с clientID, isHost (первый = host), peers.
//  2. Сразу делегирует в sfu.OnPeerJoin(roomID, clientID, send func(Envelope) error).
//  3. На каждом входящем сообщении вызывает sfu.OnSignal(clientID, envelope).
//  4. На дисконнекте — sfu.OnPeerLeave(roomID, clientID), broadcast peer-left.
//  5. Если room пустеет — rooms.Delete(roomID).
package signal

import (
	"encoding/json"

	"github.com/AntonZubritski/ZubraMeet/internal/room"
)

// SFU — интерфейс для избежания import cycle между signal и sfu.
// Реализация живёт в пакете sfu; signal-хаб дёргает её на жизненные события WS-клиента.
type SFU interface {
	OnPeerJoin(roomID string, clientID room.ClientID, send func(Envelope) error)
	OnPeerLeave(roomID string, clientID room.ClientID)
	OnSignal(clientID room.ClientID, env Envelope) error
}

type MsgType string

const (
	MsgWelcome         MsgType = "welcome"
	MsgPeerJoined      MsgType = "peer-joined"
	MsgPeerLeft        MsgType = "peer-left"
	MsgPublishOffer    MsgType = "publish-offer"
	MsgPublishAnswer   MsgType = "publish-answer"
	MsgSubscribeOffer  MsgType = "subscribe-offer"
	MsgSubscribeAnswer MsgType = "subscribe-answer"
	MsgICE             MsgType = "ice"
	MsgLeave           MsgType = "leave"
	MsgError           MsgType = "error"
)

type Envelope struct {
	Type MsgType         `json:"type"`
	From string          `json:"from,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`
}
