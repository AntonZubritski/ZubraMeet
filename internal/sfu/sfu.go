// Package sfu — Pion-based Selective Forwarding Unit.
//
// Контракт:
//
//   - New(cfg Config) (*SFU, error)
//
//   - (*SFU) OnPeerJoin(roomID string, clientID room.ClientID, send SendFn)
//     регистрирует клиента; PC создаются лениво на первом publish-offer.
//
//   - (*SFU) OnPeerLeave(roomID string, clientID room.ClientID)
//     закрывает PC, снимает форварденные треки у соседей и renegotiate.
//
//   - (*SFU) OnSignal(clientID room.ClientID, env signal.Envelope) error
//     обрабатывает publish-offer / subscribe-answer / ice.
//
//   - (*SFU) Close() error
//     закрывает все PC.
//
// Стратегия:
//  1. Publishing PC — recvonly со стороны сервера.
//  2. Subscribing PC — sendonly со стороны сервера; renegotiate на каждое
//     добавление/удаление чужого трека.
//  3. Track-форвардинг через TrackLocalStaticRTP — копирование RTP 1:1.
//  4. ICE-кандидаты ходят с role: "publish"|"subscribe".
package sfu

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"

	"github.com/AntonZubritski/ZubraMeet/internal/room"
	"github.com/AntonZubritski/ZubraMeet/internal/signal"
	"github.com/pion/webrtc/v4"
)

// SendFn отправляет конверт обратно конкретному клиенту через сигналинг.
type SendFn func(signal.Envelope) error

// Config — параметры инициализации SFU.
type Config struct {
	// ICEServers — STUN/TURN, прокидываются в PeerConnection.
	ICEServers []ICEServer
	// Rooms — реестр комнат, нужен для лукапа сородичей при форвардинге.
	Rooms *room.Registry
}

// ICEServer — один ICE-сервер.
type ICEServer struct {
	URLs       []string
	Username   string
	Credential string
}

// Roles для ICE-кандидатов.
const (
	roleSubscribe = "subscribe"
	rolePublish   = "publish"
)

// sdpData — payload для publish-offer / publish-answer / subscribe-offer / subscribe-answer.
type sdpData struct {
	SDP string `json:"sdp"`
}

// iceData — payload для type=ice.
type iceData struct {
	Candidate webrtc.ICECandidateInit `json:"candidate"`
	Role      string                  `json:"role"`
}

// SFU — главный объект. Держит peerState на каждого клиента.
type SFU struct {
	cfg Config
	api *webrtc.API

	mu    sync.RWMutex
	peers map[room.ClientID]*peerState
}

// New создаёт новый SFU. Все клиенты будут шарить общий MediaEngine + API.
func New(cfg Config) (*SFU, error) {
	if cfg.Rooms == nil {
		return nil, errors.New("sfu: Config.Rooms is required")
	}

	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterDefaultCodecs(); err != nil {
		return nil, fmt.Errorf("sfu: register default codecs: %w", err)
	}

	api := webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine))

	return &SFU{
		cfg:   cfg,
		api:   api,
		peers: make(map[room.ClientID]*peerState),
	}, nil
}

// OnPeerJoin регистрирует клиента. PC создаются лениво на первом publish-offer
// (и subscribePC при первой renegotiate из-за добавления чужого трека).
func (s *SFU) OnPeerJoin(roomID string, clientID room.ClientID, send SendFn) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.peers[clientID]; exists {
		return
	}

	s.peers[clientID] = &peerState{
		clientID:  clientID,
		roomID:    roomID,
		send:      send,
		published: make(map[string]*publishedTrack),
		forwarded: make(map[room.ClientID]map[string]*webrtc.RTPSender),
	}
	log.Printf("[sfu] peer-join room=%s client=%s", roomID, clientID)
}

