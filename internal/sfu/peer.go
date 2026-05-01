package sfu

import (
	"encoding/json"
	"fmt"
	"log"
	"sync"

	"github.com/AntonZubritski/ZubraMeet/internal/room"
	"github.com/AntonZubritski/ZubraMeet/internal/signal"
	"github.com/pion/webrtc/v4"
)

// publishedTrack — один локальный трек, в который сервер копирует RTP с
// publishPC клиента. Этот же localTrack потом раздаётся всем соседям через AddTrack.
type publishedTrack struct {
	id    string // = remoteTrack.ID()
	kind  webrtc.RTPCodecType
	local *webrtc.TrackLocalStaticRTP
	// done закрывается когда форвард-горутина останавливается (трек удалён или PC закрыт).
	done chan struct{}
}

// peerState — состояние одного клиента.
type peerState struct {
	clientID room.ClientID
	roomID   string
	send     SendFn

	mu          sync.Mutex
	publishPC   *webrtc.PeerConnection
	subscribePC *webrtc.PeerConnection

	// published — мои собственные треки, по track.ID().
	published map[string]*publishedTrack

	// forwarded — треки соседей, которые я отправляю своему subscribePC.
	// forwarded[ownerClientID][trackID] = RTPSender (нужен для RemoveTrack).
	forwarded map[room.ClientID]map[string]*webrtc.RTPSender

	closed bool
}

// handlePublishOffer обрабатывает publish-offer от клиента.
//
//  1. Создаёт publishPC если ещё нет.
//  2. setRemoteDescription(offer), createAnswer, setLocalDescription.
//  3. Отправляет publish-answer.
//  4. На OnTrack — создаёт TrackLocalStaticRTP, пушит соседям и запускает форвард-горутину.
func (s *SFU) handlePublishOffer(ps *peerState, sdp string) error {
	ps.mu.Lock()
	if ps.closed {
		ps.mu.Unlock()
		return fmt.Errorf("sfu: peer %q is closed", ps.clientID)
	}

	if ps.publishPC == nil {
		pc, err := s.api.NewPeerConnection(s.rtcConfiguration())
		if err != nil {
			ps.mu.Unlock()
			return fmt.Errorf("sfu: new publish PC: %w", err)
		}

		// Recvonly со стороны сервера: video + audio.
		if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionRecvonly,
		}); err != nil {
			_ = pc.Close()
			ps.mu.Unlock()
			return fmt.Errorf("sfu: add video transceiver: %w", err)
		}
		if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio, webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionRecvonly,
		}); err != nil {
			_ = pc.Close()
			ps.mu.Unlock()
			return fmt.Errorf("sfu: add audio transceiver: %w", err)
		}

		// ICE — ремобиле клиенту с role=publish.
		pc.OnICECandidate(func(c *webrtc.ICECandidate) {
			if c == nil {
				return
			}
			ps.sendICE(c, rolePublish)
		})

		// OnTrack — стартуем форвардинг.
		pc.OnTrack(func(remoteTrack *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
			s.handleRemoteTrack(ps, remoteTrack)
		})

		ps.publishPC = pc
	}

	pc := ps.publishPC
	ps.mu.Unlock()

	// SetRemoteDescription / CreateAnswer / SetLocalDescription. Pion safe to call concurrently
	// с OnICECandidate / OnTrack, но нам не нужно держать ps.mu здесь.
	offer := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}
	if err := pc.SetRemoteDescription(offer); err != nil {
		return fmt.Errorf("sfu: set remote (publish-offer): %w", err)
	}

	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return fmt.Errorf("sfu: create publish-answer: %w", err)
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		return fmt.Errorf("sfu: set local (publish-answer): %w", err)
	}

	payload, err := json.Marshal(sdpData{SDP: answer.SDP})
	if err != nil {
		return fmt.Errorf("sfu: marshal publish-answer: %w", err)
	}
	if err := ps.send(signal.Envelope{
		Type: signal.MsgPublishAnswer,
		Data: payload,
	}); err != nil {
		return err
	}

	// Снимок числа треков под локом — на момент publish-answer часть треков
	// уже могла прилететь через OnTrack (асинхронный callback Pion'а).
	ps.mu.Lock()
	numTracks := len(ps.published)
	ps.mu.Unlock()
	log.Printf("[sfu] publish-pc-ready client=%s tracks=%d", ps.clientID, numTracks)
	return nil
}

