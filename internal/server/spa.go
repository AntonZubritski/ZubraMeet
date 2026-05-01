package server

import (
	"io/fs"
	"net/http"
	"strings"
)

// handleSPA возвращает http.Handler для catch-all "/" роута.
//
// Поведение:
//  1. Если path начинается с /api/ или равен /ws (или /ws/...) — отдаёт 404,
//     чтобы случайно не отдать SPA на неизвестный API-эндпоинт.
//  2. Если StaticFS пуст (нет index.html) — отдаёт 503 с понятной подсказкой
//     для dev-режима: "запусти npm run build". Это нормально, когда фронт
//     ходит через Vite-прокси на :5173.
//  3. Если файл по path существует в StaticFS — отдаёт его через http.FileServer.
//  4. Иначе — отдаёт index.html (SPA-fallback для client-side routing).
func (s *Server) handleSPA() http.Handler {
	staticFS := s.cfg.StaticFS

	// indexAvailable — определяем единожды на старте, есть ли index.html в FS.
	// Если нет — все запросы к "/" получат 503 с devhint.
	indexAvailable := false
	if staticFS != nil {
		if _, err := fs.Stat(staticFS, "index.html"); err == nil {
			indexAvailable = true
		}
	}

	var fileServer http.Handler
	if staticFS != nil {
		fileServer = http.FileServer(http.FS(staticFS))
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Защита от случайного fall-through API-роутов: catch-all "/" в ServeMux
		// ловит всё, что не сматчилось точнее, включая неизвестные /api/foo.
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/ws" || strings.HasPrefix(r.URL.Path, "/ws/") {
			http.NotFound(w, r)
			return
		}

		if !indexAvailable {
			http.Error(
				w,
				"web bundle not built — run 'cd web && npm run build' first",
				http.StatusServiceUnavailable,
			)
			return
		}

		// Нормализуем path для fs.Stat: убираем leading "/", пустой путь = index.
		fsPath := strings.TrimPrefix(r.URL.Path, "/")
		if fsPath == "" {
			fsPath = "index.html"
		}

		if _, err := fs.Stat(staticFS, fsPath); err != nil {
			// Файла нет — это deep link SPA, отдаём index.html.
			serveIndex(w, staticFS)
			return
		}

		fileServer.ServeHTTP(w, r)
	})
}

// serveIndex отдаёт index.html из staticFS как text/html.
// Используется как fallback для client-side роутов SPA.
func serveIndex(w http.ResponseWriter, staticFS fs.FS) {
	data, err := fs.ReadFile(staticFS, "index.html")
	if err != nil {
		http.Error(w, "index.html not found", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(data)
}
