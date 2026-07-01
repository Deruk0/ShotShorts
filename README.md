<p align="center">
  <img src="app/icon.png" alt="ShotShorts Logo" width="128" height="128" />
</p>

<h1 align="center">ShotShorts</h1>

<p align="center">
  <strong>Генератор коротких видеороликов из длинных видео</strong>
</p>

<p align="center">
  <em>Автоматически находит истории в длинных видео с помощью AI и создаёт вертикальные ролики для TikTok, YouTube Shorts и Reels с ADHD-фоном</em>
</p>

<p align="center">
  <a href="https://github.com/Deruk0/ShotShorts/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" />
  </a>
  <a href="https://github.com/Deruk0/ShotShorts/releases">
    <img src="https://img.shields.io/badge/platform-Windows-lightgrey" alt="Platform" />
  </a>
</p>

---

## Что делает приложение



---

## Как это работает

```
Длинное видео
       │
       ▼
  Извлечение аудио (FFmpeg)
       │
       ▼
  AI анализ аудио (NVIDIA Nemotron AI)
  → Находит истории и их таймкоды
       │
       ▼
  Транскрибация каждого сегмента (Whisper)
  → Текст + таймкоды для субтитров
       │
       ▼
  Наложение субтитров + ADHD-фон
  + Склейка в вертикальный формат 1080×1920
       │
       ▼
  Готовые ролики для TikTok / Shorts / Reels
```

---

## Быстрый старт

### Установка

```bash
cd app && npm install
```

### Запуск

```bash
npm start
```

### Сборка .exe

```bash
npm run build
```

Готовый `.exe` появится в папке `Ready_App_EXE/`.

---

## Использование

1. **Выбери исходное видео** — длинный ролик с историями/подкастом
2. **Выбери папку с ADHD-фоном** — коллекция фоновых видео (gameplay, parkour, subway surfers и т.д.)
3. **Выбери папку вывода** — куда сохранять готовые ролики
4. **Нажми Generate** — приложение само:
   - Извлечёт аудио
   - Проанализирует его через AI
   - Найдёт все истории с таймкодами
   - Транскрибирует каждую историю через Whisper
   - Наложит субтитры и ADHD-фон
   - Соберёт готовые вертикальные видео

---

## Функции

### 🤖 AI и анализ
- **AI-анализ аудио** — NVIDIA Nemotron AI находит истории и определяет их границы
- **Два провайдера** — OpenRouter или NVIDIA NIM с автоматической ротацией ключей при лимитах
- **Умная нарезка** — короткие истории (<2 мин) объединяются, длинные (>5 мин) делятся на части

### 🎤 Субтитры (Whisper)
- **Whisper транскрибация** — через Groq API (whisper-large-v3 или v3-turbo)
- **Языки** — русский, английский, украинский, немецкий, испанский, французский
- **6 стилей субтитров** — Classic, Minimal, Highlight, TikTok Bold, Heavy Shadow, Soft Box
- **Кастомизация** — положение (снизу/середина/сверху), шрифт (Inter/JetBrains Mono/Montserrat/Oswald), размер, регистр, отступ
- **Караоке-режим** — подсветка слов по очереди с эффектами (highlight, red box, caps)
- **Живой предпросмотр** — субтитры отображаются в реальном времени при настройке

### 🎬 Видео
- **ADHD-фон** — случайные фоновые видео из выбранной папки, без повторов подряд
- **Вертикальный формат** — 1080×1920, H.264, 30fps, готово для TikTok / Shorts / Reels
- **Автоматическая загрузка шрифтов** — Google Fonts скачиваются и кешируются при первом запуске
- **Продвинутый рендер субтитров** — Playwright/Chromium для pixel-perfect наложения или ASS-оверлей

### 🛠 Приложение
- **Двуязычный интерфейс** — английский / русский
- **Прокси** — HTTP, HTTPS, SOCKS5
- **Прогресс-бар** — шаг, проценты, ETA, детекция зависаний
- **Статистика** — количество видео, время рендера, среднее, время последнего запуска
- **Безопасность** — context isolation, key masking в UI, Content Security Policy

---

## Технологии

| Компонент | Назначение |
|:---|:---|
| **Electron** | Десктопное приложение |
| **Electron** | Десктопное приложение |
| **OpenRouter / NVIDIA NIM** | Анализ аудио и поиск историй |
| **Groq / Whisper** | Транскрибация речи в текст (whisper-large-v3 / v3-turbo) |
| **FFmpeg** | Извлечение аудио, нарезка, рендер видео, наложение субтитров |
| **fluent-ffmpeg** | Обёртка над FFmpeg для Node.js |
| **Playwright / Chromium** | Рендер субтитров с alpha-каналом |
| **electron-store** | Хранение настроек |

---

## Структура проекта

```
ShotShorts/
├── app/                        # Electron приложение
│   ├── main.js                 # Главный процесс
│   ├── preload.js              # Preload скрипт
│   ├── launch.js               # Точка входа
│   ├── icon.png / icon.svg     # Иконки
│   ├── renderer/               # UI
│   │   ├── index.html          # Разметка
│   │   ├── app.js              # Логика интерфейса
│   │   └── styles.css          # Стили
│   ├── services/               # Бизнес-логика
│   │   ├── process-handler.js  # Управление процессом генерации
│   │   ├── media-processor.js  # FFmpeg обработка видео/аудио
│   │   ├── openrouter-client.js # Работа с OpenRouter API
│   │   ├── nvidia-client.js    # Работа с NVIDIA NIM API
│   │   ├── base-audio-client.js # Базовый аудио-клиент (ротация ключей, retry)
│   │   ├── whisper-service.js  # Транскрибация аудио через Whisper
│   │   ├── subtitle-renderer.js # Рендер субтитров
│   │   ├── font-manager.js     # Управление шрифтами
│   │   ├── store.js            # Хранилище настроек и статистики
│   │   └── cleanup.js          # Очистка временных файлов
│   └── dist/                   # Скомпилированные файлы
├── web/                        # Сайт документации (Next.js)
├── .agent/                     # AI агент шаблоны
├── CHANGELOG.md                # История изменений
├── AGENT_FLOW.md               # Архитектура AI агентов
├── logo.png                    # Логотип
├── Ready_App_EXE/              # Собранные .exe файлы
└── package.json                # Корневой package.json (workspaces)
```

---

## Настройки

Вкладка **Settings** в приложении:

- **API Provider** — выбери провайдер: OpenRouter или NVIDIA NIM
- **OpenRouter / NVIDIA NIM API Keys** — добавь один или несколько API ключей. Ключи переключаются автоматически при лимитах.
  - **OpenRouter**: ключи `sk-or-v1-…` на [openrouter.ai](https://openrouter.ai/)
  - **NVIDIA NIM**: ключи `nvapi-…` на [build.nvidia.com](https://build.nvidia.com/)
- **Proxy** — настрой прокси если нужен (HTTP/HTTPS/SOCKS5)
- **Statistics** — статистика использования приложения

---

## Требования

- **Windows 10/11** (x64)
- **FFmpeg** — можно установить отдельно или положить `ffmpeg.exe` в папку `app/resources/`
- **OpenRouter или NVIDIA NIM API ключ** — бесплатный на [OpenRouter](https://openrouter.ai/) или [NVIDIA NIM](https://build.nvidia.com/)

---

## 📄 Лицензия

MIT © [Deruk0](https://github.com/Deruk0)

<p align="center">
  <a href="https://github.com/Deruk0/ShotShorts">GitHub</a>
</p>
