# TOOLS.md — Локальные заметки Morty

Скиллы определяют _как_ работают инструменты.
Этот файл — _мои_ конкретные настройки: окружение, хосты, устройства, предпочтения.

---

## Окружение

- **Workspace:** `/home/app/futures-screener`
- **OS:** Linux (srv1321680)
- **Node.js:** v22.22.0
- **Стек проекта:** Fastify (server), vanilla JS (app/)
- **Git:** основная ветка `main`

## Сервер проекта

- **Entrypoint:** `server/index.js`
- **Зависимости:** `server/package.json` (Fastify ^5.7.4)
- **Модули:** `server/modules/binance/`, `server/modules/densities/`
- **Порт:** TBD (уточнить при первом запуске)

## Фронтенд

- **Файлы:** `app/index.html`, `app/app.js`, `app/styles.css`
- **Фреймворк:** vanilla JS (без сборщика)
- **Раздача:** через Fastify static или напрямую

## SSH

_(пока пусто — заполнить при необходимости)_

```
# Пример:
# home-server → 192.168.1.100, user: admin
```

## Камеры

_(пока пусто)_

```
# Пример:
# living-room → Main area, 180° wide angle
```

## TTS / Голос

_(пока пусто)_

```
# Пример:
# Preferred voice: "Nova"
# Default speaker: Kitchen HomePod
```

## Устройства / Ники

_(пока пусто)_

```
# Пример:
# phone → iPhone 15 Pro
# laptop → MacBook Pro M3
```

---

_Дополняй по мере появления новых ресурсов. Этот файл — моя шпаргалка._
