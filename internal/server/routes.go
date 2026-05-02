package server

import "net/http"

// routes возвращает корневой ServeMux со всеми HTTP-роутами.
//
// Используется Go 1.22+ pattern matching: "GET /api/rooms/{id}" и т.п.
// Catch-all "GET /" внутри себя дополнительно проверяет, что path не начинается
// с /api/ и не равен /ws — чтобы корректно отдать 404 на неизвестные API-эндпоинты,
// а не SPA fallback.
func (s *Server) routes() *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/connectivity", s.handleConnectivity)
	mux.HandleFunc("GET /api/mode", s.handleMode)
	mux.HandleFunc("POST /api/rooms", s.handleCreateRoom)
	mux.HandleFunc("GET /api/rooms/{id}", s.handleGetRoom)

	// Cloud config + relay (всё localhost-only — гейт внутри handler'ов).
	mux.HandleFunc("GET /api/cloudconfig", s.handleGetCloudConfig)
	mux.HandleFunc("POST /api/cloudconfig", s.handlePostCloudConfig)
	mux.HandleFunc("POST /api/relay/start", s.handleRelayStart)
	mux.HandleFunc("GET /api/relay/status", s.handleRelayStatus)
	mux.HandleFunc("POST /api/relay/stop", s.handleRelayStop)

	mux.HandleFunc("GET /ws", s.hub.Handle)

	mux.Handle("/", s.handleSPA())

	return mux
}
