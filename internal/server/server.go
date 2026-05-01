// Package server — HTTP-сервер с embedded SPA и WebSocket-сигналингом.
//
// Контракт:
//
//   - New(cfg Config) *Server
//   - (*Server) Run(ctx context.Context) error  — блокирующий
//   - (*Server) Shutdown(ctx context.Context) error
//
// Routes (см. PROTOCOL.md):
//
//   GET  /api/health           → { ok: true, version: "<v>" }
//   POST /api/rooms            → создать комнату; body { displayName }; resp { id, inviteUrl }
//   GET  /api/rooms/{id}       → инфо о комнате (404 если нет)
//   GET  /ws?room=<id>&name=<> → upgrade в WebSocket
//   GET  /                     → SPA fallback на index.html из StaticFS
//
// SPA fallback: любой path который не /api/* и не /ws и не существует в StaticFS — отдаёт index.html.
package server

import (
	"context"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/AntonZubritski/ZubraMeet/internal/room"
	"github.com/AntonZubritski/ZubraMeet/internal/sfu"
	"github.com/AntonZubritski/ZubraMeet/internal/signal"
)

// Config — параметры HTTP-сервера.
type Config struct {
	Addr     string // ":7777"
	Version  string
	StaticFS fs.FS // embedded SPA (web/dist/)
}

// Server — HTTP+WS+SFU-сервер ZubraMeet. Создаётся через New, запускается через Run.
type Server struct {
	cfg   Config
	rooms *room.Registry
	sfu   *sfu.SFU
	hub   *signal.Hub

	mu     sync.Mutex
	httpSrv *http.Server
}

// defaultSTUN возвращает дефолтный список ICE-серверов. Используется когда
// конфиг ICE не задан явно — берём публичный Google STUN.
func defaultSTUN() []sfu.ICEServer {
	return []sfu.ICEServer{
		{URLs: []string{"stun:stun.l.google.com:19302"}},
	}
}

// New собирает граф зависимостей: Registry → SFU → Hub → mux. Если SFU не
// удаётся создать (например, RegisterDefaultCodecs упал) — паникуем: это
// программерская ошибка инициализации, продолжать смысла нет.
func New(cfg Config) *Server {
	rooms := room.NewRegistry()

	sfuInst, err := sfu.New(sfu.Config{
		ICEServers: defaultSTUN(),
		Rooms:      rooms,
	})
	if err != nil {
		// Сигнатура New не предусматривает error; падаем рано и громко.
		panic("server: sfu.New failed: " + err.Error())
	}

	hub := signal.NewHub(rooms, &sfuAdapter{sfu: sfuInst})

	return &Server{
		cfg:   cfg,
		rooms: rooms,
		sfu:   sfuInst,
		hub:   hub,
	}
}

// Run запускает HTTP-сервер и блокируется до отмены ctx или фатальной ошибки.
// На отмене контекста — graceful shutdown с таймаутом 5s.
func (s *Server) Run(ctx context.Context) error {
	mux := s.routes()
	log.Printf("[http] routes registered: GET /api/health, POST /api/rooms, GET /api/rooms/{id}, GET /ws, GET /*")

	httpSrv := &http.Server{
		Addr:    s.cfg.Addr,
		Handler: mux,
	}

	s.mu.Lock()
	s.httpSrv = httpSrv
	s.mu.Unlock()

	errCh := make(chan error, 1)
	go func() {
		errCh <- httpSrv.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return httpSrv.Shutdown(shutdownCtx)
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

// Shutdown — graceful shutdown HTTP-сервера. Если Run ещё не вызывался — no-op.
func (s *Server) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	httpSrv := s.httpSrv
	s.mu.Unlock()

	if httpSrv == nil {
		return nil
	}
	return httpSrv.Shutdown(ctx)
}
