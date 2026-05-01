// Package server — HTTP+HTTPS-сервер с embedded SPA и WebSocket-сигналингом.
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
//   GET  /api/connectivity     → { endpoints: [...] }   (только для localhost)
//   POST /api/rooms            → создать комнату; body { displayName }; resp { id, inviteUrl }
//   GET  /api/rooms/{id}       → инфо о комнате (404 если нет)
//   GET  /ws?room=<id>&name=<> → upgrade в WebSocket
//   GET  /                     → SPA fallback на index.html из StaticFS
//
// Сервер слушает одновременно HTTP (для localhost-доступа хоста) и HTTPS
// (для гостей по LAN/internet — getUserMedia требует HTTPS на не-localhost
// origin'ах). HTTPS использует self-signed cert через tlsutil.EnsureCert.
//
// При EnableUPnP=true сервер пытается через UPnP IGD пробить публичный порт
// для HTTPS, чтобы интернет-гости могли подключиться. Если UPnP/cert падают —
// сервер всё равно поднимается на HTTP (degraded mode).
package server

import (
	"context"
	"crypto/tls"
	"errors"
	"io/fs"
	"log"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/AntonZubritski/ZubraMeet/internal/connectivity"
	"github.com/AntonZubritski/ZubraMeet/internal/nat"
	"github.com/AntonZubritski/ZubraMeet/internal/room"
	"github.com/AntonZubritski/ZubraMeet/internal/sfu"
	"github.com/AntonZubritski/ZubraMeet/internal/signal"
	"github.com/AntonZubritski/ZubraMeet/internal/tlsutil"
)

// Config — параметры сервера.
type Config struct {
	HTTPAddr   string // ":7777" — для localhost-доступа хоста
	HTTPSAddr  string // ":7443" — для гостей (LAN/internet) с self-signed cert
	Version    string
	StaticFS   fs.FS // embedded SPA (web/dist/)
	EnableUPnP bool  // true → пытаемся пробить порт через UPnP
}

