<p align="center">
  <img src="logo.png" alt="ShotShorts Logo" width="128" height="128" />
</p>

<h1 align="center">ShotShorts</h1>

<p align="center">
  <strong>Генератор коротких видео с AI</strong>
</p>

<p align="center">
  <em>Автоматическое создание коротких видеороликов с использованием AI — генерация текста, озвучка, субтитры и монтаж</em>
</p>

<p align="center">
  <a href="https://github.com/Deruk0/ShotShorts/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" />
  </a>
</p>

<p align="center">
  <a href="https://buymeacoffee.com/vudovn" target="_blank">☕ Buy Me Coffee</a>
</p>

---

## ⚡ Быстрый старт

1. Установи зависимости:

```bash
cd app && npm install
```

2. Запусти приложение:

```bash
npm start
```

3. Или собери `.exe`:

```bash
npm run build
```

---

## 📂 Структура проекта

```
Ai Bot/
├── app/                    # Electron приложение
│   ├── main.js             # Главный процесс
│   ├── preload.js          # Preload скрипт
│   ├── renderer/           # UI фронтенда
│   │   ├── index.html
│   │   ├── app.js
│   │   └── styles.css
│   └── services/           # Бизнес-логика
│       ├── gemini-client.js    # AI генерация
│       ├── media-processor.js  # Обработка медиа
│       ├── process-handler.js  # Управление процессом
│       ├── store.js            # Хранилище
│       └── cleanup.js          # Очистка
├── web/                    # Документация сайт (Next.js)
├── .agent/                 # AI агент шаблоны
└── package.json
```

---

## 🛠️ Технологии

- **Electron** — десктопное приложение
- **Gemini AI** — генерация контента
- **FFmpeg** — обработка видео/аудио
- **Next.js** — сайт документации

---

## 📊 Возможности

- Генерация сценариев для коротких видео
- AI озвучка текста
- Автоматическое создание субтитров
- Монтаж и экспорт видео
- Поддержка нескольких языков

---

## 📄 Лицензия

MIT © [Deruk0](https://github.com/Deruk0)

<p align="center">
  <strong>Сделано для создателей контента</strong>
</p>

<p align="center">
  <a href="https://github.com/Deruk0/ShotShorts">GitHub</a>
</p>