// handleRemoteTrack — вызывается из publishPC.OnTrack каждый раз когда от
// клиента приходит новый трек. Создаёт TrackLocalStaticRTP, регистрирует у
// соседей через AddTrack + renegotiate, и запускает копирующую горутину.
func (s *SFU) handleRemoteTrack(ps *peerState, remoteTrack *webrtc.TrackRemote) {
	local, err := webrtc.NewTrackLocalStaticRTP(
		remoteTrack.Codec().RTPCodecCapability,
		remoteTrack.ID(),
		remoteTrack.StreamID(),
	)
	if err != nil {
		return
	}

	pt := &publishedTrack{
		id:    remoteTrack.ID(),
		kind:  remoteTrack.Kind(),
		local: local,
		done:  make(chan struct{}),
	}

	ps.mu.Lock()
	if ps.closed {
		ps.mu.Unlock()
		close(pt.done)
		return
	}
	ps.published[pt.id] = pt
	ps.mu.Unlock()

	log.Printf("[sfu] track-published client=%s kind=%s id=%s ssrc=%d",
		ps.clientID, remoteTrack.Kind(), remoteTrack.ID(), remoteTrack.SSRC())

	// Запускаем форвардинг RTP-пакетов: remote → local.
	go forwardRTP(remoteTrack, local, pt.done)

	// Распространяем local трек по соседям. Берём snapshot peers у room
	// и для каждого соседа в SFU — AddTrack + renegotiate.
	r, ok := s.cfg.Rooms.Get(ps.roomID)
	if !ok {
		return
	}
	peerIDs := r.Peers()

	s.mu.RLock()
	neighbors := make([]*peerState, 0, len(peerIDs))
	for _, c := range peerIDs {
		if c.ID == ps.clientID {
			continue
		}
		if np, exists := s.peers[c.ID]; exists {
			neighbors = append(neighbors, np)
		}
	}
	s.mu.RUnlock()

	for _, np := range neighbors {
		if err := np.addForwardedTrack(s, ps.clientID, pt); err != nil {
			continue
		}
		if err := np.renegotiateSubscribe(); err != nil {
			_ = err
		}
	}
}

// addForwardedTrack добавляет local-трек в subscribePC соседа. Если subscribePC
// ещё нет — создаёт его. Сохраняет RTPSender чтобы потом можно было RemoveTrack.
func (np *peerState) addForwardedTrack(s *SFU, ownerID room.ClientID, pt *publishedTrack) error {
	np.mu.Lock()
	defer np.mu.Unlock()

	if np.closed {
		return fmt.Errorf("sfu: peer %q closed", np.clientID)
	}

	if np.subscribePC == nil {
		pc, err := s.api.NewPeerConnection(s.rtcConfiguration())
		if err != nil {
			return fmt.Errorf("sfu: new subscribe PC: %w", err)
		}
		// ICE — отправляем клиенту с role=subscribe.
		pc.OnICECandidate(func(c *webrtc.ICECandidate) {
			if c == nil {
				return
			}
			np.sendICE(c, roleSubscribe)
		})
		np.subscribePC = pc
	}

	sender, err := np.subscribePC.AddTrack(pt.local)
	if err != nil {
		return fmt.Errorf("sfu: AddTrack: %w", err)
	}

	// Дренируем RTCP с sender'а: иначе рост памяти и stale state.
	go drainRTCP(sender)

	if _, ok := np.forwarded[ownerID]; !ok {
		np.forwarded[ownerID] = make(map[string]*webrtc.RTPSender)
	}
	np.forwarded[ownerID][pt.id] = sender
	return nil
}

// removeForwardedFrom снимает все треки указанного владельца с subscribePC соседа.
// Возвращает количество фактически удалённых треков.
func (np *peerState) removeForwardedFrom(ownerID room.ClientID, trackIDs []string) int {
	np.mu.Lock()
	defer np.mu.Unlock()

	if np.closed || np.subscribePC == nil {
		return 0
	}
	tracks, ok := np.forwarded[ownerID]
	if !ok {
		return 0
	}

	removed := 0
	for _, id := range trackIDs {
		sender, exists := tracks[id]
		if !exists {
			continue
		}
		_ = np.subscribePC.RemoveTrack(sender)
		delete(tracks, id)
		removed++
	}
	if len(tracks) == 0 {
		delete(np.forwarded, ownerID)
	}
	if removed > 0 {
		log.Printf("[sfu] track-unsubscribed client=%s from=%s removed=%d", np.clientID, ownerID, removed)
	}
	return removed
}

