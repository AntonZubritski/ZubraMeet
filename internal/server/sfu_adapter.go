package server

import (
	"github.com/AntonZubritski/ZubraMeet/internal/room"
	"github.com/AntonZubritski/ZubraMeet/internal/sfu"
	"github.com/AntonZubritski/ZubraMeet/internal/signal"
)

// sfuAdapter — мост между signal.SFU интерфейсом и реальным *sfu.SFU.
//
// Зачем: signal.SFU.OnPeerJoin принимает send func(signal.Envelope) error,
// а sfu.SFU.OnPeerJoin принимает sfu.SendFn (named type с тем же underlying
// signature). Go-интерфейсы требуют точного совпадения типа методов, named и
// unnamed type считаются разными. Адаптер просто перекладывает значение.
type sfuAdapter struct {
	sfu *sfu.SFU
}

func (a *sfuAdapter) OnPeerJoin(roomID string, clientID room.ClientID, send func(signal.Envelope) error) {
	a.sfu.OnPeerJoin(roomID, clientID, sfu.SendFn(send))
}

func (a *sfuAdapter) OnPeerLeave(roomID string, clientID room.ClientID) {
	a.sfu.OnPeerLeave(roomID, clientID)
}

func (a *sfuAdapter) OnSignal(clientID room.ClientID, env signal.Envelope) error {
	return a.sfu.OnSignal(clientID, env)
}
