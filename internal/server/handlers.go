package server

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"

	"github.com/AntonZubritski/ZubraMeet/internal/cloudconfig"
	"github.com/AntonZubritski/ZubraMeet/internal/cloudrelay"
	"github.com/AntonZubritski/ZubraMeet/internal/connectivity"
	"github.com/hetznercloud/hcloud-go/v2/hcloud"
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

// handleConnectivity отдаёт список адресов, по которым достижим сервер
// (localhost, LAN-IPs, public IP), вместе с результатом авто-диагностики
// reachability (CGNAT, отсутствие IPv6 и т.п.). Используется хост-приложением
// для формирования invite-ссылок и UI-предупреждений.
//
// SECURITY: эндпойнт раскрывает локальную топологию (LAN-IP) и детали
// сетевой видимости, поэтому доступен только loopback-клиентам. Удалённые
// гости получат 403.
func (s *Server) handleConnectivity(w http.ResponseWriter, r *http.Request) {
	if !isLocalRequest(r) {
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}

	httpPort := portFromAddr(s.cfg.HTTPAddr)
	httpsPort := portFromAddr(s.cfg.HTTPSAddr)

	endpoints, err := connectivity.Discover(r.Context(), httpPort, httpsPort, s.publicIP)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: err.Error()})
		return
	}

	s.mu.Lock()
	diag := s.diagnosis
	s.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{
		"endpoints": endpoints,
		"diagnosis": diag,
	})
}

// portFromAddr извлекает числовой порт из адреса вида ":7443" / "0.0.0.0:7443".
// При ошибке парсинга возвращает 0 — это лучше, чем падать в handler'е, потому
// что Run() уже валидировал адреса на старте.
func portFromAddr(addr string) uint16 {
	_, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return 0
	}
	p, err := strconv.ParseUint(portStr, 10, 16)
	if err != nil {
		return 0
	}
	return uint16(p)
}

// isLocalRequest возвращает true, если запрос пришёл с loopback-адреса
// (127.0.0.1 / ::1). Используется для защиты sensitive-эндпойнтов.
func isLocalRequest(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// writeJSON — обёртка для отправки JSON-ответа с явным Content-Type и статусом.
// Игнорирует ошибку Encode: если клиент уже разорвал соединение, всё равно
// делать с этим уже нечего.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// handleMode возвращает рекомендованный режим работы (sfu vs p2p) на основе
// результата диагностики reachability. Доступен всем (хост + гости): клиент
// использует это для UI-отображения и для выбора правильного режима подключения.
//
//	GET /api/mode → { mode: "sfu"|"p2p", reason: "...", diagnosis: <Diagnosis> }
//
// Логика:
//   - StatusOK         → "sfu" (хост достижим из интернета, прямая SFU работает).
//   - BehindCGNAT/LAN  → "p2p" (нужно decentralized signaling/mesh).
//   - default          → "sfu" (conservative fallback).
func (s *Server) handleMode(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	d := s.diagnosis
	s.mu.Unlock()

	var mode, reason string
	switch d.Status {
	case connectivity.StatusOK:
		mode = "sfu"
		reason = "host has public address — direct SFU works"
	case connectivity.StatusBehindCGNAT, connectivity.StatusLANOnly:
		mode = "p2p"
		reason = "host behind CGNAT — fallback to P2P mesh via decentralized signaling"
	default:
		mode = "sfu"
		reason = "unknown — defaulting to SFU"
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"mode":      mode,
		"reason":    reason,
		"diagnosis": d,
	})
}

// providerInfo — описание одного cloud-провайдера для GET /api/cloudconfig.
type providerInfo struct {
	ID           string              `json:"id"`
	Name         string              `json:"name"`
	Regions      []cloudrelay.Region `json:"regions"`
	TokenURL     string              `json:"tokenUrl"`
	EstimateNote string              `json:"estimateNote"`
}

// validateHetznerToken пытается дёрнуть Hetzner API чтобы проверить, что
// токен валиден. Использует ServerType.List с лимитом 1 — это самый дешёвый
// API call (read-only, бесплатный).
func validateHetznerToken(ctx context.Context, token string) error {
	if token == "" {
		return errEmptyToken
	}
	client := hcloud.NewClient(hcloud.WithToken(token))
	_, _, err := client.ServerType.List(ctx, hcloud.ServerTypeListOpts{
		ListOpts: hcloud.ListOpts{Page: 1, PerPage: 1},
	})
	return err
}

var errEmptyToken = errors.New("empty token")

// availableProviders возвращает статический список поддерживаемых провайдеров.
// Регионы берём из соответствующего Provider (Hetzner.Regions()).
func availableProviders() []providerInfo {
	return []providerInfo{
		{
			ID:           "hetzner",
			Name:         "Hetzner Cloud",
			Regions:      cloudrelay.NewHetzner("").Regions(),
			TokenURL:     "https://console.hetzner.cloud/projects",
			EstimateNote: "≈ €0.006/час за самую дешёвую VM",
		},
	}
}

// handleGetCloudConfig возвращает текущий cloud-config (БЕЗ apiToken — только
// флаг hasToken) + список доступных провайдеров с регионами.
//
// Localhost-only: содержит чувствительные настройки.
func (s *Server) handleGetCloudConfig(w http.ResponseWriter, r *http.Request) {
	if !isLocalRequest(r) {
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}

	cfg, err := cloudconfig.Load()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: err.Error()})
		return
	}

	resp := map[string]any{
		"provider":  cfg.Provider,
		"region":    cfg.Region,
		"hasToken":  cfg.APIToken != "",
		"enabled":   cfg.Enabled,
		"providers": availableProviders(),
	}
	writeJSON(w, http.StatusOK, resp)
}