// Server — HTTP+HTTPS+WS+SFU-сервер ZubraMeet. Создаётся через New, запускается через Run.
type Server struct {
	cfg   Config
	rooms *room.Registry
	sfu   *sfu.SFU
	hub   *signal.Hub

	mu       sync.Mutex
	httpSrv  *http.Server
	httpsSrv *http.Server

	natClient  *nat.Client  // nil если UPnP не сработал
	natMapping *nat.Mapping // nil если mapping не создан
	publicIP   string       // "" если не определён

	// diagnosis — результат авто-диагностики reachability сервера из интернета.
	// Заполняется в Run() после tryUPnP. Читается /api/connectivity.
	diagnosis connectivity.Diagnosis
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

// Run запускает HTTP- и HTTPS-серверы и блокируется до отмены ctx или фатальной
// ошибки. На отмене контекста — graceful shutdown с таймаутом 5s.
//
// Алгоритм:
//  1. UPnP discovery (опционально) → port mapping → publicIP.
//  2. Сертификат для localhost + LAN-IPs + publicIP.
//  3. Запуск HTTP и HTTPS параллельно. Если сертификат не получился — только HTTP.
func (s *Server) Run(ctx context.Context) error {
	mux := s.routes()
	log.Printf("[http] routes registered: GET /api/health, GET /api/connectivity, POST /api/rooms, GET /api/rooms/{id}, GET /ws, GET /*")

	// 1. Парсим HTTPS-порт (нужен для UPnP-mapping).
	httpsPort, err := parsePort(s.cfg.HTTPSAddr)
	if err != nil {
		return err
	}

	// 2. Локальные IP — нужны для cert (чтобы гости в LAN могли подключиться).
	localIPs, err := connectivity.LocalIPs()
	if err != nil {
		log.Printf("[tls] enumerate local IPs failed: %v", err)
		localIPs = nil
	}

	hosts := append([]string{"localhost", "127.0.0.1"}, localIPs...)

	// 3. UPnP (best effort). Любые ошибки — warning, не фатально.
	if s.cfg.EnableUPnP {
		s.tryUPnP(ctx, httpsPort, &hosts)
	}

	// 3a. Авто-диагностика reachability из интернета. Использует уже
	// известный s.publicIP (если UPnP сработал) и сам пробует найти
	// глобальный IPv6. Чисто read-only: ни на что в Run не влияет, кроме
	// того, что результат отдаётся клиентам через /api/connectivity.
	d := connectivity.Diagnose(s.publicIP)
	s.mu.Lock()
	s.diagnosis = d
	s.mu.Unlock()
	log.Printf("[net] diagnosis: status=%s ipv4=%q ipv6=%q cgnat=%v reasons=%v",
		d.Status, d.PublicIPv4, d.PublicIPv6, d.BehindCGNAT, d.Reasons)

	// 4. TLS cert. Если падает — HTTPS отключён, продолжаем на HTTP.
	var tlsCert *tls.Certificate
	cert, err := tlsutil.EnsureCert(hosts)
	if err != nil {
		log.Printf("[tls] ensure cert failed: %v — HTTPS will be disabled", err)
	} else {
		tlsCert = cert
		log.Printf("[tls] cert ready for hosts: %v", hosts)
	}

	// 5. Серверы. Один и тот же handler.
	httpSrv := &http.Server{
		Addr:    s.cfg.HTTPAddr,
		Handler: mux,
	}

	var httpsSrv *http.Server
	if tlsCert != nil {
		httpsSrv = &http.Server{
			Addr:    s.cfg.HTTPSAddr,
			Handler: mux,
			TLSConfig: &tls.Config{
				Certificates: []tls.Certificate{*tlsCert},
			},
		}
	}

	s.mu.Lock()
	s.httpSrv = httpSrv
	s.httpsSrv = httpsSrv
	s.mu.Unlock()

	// 6. Запуск. Считаем сколько горутин стартовало — ровно столько раз ждём
	// результата (или сигнала ctx).
	errCh := make(chan error, 2)
	running := 0

	go func() {
		errCh <- httpSrv.ListenAndServe()
	}()
	running++
	log.Printf("[http] HTTP listening on %s", s.cfg.HTTPAddr)

	if httpsSrv != nil {
		go func() {
			// Cert уже в TLSConfig, файлы передавать не нужно.
			errCh <- httpsSrv.ListenAndServeTLS("", "")
		}()
		running++
		log.Printf("[http] HTTPS listening on %s", s.cfg.HTTPSAddr)
	} else {
		log.Printf("[http] HTTPS disabled (cert generation failed)")
	}

	// 7. Ждём либо ctx.Done, либо фатальную ошибку. http.ErrServerClosed —
	// штатный shutdown одного из серверов; ждём остальных.
	for i := 0; i < running; i++ {
		select {
		case <-ctx.Done():
			return s.gracefulShutdown()
		case err := <-errCh:
			if err != nil && !errors.Is(err, http.ErrServerClosed) {
				// Один из серверов упал по-настоящему — гасим оставшиеся и выходим.
				_ = s.gracefulShutdown()
				return err
			}
		}
	}
	return nil
}

// tryUPnP — best effort UPnP discovery + port mapping. Любая ошибка приводит
// к "продолжаем без UPnP", но не к panic/return. Обновляет hosts (добавляет
// publicIP) и s.{natClient,natMapping,publicIP}.
func (s *Server) tryUPnP(ctx context.Context, httpsPort uint16, hosts *[]string) {
	upnpCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	natClient, err := nat.Discover(upnpCtx)
	if err != nil {
		log.Printf("[nat] upnp discover failed: %v — internet guests won't be reachable", err)
		return
	}

	mapping, err := natClient.AddMapping(ctx, httpsPort, httpsPort, "ZubraMeet", 7200*time.Second)
	if err != nil {
		log.Printf("[nat] upnp add mapping failed: %v", err)
		_ = natClient.Close()
		return
	}

	s.mu.Lock()
	s.natClient = natClient
	s.natMapping = mapping
	s.publicIP = mapping.ExternalIP
	s.mu.Unlock()

	if mapping.ExternalIP != "" {
		*hosts = append(*hosts, mapping.ExternalIP)
	}

	log.Printf("[nat] upnp port-mapping %d → %d, public-ip=%s", httpsPort, mapping.ExternalPort, mapping.ExternalIP)
}

// gracefulShutdown — внутренний хелпер. Гасит оба сервера и снимает UPnP-mapping
// с таймаутом 5s.
func (s *Server) gracefulShutdown() error {
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return s.Shutdown(shutdownCtx)
}

// Shutdown — graceful shutdown HTTP/HTTPS-серверов и снятие UPnP-mapping.
// Если Run ещё не вызывался — no-op. Идемпотентен.
func (s *Server) Shutdown(ctx context.Context) error {
	s.mu.Lock()
	httpSrv, httpsSrv := s.httpSrv, s.httpsSrv
	natClient, natMapping := s.natClient, s.natMapping
	// Обнуляем, чтобы повторный Shutdown не повторял операций.
	s.httpSrv = nil
	s.httpsSrv = nil
	s.natClient = nil
	s.natMapping = nil
	s.mu.Unlock()

	var errs []error
	if httpSrv != nil {
		if err := httpSrv.Shutdown(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	if httpsSrv != nil {
		if err := httpsSrv.Shutdown(ctx); err != nil {
			errs = append(errs, err)
		}
	}

	// Снять port mapping. Делаем на отдельном context.Background с коротким
	// таймаутом — даже если основной ctx уже отменён, маппинг хочется убрать.
	if natClient != nil && natMapping != nil {
		rmCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		if err := natClient.RemoveMapping(rmCtx, natMapping.ExternalPort, natMapping.Protocol); err != nil {
			log.Printf("[nat] remove mapping failed: %v", err)
		} else {
			log.Printf("[nat] removed port-mapping %d/%s", natMapping.ExternalPort, natMapping.Protocol)
		}
		cancel()
		_ = natClient.Close()
	}

	return errors.Join(errs...)
}

// parsePort извлекает числовой порт из адреса вида ":7443" / "0.0.0.0:7443".
func parsePort(addr string) (uint16, error) {
	_, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return 0, err
	}
	p, err := strconv.ParseUint(portStr, 10, 16)
	if err != nil {
		return 0, err
	}
	return uint16(p), nil
}
