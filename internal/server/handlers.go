package server

import (
	"encoding/json"
	"net/http"
)

// healthResponse — payload для GET /api/health.
type healthResponse struct {
	OK      bool   `json:"ok"`
	Version string `json:"version"`
}

// createRoomRequest — body для POST /api/rooms.
type createRoomRequest struct {
	DisplayName string `json:"displayName"`
}

// createRoomResponse — payload ответа POST /api/rooms.
type createRoomResponse struct {
	ID        string `json:"id"`
	InviteURL string `json:"inviteUrl"`
}

// roomPeerInfo — public-инфа о участнике в /api/rooms/{id}.
type roomPeerInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// getRoomResponse — payload ответа GET /api/rooms/{id}.
type getRoomResponse struct {
	ID     string         `json:"id"`
	HostID string         `json:"hostId"`
	Peers  []roomPeerInfo `json:"peers"`
}

// errorResponse — единый формат ошибок API (вне сигналинга).
type errorResponse struct {
	Error string `json:"error"`
}

// handleHealth отвечает {ok:true, version:<v>}. Полезно для мониторинга/healthcheck'ов.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, healthResponse{
		OK:      true,
		Version: s.cfg.Version,
	})
}

// handleCreateRoom создаёт комнату с указанным displayName хоста.
// Возвращает 201 с {id, inviteUrl}; 400 на невалидный JSON.
func (s *Server) handleCreateRoom(w http.ResponseWriter, r *http.Request) {
	var req createRoomRequest
	// Декодируем bodu даже если она пустая — пустое имя допустимо в MVP.
	if r.Body != nil && r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{
				Error: "invalid JSON: " + err.Error(),
			})
			return
		}
	}

	rm := s.rooms.Create(req.DisplayName)

	writeJSON(w, http.StatusCreated, createRoomResponse{
		ID:        rm.ID(),
		InviteURL: "/m/" + rm.ID(),
	})
}

// handleGetRoom возвращает текущее состояние комнаты по ID. 404 если нет.
func (s *Server) handleGetRoom(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	rm, ok := s.rooms.Get(id)
	if !ok {
		writeJSON(w, http.StatusNotFound, errorResponse{Error: "room not found"})
		return
	}

	clientPeers := rm.Peers()
	peers := make([]roomPeerInfo, 0, len(clientPeers))
	for _, p := range clientPeers {
		peers = append(peers, roomPeerInfo{
			ID:   string(p.ID),
			Name: p.DisplayName,
		})
	}

	writeJSON(w, http.StatusOK, getRoomResponse{
		ID:     rm.ID(),
		HostID: string(rm.HostID()),
		Peers:  peers,
	})
}

// writeJSON — обёртка для отправки JSON-ответа с явным Content-Type и статусом.
// Игнорирует ошибку Encode: если клиент уже разорвал соединение, всё равно
// делать с этим уже нечего.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
