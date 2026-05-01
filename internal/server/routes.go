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
	mux.HandleFunc("POST /api/rooms", s.handleCreateRoom)
	mux.HandleFunc("GET /api/rooms/{id}", s.handleGetRoom)

	mux.HandleFunc("GET /ws", s.hub.Handle)

	mux.Handle("/", s.handleSPA())

	return mux
}