// cloudConfigRequest — body для POST /api/cloudconfig.
//
// Если apiToken пустая строка — НЕ затираем существующий токен (это позволяет
// фронту отправлять только {provider, region, enabled} без необходимости каждый
// раз пересохранять токен).
type cloudConfigRequest struct {
	Provider string `json:"provider"`
	APIToken string `json:"apiToken"`
	Region   string `json:"region"`
	Enabled  bool   `json:"enabled"`
}

// handlePostCloudConfig валидирует и сохраняет cloud-config. Если provider ==
// "hetzner" и передан apiToken — пытаемся проверить токен через ValidateToken.
//
// Localhost-only.
func (s *Server) handlePostCloudConfig(w http.ResponseWriter, r *http.Request) {
	if !isLocalRequest(r) {
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}

	var req cloudConfigRequest
	if r.Body != nil && r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid JSON: " + err.Error()})
			return
		}
	}

	// Загружаем существующий чтобы понять — нужно ли затирать токен.
	existing, err := cloudconfig.Load()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: err.Error()})
		return
	}

	newCfg := &cloudconfig.Config{
		Provider: req.Provider,
		APIToken: req.APIToken,
		Region:   req.Region,
		Enabled:  req.Enabled,
	}
	// Если фронт прислал пустой токен — сохраняем старый (см. doc выше).
	if newCfg.APIToken == "" && existing != nil {
		newCfg.APIToken = existing.APIToken
	}

	// Валидация провайдера + проверка токена. Если enabled=false, токен можно
	// не валидировать — просто сохраняем как есть.
	if newCfg.Enabled {
		switch newCfg.Provider {
		case "hetzner":
			if newCfg.APIToken == "" {
				writeJSON(w, http.StatusBadRequest, errorResponse{Error: "apiToken is required for hetzner"})
				return
			}
			if err := validateHetznerToken(r.Context(), newCfg.APIToken); err != nil {
				writeJSON(w, http.StatusBadRequest, errorResponse{Error: "token validation failed: " + err.Error()})
				return
			}
		case "":
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "provider is required when enabled=true"})
			return
		default:
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "unsupported provider: " + newCfg.Provider})
			return
		}
	}

	if err := cloudconfig.Save(newCfg); err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: err.Error()})
		return
	}

	// Не возвращаем токен наружу.
	writeJSON(w, http.StatusOK, map[string]any{
		"provider": newCfg.Provider,
		"region":   newCfg.Region,
		"hasToken": newCfg.APIToken != "",
		"enabled":  newCfg.Enabled,
	})
}

// handleRelayStart создаёт и поднимает relay-VM через cloudrelay.Manager.
// Localhost-only. 503 если relayMgr не сконфигурирован.
//
//	POST /api/relay/start → { id, publicIP, turnUrl, turnUser, turnPass, costNote }
func (s *Server) handleRelayStart(w http.ResponseWriter, r *http.Request) {
	if !isLocalRequest(r) {
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	if s.relayMgr == nil {
		writeJSON(w, http.StatusServiceUnavailable, errorResponse{Error: "cloud relay not configured — see /settings"})
		return
	}

	relay, err := s.relayMgr.Start(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, relayResponse(relay))
}

// handleRelayStatus возвращает текущий статус активного relay (или active=false).
// Localhost-only.
//
//	GET /api/relay/status → { active: bool, ...Relay }
func (s *Server) handleRelayStatus(w http.ResponseWriter, r *http.Request) {
	if !isLocalRequest(r) {
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	if s.relayMgr == nil {
		writeJSON(w, http.StatusOK, map[string]any{"active": false})
		return
	}
	relay := s.relayMgr.Active()
	if relay == nil {
		writeJSON(w, http.StatusOK, map[string]any{"active": false})
		return
	}
	resp := relayResponse(relay)
	resp["active"] = true
	writeJSON(w, http.StatusOK, resp)
}

// handleRelayStop останавливает активный relay. Идемпотентно: 200 даже если
// relay не активен.
//
//	POST /api/relay/stop → 200
func (s *Server) handleRelayStop(w http.ResponseWriter, r *http.Request) {
	if !isLocalRequest(r) {
		writeJSON(w, http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	if s.relayMgr == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	if err := s.relayMgr.Stop(r.Context()); err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// relayResponse конвертирует *cloudrelay.Relay в JSON-friendly map.
// Включает costNote и turnUrl для фронта.
func relayResponse(r *cloudrelay.Relay) map[string]any {
	if r == nil {
		return map[string]any{}
	}
	turnURL := ""
	if r.PublicIP != "" && r.TURNPort > 0 {
		turnURL = "turn:" + r.PublicIP + ":" + strconv.Itoa(r.TURNPort)
	}
	return map[string]any{
		"id":         r.ID,
		"provider":   r.Provider,
		"region":     r.Region,
		"publicIP":   r.PublicIP,
		"turnPort":   r.TURNPort,
		"turnUrl":    turnURL,
		"turnUser":   r.TURNUser,
		"turnPass":   r.TURNPass,
		"createdAt":  r.CreatedAt,
		"destroyTTL": r.DestroyTTL,
		"costNote":   "≈ €0.006/час",
	}
}
