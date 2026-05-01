package main

import (
	"context"
	"flag"
	"io/fs"
	"log"
	"os/signal"
	"syscall"
	"time"

	"github.com/AntonZubritski/ZubraMeet/internal/server"
)

const Version = "0.1.0-dev"

func main() {
	addr := flag.String("addr", ":7777", "HTTP listen address")
	flag.Parse()

	staticFS, err := fs.Sub(webDist, "web/dist")
	if err != nil {
		log.Fatalf("embed sub: %v", err)
	}

	srv := server.New(server.Config{
		Addr:     *addr,
		Version:  Version,
		StaticFS: staticFS,
	})

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("ZubraMeet %s — listening on %s", Version, *addr)
		if err := srv.Run(ctx); err != nil {
			log.Fatalf("server: %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("shutting down...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}
