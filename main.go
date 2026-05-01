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
	httpAddr := flag.String("http", ":7777", "HTTP listen address (localhost only)")
	httpsAddr := flag.String("https", ":7443", "HTTPS listen address (for guests)")
	upnp := flag.Bool("upnp", true, "Enable UPnP port mapping for internet access")
	flag.Parse()

	staticFS, err := fs.Sub(webDist, "web/dist")
	if err != nil {
		log.Fatalf("embed sub: %v", err)
	}

	srv := server.New(server.Config{
		HTTPAddr:   *httpAddr,
		HTTPSAddr:  *httpsAddr,
		Version:    Version,
		StaticFS:   staticFS,
		EnableUPnP: *upnp,
	})

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("ZubraMeet %s — HTTP %s, HTTPS %s, UPnP=%v", Version, *httpAddr, *httpsAddr, *upnp)
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
