package room

import (
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func TestCreateGetDelete(t *testing.T) {
	reg := NewRegistry()

	room := reg.Create("Alice")
	if room == nil {
		t.Fatal("Create returned nil room")
	}
	if room.ID() == "" {
		t.Fatal("created room has empty ID")
	}
	if room.HostID() == "" {
		t.Fatal("created room has empty HostID")
	}

	host, ok := room.Get(room.HostID())
	if !ok {
		t.Fatal("host not found in fresh room")
	}
	if !host.IsHost {
		t.Error("host client must have IsHost=true")
	}
	if host.DisplayName != "Alice" {
		t.Errorf("host DisplayName = %q, want %q", host.DisplayName, "Alice")
	}

	got, ok := reg.Get(room.ID())
	if !ok {
		t.Fatal("Registry.Get did not find created room")
	}
	if got != room {
		t.Error("Registry.Get returned a different room pointer")
	}

	reg.Delete(room.ID())
	if _, ok := reg.Get(room.ID()); ok {
		t.Error("room still in registry after Delete")
	}

	// Delete на несуществующей комнате — no-op, не должна паниковать.
	reg.Delete("DOES_NOT_EXIST")
}

func TestAddDuplicate(t *testing.T) {
	reg := NewRegistry()
	room := reg.Create("Host")

	c := &Client{
		ID:          ClientID(uuid.NewString()),
		DisplayName: "Bob",
	}
	if err := room.Add(c); err != nil {
		t.Fatalf("first Add returned error: %v", err)
	}
	if err := room.Add(c); err == nil {
		t.Fatal("second Add of same client returned nil error, expected duplicate error")
	}

	// Хост уже добавлен в Create — повторный Add хоста тоже должен фейлиться.
	hostID := room.HostID()
	dup := &Client{ID: hostID, DisplayName: "Impostor", IsHost: true}
	if err := room.Add(dup); err == nil {
		t.Fatal("Add of duplicate host ID returned nil error")
	}
}

func TestRemove(t *testing.T) {
	reg := NewRegistry()
	room := reg.Create("Host")
	hostID := room.HostID()

	bobID := ClientID(uuid.NewString())
	bob := &Client{ID: bobID, DisplayName: "Bob"}
	if err := room.Add(bob); err != nil {
		t.Fatalf("Add Bob: %v", err)
	}

	if room.IsEmpty() {
		t.Error("room with 2 clients reported IsEmpty()=true")
	}

	got, ok := room.Remove(bobID)
	if !ok {
		t.Fatal("Remove(bob) returned false")
	}
	if got != bob {
		t.Error("Remove returned wrong client pointer")
	}
	if _, ok := room.Get(bobID); ok {
		t.Error("Get(bob) returned true after Remove")
	}

	// Remove несуществующего — (nil, false).
	if c, ok := room.Remove(ClientID("nonexistent")); ok || c != nil {
		t.Errorf("Remove(nonexistent) = (%v, %v), want (nil, false)", c, ok)
	}

	// Удаляем хоста — комната становится пустой.
	if _, ok := room.Remove(hostID); !ok {
		t.Fatal("Remove(host) returned false")
	}
	if !room.IsEmpty() {
		t.Error("room with no clients reported IsEmpty()=false")
	}
}

func TestRoomIDFormat(t *testing.T) {
	reg := NewRegistry()

	allowed := make(map[byte]bool, len(crockfordAlphabet))
	for i := 0; i < len(crockfordAlphabet); i++ {
		allowed[crockfordAlphabet[i]] = true
	}

	// Запрещённые символы (Crockford base32 их выкидывает).
	forbidden := "ILOU"

	for i := 0; i < 200; i++ {
		room := reg.Create("Host")
		id := room.ID()
		if len(id) != roomIDLen {
			t.Fatalf("room ID %q has length %d, want %d", id, len(id), roomIDLen)
		}
		for j := 0; j < len(id); j++ {
			if !allowed[id[j]] {
				t.Fatalf("room ID %q contains disallowed char %q at %d", id, id[j], j)
			}
			if strings.IndexByte(forbidden, id[j]) >= 0 {
				t.Fatalf("room ID %q contains forbidden Crockford char %q", id, id[j])
			}
		}
	}
}

func TestPeersIsSnapshot(t *testing.T) {
	reg := NewRegistry()
	room := reg.Create("Host")

	bob := &Client{ID: ClientID(uuid.NewString()), DisplayName: "Bob"}
	if err := room.Add(bob); err != nil {
		t.Fatalf("Add: %v", err)
	}

	peers := room.Peers()
	if len(peers) != 2 {
		t.Fatalf("Peers length = %d, want 2", len(peers))
	}

	// Мутируем возвращённый срез: обнуляем элементы, обрезаем длину.
	for i := range peers {
		peers[i] = nil
	}
	peers = peers[:0]

	// Внутреннее состояние комнаты должно быть нетронуто.
	again := room.Peers()
	if len(again) != 2 {
		t.Errorf("after mutating returned slice, Peers length = %d, want 2", len(again))
	}
	if _, ok := room.Get(room.HostID()); !ok {
		t.Error("host disappeared after mutating Peers() result")
	}
	if _, ok := room.Get(bob.ID); !ok {
		t.Error("Bob disappeared after mutating Peers() result")
	}
}

// Sanity: убедимся что Registry/Room действительно безопасны для конкурентного
// использования (race detector ловит проблемы только если есть параллельный
// доступ). Тест короткий — просто чтобы `go test -race` имел что проверять.
func TestConcurrentAccess(t *testing.T) {
	reg := NewRegistry()
	room := reg.Create("Host")

	const n = 50
	var wg sync.WaitGroup
	wg.Add(n * 3)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			c := &Client{ID: ClientID(uuid.NewString()), DisplayName: "x"}
			_ = room.Add(c)
			room.Remove(c.ID)
		}()
		go func() {
			defer wg.Done()
			_ = room.Peers()
		}()
		go func() {
			defer wg.Done()
			_, _ = reg.Get(room.ID())
		}()
	}
	wg.Wait()
}
