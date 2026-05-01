package signal

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"

	"github.com/AntonZubritski/ZubraMeet/internal/room"
	"github.com/coder/websocket"
	"github.com/google/uuid"
)

// sendBufSize — размер буфера на каждое WS-соединение. Если writer не успевает
// слить очередь и буфер переполняется — клиент считается slow и закрывается.
const sendBufSize = 32

// welcomeData — payload сообщения welcome.
type welcomeData struct {
	ClientID string     `json:"clientId"`
	IsHost   bool       `json:"isHost"`
	Peers    []peerInfo `json:"peers"`
}

// peerInfo — публичная инфа о другом участнике, отдаётся в welcome.
type peerInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// peerJoinedData — payload сообщения peer-joined.
type peerJoinedData struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// peerLeftData — payload сообщения peer-left.
type peerLeftData struct {
	ID string `json:"id"`
}

// errorData — payload сообщения error.
type errorData struct {
	Message string `json:"message"`
}

// conn — обёртка над WebSocket-соединением для одного клиента.
// sendCh принимает Envelope; единственная writer-goroutine их сериализует и шлёт в ws.
type conn struct {
	ws       *websocket.Conn
	sendCh   chan Envelope
	roomID   string
	clientID room.ClientID
	ctx      context.Context
	cancel   context.CancelFunc

	closeOnce sync.Once
}

// close инициирует закрытие соединения. Идемпотентен: повторные вызовы — no-op.
// Закрывает sendCh, чтобы writer-goroutine вышла, и снимает контекст.
func (c *conn) close() {
	c.closeOnce.Do(func() {
		c.cancel()
		close(c.sendCh)
	})
}

// Hub — реестр активных WS-соединений и посредник между ними и SFU.
type Hub struct {
	rooms *room.Registry
	sfu   SFU

	mu    sync.RWMutex
	conns map[room.ClientID]*conn
}

// NewHub конструирует пустой Hub. rooms и sfu — обязательны.
func NewHub(rooms *room.Registry, sfu SFU) *Hub {
	return &Hub{
		rooms: rooms,
		sfu:   sfu,
		conns: make(map[room.ClientID]*conn),
	}
}

// Handle обрабатывает HTTP-запрос на /ws: апгрейдит в WebSocket, регистрирует
// клиента в комнате, рассылает welcome/peer-joined и крутит reader-loop до дисконнекта.
func (h *Hub) Handle(w http.ResponseWriter, r *http.Request) {
	roomID := r.URL.Query().Get("room")
	name := r.URL.Query().Get("name")

	roomObj, ok := h.rooms.Get(roomID)
	if !ok {
		http.Error(w, "room not found", http.StatusNotFound)
		return
	}

	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// dev-only: на проде origin-check будем добавлять отдельно.
		InsecureSkipVerify: true,
	})
	if err != nil {
		// Accept уже отписал HTTP-ошибку, нам остаётся только выйти.
		return
	}

	client := &room.Client{
		ID:          room.ClientID(uuid.NewString()),
		DisplayName: name,
		IsHost:      false,
	}

	// Snapshot ДО Add: в welcome не должен попасть сам новый клиент.
	peersBefore := roomObj.Peers()

	if err := roomObj.Add(client); err != nil {
		// На случай коллизии UUID или иной ошибки — закрываем с понятным message.
		writeErrorAndClose(ws, "failed to join room: "+err.Error())
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	c := &conn{
		ws:       ws,
		sendCh:   make(chan Envelope, sendBufSize),
		roomID:   roomID,
		clientID: client.ID,
		ctx:      ctx,
		cancel:   cancel,
	}

	h.mu.Lock()
	h.conns[client.ID] = c
	h.mu.Unlock()

	// Writer-goroutine: один на соединение. Выходит когда sendCh закрыт.
	go h.writeLoop(c)

	// Cleanup-defer: единая точка выхода из Handle. Порядок важен:
	//  1) уведомить SFU чтобы он вычистил треки.
	//  2) убрать клиента из room и сообщить остальным peer-left.
	//  3) если room пуст — удалить из registry.
	//  4) закрыть WS и удалить из hub.conns.
	defer func() {
		h.sfu.OnPeerLeave(roomID, client.ID)

		roomObj.Remove(client.ID)

		leftPayload, _ := json.Marshal(peerLeftData{ID: string(client.ID)})
		h.Broadcast(roomID, client.ID, Envelope{
			Type: MsgPeerLeft,
			From: string(client.ID),
			Data: leftPayload,
		})

		if roomObj.IsEmpty() {
			h.rooms.Delete(roomID)
		}

		h.mu.Lock()
		delete(h.conns, client.ID)
		h.mu.Unlock()

		c.close()
	}()

	// welcome → новому клиенту.
	welcomePeers := make([]peerInfo, 0, len(peersBefore))
	for _, p := range peersBefore {
		welcomePeers = append(welcomePeers, peerInfo{
			ID:   string(p.ID),
			Name: p.DisplayName,
		})
	}
	welcomePayload, _ := json.Marshal(welcomeData{
		ClientID: string(client.ID),
		IsHost:   client.ID == roomObj.HostID(),
		Peers:    welcomePeers,
	})
	if err := h.SendTo(client.ID, Envelope{
		Type: MsgWelcome,
		Data: welcomePayload,
	}); err != nil {
		return
	}

	// peer-joined → всем кроме нового.
	joinedPayload, _ := json.Marshal(peerJoinedData{
		ID:   string(client.ID),
		Name: client.DisplayName,
	})
	h.Broadcast(roomID, client.ID, Envelope{
		Type: MsgPeerJoined,
		From: string(client.ID),
		Data: joinedPayload,
	})

	// SFU узнаёт о новом peer'е и получает callback для отправки сообщений ему.
	sendFn := func(env Envelope) error {
		return h.SendTo(client.ID, env)
	}
	h.sfu.OnPeerJoin(roomID, client.ID, sendFn)

	// Reader-loop: блокируется на Read, выходит на любой ошибке/отмене ctx.
	for {
		_, msg, err := ws.Read(ctx)
		if err != nil {
			return
		}

		var env Envelope
		if err := json.Unmarshal(msg, &env); err != nil {
			h.sendError(client.ID, "invalid envelope: "+err.Error())
			continue
		}

		if env.Type == MsgLeave {
			return
		}

		// from на входе игнорируем — сервер сам выставляет at-broadcast.
		env.From = string(client.ID)

		if err := h.sfu.OnSignal(client.ID, env); err != nil {
			h.sendError(client.ID, err.Error())
			continue
		}
	}
}