// OnPeerLeave закрывает все PC клиента и снимает его треки у соседей.
func (s *SFU) OnPeerLeave(roomID string, clientID room.ClientID) {
	s.mu.Lock()
	ps, ok := s.peers[clientID]
	if !ok {
		s.mu.Unlock()
		return
	}
	delete(s.peers, clientID)
	log.Printf("[sfu] peer-leave room=%s client=%s", roomID, clientID)

	// Соберём snapshot соседей (всё ещё в комнате) и закрываемые трек-IDs.
	leavingTrackIDs := make([]string, 0, len(ps.published))
	for id := range ps.published {
		leavingTrackIDs = append(leavingTrackIDs, id)
	}

	// Список соседей в этой room из реестра, фильтруем по тем что есть в SFU.
	var neighbors []*peerState
	if r, exists := s.cfg.Rooms.Get(roomID); exists {
		for _, c := range r.Peers() {
			if c.ID == clientID {
				continue
			}
			if np, ok := s.peers[c.ID]; ok {
				neighbors = append(neighbors, np)
			}
		}
	}
	s.mu.Unlock()

	// Закрываем PC уходящего клиента.
	ps.close()

	// На каждом соседе: снимаем форварденные треки уходящего клиента
	// и renegotiate, если что-то реально снялось.
	for _, np := range neighbors {
		removed := np.removeForwardedFrom(clientID, leavingTrackIDs)
		if removed > 0 {
			if err := np.renegotiateSubscribe(); err != nil {
				// Логировать-то можно, но это MVP; молча проглатываем.
				_ = err
			}
		}
	}
}

// OnSignal — диспатчер входящих сигналинг-сообщений от клиента.
func (s *SFU) OnSignal(clientID room.ClientID, env signal.Envelope) error {
	s.mu.RLock()
	ps, ok := s.peers[clientID]
	s.mu.RUnlock()
	if !ok {
		return fmt.Errorf("sfu: unknown client %q", clientID)
	}

	switch env.Type {
	case signal.MsgPublishOffer:
		var d sdpData
		if err := json.Unmarshal(env.Data, &d); err != nil {
			return fmt.Errorf("sfu: parse publish-offer: %w", err)
		}
		return s.handlePublishOffer(ps, d.SDP)

	case signal.MsgSubscribeAnswer:
		var d sdpData
		if err := json.Unmarshal(env.Data, &d); err != nil {
			return fmt.Errorf("sfu: parse subscribe-answer: %w", err)
		}
		return ps.handleSubscribeAnswer(d.SDP)

	case signal.MsgICE:
		var d iceData
		if err := json.Unmarshal(env.Data, &d); err != nil {
			return fmt.Errorf("sfu: parse ice: %w", err)
		}
		return ps.handleICE(d.Role, d.Candidate)

	case signal.MsgLeave:
		// Явный leave обычно обрабатывает сигналинг (через OnPeerLeave),
		// но если пришло сюда — игнорируем как no-op.
		return nil
	}

	return fmt.Errorf("sfu: unsupported message type %q", env.Type)
}

// Close закрывает все PC. Вызывать на shutdown сервера.
func (s *SFU) Close() error {
	s.mu.Lock()
	peers := make([]*peerState, 0, len(s.peers))
	for _, ps := range s.peers {
		peers = append(peers, ps)
	}
	s.peers = make(map[room.ClientID]*peerState)
	s.mu.Unlock()

	for _, ps := range peers {
		ps.close()
	}
	return nil
}

// rtcConfiguration собирает webrtc.Configuration из cfg.ICEServers.
func (s *SFU) rtcConfiguration() webrtc.Configuration {
	servers := make([]webrtc.ICEServer, 0, len(s.cfg.ICEServers))
	for _, ice := range s.cfg.ICEServers {
		servers = append(servers, webrtc.ICEServer{
			URLs:       ice.URLs,
			Username:   ice.Username,
			Credential: ice.Credential,
		})
	}
	return webrtc.Configuration{ICEServers: servers}
}
