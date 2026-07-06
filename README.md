<p align="center">
  <img src="app/icon.png" alt="ShotShorts Logo" width="128" height="128" />
</p>

<h1 align="center">ShotShorts</h1>

<p align="center">
  <strong>Генератор вертикальных коротких роликов из длинных видео и аудио</strong>
</p>

<p align="center">
  ShotShorts расшифровывает длинную запись, находит отдельные истории через AI и собирает готовые клипы для TikTok, YouTube Shorts и Reels.
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

ShotShorts берет длинное видео или аудио, извлекает речь через FFmpeg, делает полный транскрипт через **Groq Whisper**, отправляет текстовые блоки в **Groq Qwen** для поиска отдельных историй, а затем рендерит вертикальные клипы **1080x1920** с субтитрами и фоновыми видео.

Текущая версия использует один AI-провайдер: **Groq**. Можно добавить несколько Groq API ключей - приложение будет переключаться между ними при rate limit.

---

## AI-пайплайн

```text
Исходное видео или аудио
       |
       v
Извлечение аудио через FFmpeg
       |
       v
Подготовка аудио для Whisper
       |
       v
Транскрибация через Groq Whisper
       |
       v
Анализ транскрипта через qwen/qwen3.6-27b
       |
       v
Нормализация историй и нарезка на клипы
       |
       v
Рендер 1080x1920 с субтитрами и ADHD-фоном
```

---

## Быстрый старт

### Требования

- Windows 10/11 x64
- Node.js 20+
- FFmpeg в `PATH` или `app/resources/ffmpeg.exe`
- Один или несколько Groq API ключей

### Установка

```bash
npm install
```

### Запуск Electron-приложения

```bash
npm run app:start
```

### Сборка Windows `.exe`

Для сборки с локальными ресурсами нужны `ffmpeg.exe` и `ffprobe.exe` в `app/resources/`.
Prebuild-проверка попробует автоматически скопировать их из `PATH`; если FFmpeg не установлен в системе, build остановится до упаковки, чтобы не получить exe, который падает уже у пользователя.

```bash
npm run app:build
```

Готовое приложение появится в `Ready_App_EXE/win-unpacked/`, запускать нужно `Ready_App_EXE/win-unpacked/ShotShorts.exe`.
Эта папка является артефактом сборки и не хранится в Git.

Если сборка специально должна полагаться на системный FFmpeg, можно запустить ее с `SHOTSHORTS_ALLOW_UNBUNDLED_FFMPEG=1`, но такой билд уже не будет самодостаточным. Single-file portable target оставлен отдельной командой `npm run app:build:portable`, но с bundled FFmpeg он может быть очень тяжелым и медленным.

### Документация/сайт

```bash
npm run web:dev
```

---

## Использование

1. Выбери исходное видео или аудио.
2. Выбери папку с фоновыми видео.
3. Выбери папку для готовых роликов.
4. Добавь Groq API ключи во вкладке **Settings**.
5. Настрой субтитры, язык, модель Whisper и прокси при необходимости.
6. Нажми **Generate**.

Приложение само извлечет аудио, подготовит транскрипт, найдет истории, соберет клипы и сохранит результат в выбранную папку.

---

## Возможности

### AI и анализ

- Groq Whisper `whisper-large-v3` и `whisper-large-v3-turbo`
- Groq Qwen `qwen/qwen3.6-27b` для анализа транскрипта
- Несколько Groq API ключей с автоматическим обходом rate limit
- Разделение длинных историй на части
- Объединение коротких историй в клипы подходящей длины

### Субтитры

- Стили: Classic, Minimal, Highlight, TikTok Bold, Heavy Shadow, Soft Box
- Позиция: верх, центр или низ
- Настройка шрифта, размера, регистра, отступа и количества слов в строке
- Караоке-режим с подсветкой слов
- Рендер через ASS/FFmpeg или Playwright overlay

### Видео

- Вертикальный формат 1080x1920
- H.264, 30fps
- Случайный ADHD-фон без повторов подряд
- Автоматический подбор и кеширование шрифтов
- Защита от зависания последнего кадра фонового видео

### Приложение

- Английский и русский интерфейс
- Пресеты настроек
- HTTP/HTTPS/SOCKS5 прокси
- Прогресс, ETA и статистика рендера
- Хранение настроек через `electron-store`

---

## Структура проекта

```text
ShotShorts/
├── app/                         # Electron-приложение
│   ├── main.js                  # Главный процесс Electron
│   ├── preload.js               # Безопасный мост IPC
│   ├── launch.js                # Запуск приложения
│   ├── renderer/                # HTML/CSS/JS интерфейс
│   └── services/                # Основная логика
│       ├── process-handler.js   # Оркестрация генерации
│       ├── media-processor.js   # FFmpeg обработка аудио и видео
│       ├── whisper-service.js   # Транскрибация через Groq Whisper
│       ├── groq-story-analyzer.js # Анализ историй через Groq Qwen
│       ├── groq-key-utils.js    # Нормализация ключей и cooldown
│       ├── subtitle-renderer.js # Рендер субтитров
│       ├── font-manager.js      # Загрузка и кеш шрифтов
│       ├── store.js             # Настройки и статистика
│       └── cleanup.js           # Очистка временных файлов
├── web/                         # Next.js сайт документации
├── .agent/                      # Агентские инструкции и шаблоны
├── .github/                     # CI/CD workflows
├── AGENT_FLOW.md                # Описание агентской архитектуры
├── CHANGELOG.md                 # История изменений
├── package.json                 # Workspaces и команды проекта
└── README.md
```

Сгенерированные папки вроде `node_modules/`, `Ready_App_EXE/`, `app/dist/`, `.next/`, `dist/` и `build/` игнорируются Git.

---

## Безопасность

- Не коммить Groq API ключи, `.env` файлы, тестовые аудио и локальные сборки.
- Если ключ случайно попал в репозиторий, сразу перевыпусти его в Groq Console.
- Ключи добавляются через UI и хранятся локально в `electron-store`.

---

## Лицензия

MIT © [Deruk0](https://github.com/Deruk0)

<p align="center">
  <a href="https://github.com/Deruk0/ShotShorts">GitHub</a>
</p>
