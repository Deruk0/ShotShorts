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

ShotShorts берёт длинное видео (например, подкаст или запись стрима), с помощью **NVIDIA Nemotron AI** находит в нём отдельные истории/сегменты и автоматически нарезает из них **вертикальные видео 1080×1920** с наложенным ADHD-фоном — готовый контент для TikTok, YouTube Shorts и Instagram Reels.

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
  Нарезка сегментов + склейка с ADHD-фоном
  → Вертикальное видео 1080×1920
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
   - Нарезает и соберёт вертикальные видео с фоном

---

## Функции

- **AI-анализ аудио** — NVIDIA Nemotron AI автоматически находит истории и определяет их границы
- **Автоматическая нарезка** — длинные истории (>7 мин) делятся на части
- **ADHD-фон** — случайные фоновые видео накладываются на каждый ролик
- **Вертикальный формат** — 1080×1920, идеально для TikTok / Shorts / Reels
- **Ротация API ключей** — если один ключ исчерпан, автоматически переключается на следующий
- **Прокси** — поддержка HTTP, HTTPS, SOCKS5
- **Прогресс-бар** — отображение текущего шага, процента и ETA
- **Статистика** — количество видео, время рендера, средний показатель

---

## Технологии

| Компонент | Назначение |
|:---|:---|
| **Electron** | Десктопное приложение |
| **OpenRouter / NVIDIA NIM** | Анализ аудио и поиск историй |
| **FFmpeg** | Извлечение аудио, нарезка, рендер видео |
| **fluent-ffmpeg** | Обёртка над FFmpeg для Node.js |

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
