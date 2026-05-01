.PHONY: all dev web go run build clean tidy

all: build

# Dev: запускает Vite на :5173 (с проксированием /api и /ws на :7777) и Go на :7777.
# Открывай http://localhost:5173 — там HMR.
dev:
	@echo ">> запусти в двух терминалах: 'make web' и 'make go'"

web:
	cd web && npm install && npm run dev

go:
	go run .

# Production build: web → web/dist → embed → один бинарник.
build:
	cd web && npm install && npm run build
	go build -o zubrameet.exe .

run: build
	./zubrameet.exe

tidy:
	go mod tidy

clean:
	rm -f zubrameet zubrameet.exe
	rm -rf web/dist/*
	touch web/dist/.gitkeep
