// Package room — реестр и lifecycle комнат.
//
// Контракт (заполняется агентом):
//
//   - NewRegistry() *Registry
//   - (*Registry).Create(hostName string) *Room  — создаёт комнату, генерит roomID (8 chars Crockford base32 без I/L/O/U)
//   - (*Registry).Get(id string) (*Room, bool)
//   - (*Registry).Delete(id string)
//
//   - (*Room) ID() string
//   - (*Room) HostID() ClientID
//   - (*Room) Add(c *Client) error            — error если уже есть с таким ID
//   - (*Room) Remove(id ClientID) (*Client, bool)
//   - (*Room) Get(id ClientID) (*Client, bool)
//   - (*Room) Peers() []*Client                — snapshot
//   - (*Room) IsEmpty() bool
//
// Concurrency: все методы Registry/Room thread-safe (RWMutex).
package room

import (
	"crypto/rand"
	"fmt"
	"sync"

	"github.com/google/uuid"
)

type ClientID string

type Client struct {
	ID          ClientID
	DisplayName string
	IsHost      bool
}

// crockfordAlphabet — Crockford base32 без I, L, O, U.
const crockfordAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// roomIDLen — длина roomID в символах. 8 символов = 40 бит энтропии.
const roomIDLen = 8

// Registry хранит активные комнаты по их ID.
type Registry struct {
	mu    sync.RWMutex
	rooms map[string]*Room
}

// NewRegistry создаёт пустой реестр комнат.
func NewRegistry() *Registry {
	return &Registry{
		rooms: make(map[string]*Room),
	}
}

// Create создаёт новую комнату со сгенерированным roomID и сразу добавляет
// хоста (с UUID-идентификатором и IsHost=true) первым клиентом.
// В крайне маловероятном случае коллизии roomID попытка повторяется.
func (r *Registry) Create(hostName string) *Room {
	r.mu.Lock()
	defer r.mu.Unlock()

	var id string
	for {
		id = generateRoomID()
		if _, exists := r.rooms[id]; !exists {
			break
		}
	}

	host := &Client{
		ID:          ClientID(uuid.NewString()),
		DisplayName: hostName,
		IsHost:      true,
	}

	room := &Room{
		id:      id,
		hostID:  host.ID,
		clients: map[ClientID]*Client{host.ID: host},
	}

	r.rooms[id] = room
	return room
}

// Get возвращает комнату по id, либо (nil, false) если такой нет.
func (r *Registry) Get(id string) (*Room, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	room, ok := r.rooms[id]
	return room, ok
}

// Delete удаляет комнату из реестра. Если такой не было — no-op.
func (r *Registry) Delete(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.rooms, id)
}

// Room — одна видеоконференция: набор клиентов плюс метаинформация.
type Room struct {
	mu      sync.RWMutex
	id      string
	hostID  ClientID
	clients map[ClientID]*Client
}

// ID возвращает идентификатор комнаты.
func (r *Room) ID() string {
	return r.id
}

// HostID возвращает ID клиента-хоста.
func (r *Room) HostID() ClientID {
	return r.hostID
}

// Add добавляет клиента. Возвращает ошибку, если клиент с таким ID уже есть.
func (r *Room) Add(c *Client) error {
	if c == nil {
		return fmt.Errorf("room: nil client")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.clients[c.ID]; exists {
		return fmt.Errorf("room: client %q already exists", c.ID)
	}
	r.clients[c.ID] = c
	return nil
}

// Remove удаляет клиента из комнаты. Возвращает удалённого клиента и true,
// либо (nil, false), если такого клиента не было.
func (r *Room) Remove(id ClientID) (*Client, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.clients[id]
	if !ok {
		return nil, false
	}
	delete(r.clients, id)
	return c, true
}

// Get возвращает клиента по ID.
func (r *Room) Get(id ClientID) (*Client, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	c, ok := r.clients[id]
	return c, ok
}

// Peers возвращает snapshot копию списка клиентов. Возвращённый срез
// отвязан от внутреннего состояния — модификация не влияет на комнату.
func (r *Room) Peers() []*Client {
	r.mu.RLock()
	defer r.mu.RUnlock()
	peers := make([]*Client, 0, len(r.clients))
	for _, c := range r.clients {
		peers = append(peers, c)
	}
	return peers
}

// IsEmpty true если в комнате не осталось клиентов.
func (r *Room) IsEmpty() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.clients) == 0
}

// generateRoomID — 8-символьный Crockford base32 ID на crypto/rand.
// Берём 5 байт (40 бит) и режем на 8 групп по 5 бит, маппим в алфавит.
func generateRoomID() string {
	var buf [5]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// crypto/rand.Read на современных ОС не возвращает ошибок;
		// падать здесь безопаснее, чем выдавать предсказуемый ID.
		panic(fmt.Errorf("room: crypto/rand failed: %w", err))
	}

	// Собираем 40 бит как uint64 (big-endian порядок байтов).
	var v uint64
	for _, b := range buf {
		v = (v << 8) | uint64(b)
	}

	out := make([]byte, roomIDLen)
	for i := roomIDLen - 1; i >= 0; i-- {
		out[i] = crockfordAlphabet[v&0x1F]
		v >>= 5
	}
	return string(out)
}
