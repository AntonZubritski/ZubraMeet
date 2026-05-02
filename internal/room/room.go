// Package room — реестр и lifecycle комнат.
//
// Контракт (заполняется агентом):
//
//   - NewRegistry() *Registry
//   - (*Registry).Create(hostName string) *Room  — создаёт комнату, генерит roomID (16 chars Crockford base32 без I/L/O/U)
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

// roomIDLen — длина roomID в символах. 16 символов = 80 бит энтропии,
// 32^16 ≈ 1.2×10^24 комбинаций — защита от brute-force через Nostr-relays
// (там видно roomId всех активных комнат с тем же appId).
const roomIDLen = 16

// roomIDBytes — сколько крипто-случайных байт нужно, чтобы получить
// roomIDLen×5 бит. Берём ceil(roomIDLen*5/8) и используем младшие 5 бит
// каждой 5-битной группы из общего 80-битного буфера.
const roomIDBytes = (roomIDLen*5 + 7) / 8 // 10 байт для 16 символов

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

// generateRoomID — Crockford base32 ID на crypto/rand. Длина управляется
// константой roomIDLen (текущая = 16 → 80 бит энтропии).
//
// Берём roomIDBytes крипто-случайных байт и читаем по 5 бит "слева направо"
// через bit-shift аккумулятор. Распределение строго равномерное (256 % 32 == 0).
func generateRoomID() string {
	buf := make([]byte, roomIDBytes)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand.Read на современных ОС не возвращает ошибок;
		// падать здесь безопаснее, чем выдавать предсказуемый ID.
		panic(fmt.Errorf("room: crypto/rand failed: %w", err))
	}

	out := make([]byte, roomIDLen)
	// Бит-аккумулятор: накапливаем биты из buf, выдаём по 5 в каждый символ.
	var acc uint32
	var bits uint // сколько валидных младших бит в acc
	bi := 0       // индекс следующего байта buf для подгрузки
	for i := 0; i < roomIDLen; i++ {
		for bits < 5 && bi < len(buf) {
			acc = (acc << 8) | uint32(buf[bi])
			bits += 8
			bi++
		}
		// Извлекаем верхние 5 бит, чтобы шёл естественный big-endian порядок.
		shift := bits - 5
		out[i] = crockfordAlphabet[(acc>>shift)&0x1F]
		// Чистим использованные биты.
		acc &= (1 << shift) - 1
		bits -= 5
	}
	return string(out)
}
