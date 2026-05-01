# ZubraMeet — контекст для Claude Code

> 📋 Правила ведения доков: `C:\Users\a.zubr\projects-history\RULES.md` (на Mac: `~/projects-history/RULES.md`)

## 🤖 Протокол при старте сессии

Этот файл подгружается автоматически в system prompt — никаких «Контекст: …» от юзера ждать не надо. На первом сообщении юзера выполни:

1. Прочитай `C:\Users\a.zubr\projects-history\RULES.md` (или `~/projects-history/RULES.md` на Mac)
2. Прочитай `C:\Users\a.zubr\projects-history\ZubraMeet\README.md`
3. Прочитай `C:\Users\a.zubr\projects-history\ZubraMeet\current-state.md`
4. Дай краткий summary (≤5 строк): где остановились, что в процессе, открытые баги
5. Жди вопрос. **Не** лезь в `architecture.md` / `decisions.md` / `troubleshooting.md` / `chat-log-summary.md`, пока не понадобятся

## О проекте

P2P-видеоконференции в духе Google Meet, где создатель мита становится локальным SFU-сервером для аудио/видео с адаптацией под скорость канала и поддержкой вплоть до 4K-стриминга. uTorrent-модель: один бинарник у хоста, гости заходят по ссылке через браузер.

- **Repo:** https://github.com/AntonZubritski/ZubraMeet
- **Local path (Win):** `C:\Users\a.zubr\projects\ZubraMeet\`
- **Доки (Win):** `C:\Users\a.zubr\projects-history\ZubraMeet\`
- **Доки (Mac):** `~/projects-history/ZubraMeet/`

## Архитектура

Один Go-бинарник = Pion SFU + сигналинг + HTTP-сервер с embedded React-билдом. Wails оборачивает в нативное окно. Тот же React-UI доступен по `localhost:7777` и удалённым гостям по invite-ссылке. Создатель мита = локальный SFU, форвардит всем участникам с adaptive bitrate.

## Стек

- **Бинарник хоста**: Go + Pion WebRTC (SFU) + Wails (нативное окно)
- **UI**: React + TypeScript + Vite — один билд на всех клиентов
- **Сигналинг**: WebSocket внутри Go-сервера
- **Адаптация качества**: WebRTC simulcast + VP9/AV1 SVC, мониторинг через `getStats()`
- **NAT traversal**: STUN + UPnP, TURN-fallback (Coturn) опционально

## Команда запуска Claude Code

```bash
claude --dangerously-skip-permissions --chrome
```

## Git — коммиты и пуши

Юзер один автор репозитория. **НЕ** добавлять `Co-Authored-By: Claude` или подобные строки в commit message. Использовать уже настроенного git-автора (`a.zubritski`). Это правило распространяется на все операции — `git commit`, `git push`, `gh pr create`.

## Обновить доки после сессии

Юзер скажет: «обнови документацию в projects-history/ZubraMeet/». Действия:

1. Перечитать `C:\Users\a.zubr\projects-history\RULES.md`
2. Обновить `current-state.md` (и другие MD по необходимости)
3. Если файл перерос лимит из RULES.md — trim по правилам там же