// Broadcast рассылает msg всем участникам комнаты roomID кроме except.
// Не блокируется: если у конкретного клиента переполнен sendCh, он будет закрыт SendTo.
func (h *Hub) Broadcast(roomID string, except room.ClientID, msg Envelope) {
	h.mu.RLock()
	targets := make([]*conn, 0, len(h.conns))
	for id, c := range h.conns {
		if id == except {
			continue
		}
		if c.roomID != roomID {
			continue
		}
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	for _, c := range targets {
		h.sendToConn(c, msg)
	}
}

// SendTo шлёт msg клиенту clientID. Возвращает ошибку, если клиент не найден
// или его очередь переполнена (slow client → соединение закрывается).
func (h *Hub) SendTo(clientID room.ClientID, msg Envelope) error {
	h.mu.RLock()
	c, ok := h.conns[clientID]
	h.mu.RUnlock()
	if !ok {
		return errors.New("signal: client not connected")
	}
	return h.sendToConn(c, msg)
}

// sendToConn — non-blocking enqueue в sendCh. На переполнение/закрытие канала
// принудительно закрываем соединение, чтобы не копить backpressure в Hub.
func (h *Hub) sendToConn(c *conn, msg Envelope) error {
	defer func() {
		// Защита от send-on-closed-channel: если close() уже отработал,
		// recover превратит панику в ошибку, и соединение мы уже считаем закрытым.
		_ = recover()
	}()

	select {
	case c.sendCh <- msg:
		return nil
	default:
		// Slow client: рвём связь и пусть defer-cleanup в Handle отрабатывает.
		c.close()
		return errors.New("signal: send buffer full, closing connection")
	}
}

// sendError шлёт error-envelope конкретному клиенту. Ошибки самой отправки игнорируем —
// если SendTo упал, клиент уже отключается через свой defer.
func (h *Hub) sendError(clientID room.ClientID, message string) {
	payload, _ := json.Marshal(errorData{Message: message})
	_ = h.SendTo(clientID, Envelope{
		Type: MsgError,
		Data: payload,
	})
}

// writeLoop — единственная goroutine, которая пишет в ws. Читает Envelope из
// sendCh, маршалит в JSON и шлёт текстовым WS-фреймом. Завершается на close(sendCh).
func (h *Hub) writeLoop(c *conn) {
	defer func() {
		// Гарантированный обрыв соединения после выхода из цикла.
		_ = c.ws.CloseNow()
	}()

	for env := range c.sendCh {
		data, err := json.Marshal(env)
		if err != nil {
			// Сериализация Envelope — программерская ошибка, не клиентская;
			// пропускаем, но соединение не рвём — пусть остальные сообщения идут.
			continue
		}
		if err := c.ws.Write(c.ctx, websocket.MessageText, data); err != nil {
			// На любую ошибку записи — фиксируем разрыв и выходим. Reader-loop
			// в Handle тоже умрёт по ctx, и cleanup-defer всё закроет.
			c.cancel()
			return
		}
	}
}

// writeErrorAndClose отправляет error-envelope и закрывает соединение с кодом 1011.
// Используется до регистрации conn в hub'е, когда обычный sendCh-механизм недоступен.
func writeErrorAndClose(ws *websocket.Conn, message string) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	payload, _ := json.Marshal(errorData{Message: message})
	env := Envelope{Type: MsgError, Data: payload}
	data, _ := json.Marshal(env)
	_ = ws.Write(ctx, websocket.MessageText, data)
	_ = ws.Close(websocket.StatusInternalError, message)
}