// renegotiateSubscribe — выпускает новый offer с subscribePC и шлёт клиенту.
func (np *peerState) renegotiateSubscribe() error {
	np.mu.Lock()
	if np.closed || np.subscribePC == nil {
		np.mu.Unlock()
		return nil
	}
	pc := np.subscribePC
	// Считаем сколько треков сейчас форвардится этому subscriber'у — для лога.
	numTracks := 0
	for _, byOwner := range np.forwarded {
		numTracks += len(byOwner)
	}
	np.mu.Unlock()

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return fmt.Errorf("sfu: create subscribe-offer: %w", err)
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		return fmt.Errorf("sfu: set local (subscribe-offer): %w", err)
	}

	log.Printf("[sfu] subscribe-renegotiate client=%s tracks=%d", np.clientID, numTracks)

	payload, err := json.Marshal(sdpData{SDP: offer.SDP})
	if err != nil {
		return fmt.Errorf("sfu: marshal subscribe-offer: %w", err)
	}
	return np.send(signal.Envelope{
		Type: signal.MsgSubscribeOffer,
		Data: payload,
	})
}

// handleSubscribeAnswer принимает SDP-answer и применяет его к subscribePC.
func (np *peerState) handleSubscribeAnswer(sdp string) error {
	np.mu.Lock()
	pc := np.subscribePC
	np.mu.Unlock()

	if pc == nil {
		return fmt.Errorf("sfu: subscribe-answer without subscribePC for %q", np.clientID)
	}

	answer := webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}
	if err := pc.SetRemoteDescription(answer); err != nil {
		return fmt.Errorf("sfu: set remote (subscribe-answer): %w", err)
	}
	return nil
}

// handleICE — добавляет ICE-кандидат в нужный PC.
func (np *peerState) handleICE(role string, cand webrtc.ICECandidateInit) error {
	np.mu.Lock()
	var pc *webrtc.PeerConnection
	switch role {
	case rolePublish:
		pc = np.publishPC
	case roleSubscribe:
		pc = np.subscribePC
	default:
		np.mu.Unlock()
		return fmt.Errorf("sfu: unknown ice role %q", role)
	}
	np.mu.Unlock()

	if pc == nil {
		return fmt.Errorf("sfu: ice for missing %s PC (peer %q)", role, np.clientID)
	}
	if err := pc.AddICECandidate(cand); err != nil {
		return fmt.Errorf("sfu: AddICECandidate (%s): %w", role, err)
	}
	return nil
}

// sendICE формирует и отправляет ice envelope клиенту.
func (np *peerState) sendICE(c *webrtc.ICECandidate, role string) {
	init := c.ToJSON()
	payload, err := json.Marshal(iceData{
		Candidate: init,
		Role:      role,
	})
	if err != nil {
		return
	}
	_ = np.send(signal.Envelope{
		Type: signal.MsgICE,
		Data: payload,
	})
}

// close — закрывает оба PC и отмечает peerState как closed.
// Идемпотентен. Все горутины-форвардеры завершатся через ошибку Read на remoteTrack.
func (np *peerState) close() {
	np.mu.Lock()
	if np.closed {
		np.mu.Unlock()
		return
	}
	np.closed = true

	pubPC := np.publishPC
	subPC := np.subscribePC

	// Закрываем done-каналы published-треков чтобы форвард-горутины могли
	// детектить leave (они и так выйдут по ошибке Read, но done — для будущей санитарии).
	for _, pt := range np.published {
		select {
		case <-pt.done:
		default:
			close(pt.done)
		}
	}
	np.publishPC = nil
	np.subscribePC = nil
	np.published = make(map[string]*publishedTrack)
	np.forwarded = make(map[room.ClientID]map[string]*webrtc.RTPSender)
	np.mu.Unlock()

	if pubPC != nil {
		_ = pubPC.Close()
	}
	if subPC != nil {
		_ = subPC.Close()
	}
}
