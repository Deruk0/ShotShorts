<p align="center">
  <img src="logo.png" alt="Antigravity Kit Logo" width="128" height="128" />
</p>

<h1 align="center">Antigravity Kit</h1>

<p align="center">
  <strong>Agent templates with Skills, Agents, and Workflows</strong>
</p>

<p align="center">
  <em>Превращаем редактор кода в мощную систему с 20+ специалистами, 37+ навыками и 11 workflow для разработки любого уровня сложности</em>
</p>

<p align="center">
  <a href="https://github.com/vudovn/antigravity-kit/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" />
  </a>
  <a href="https://www.npmjs.com/package/@vudovn/ag-kit">
    <img src="https://img.shields.io/npm/v/@vudovn/ag-kit.svg?color=green" alt="npm version" />
  </a>
  <a href="https://unikorn.vn/p/antigravity-kit">
    <img src="https://img.shields.io/badge/Unikorn-Featured-purple.svg" alt="Featured on Unikorn" />
  </a>
  <a href="https://launch.j2team.dev/products/antigravity-kit">
    <img src="https://launch.j2team.dev/badge/antigravity-kit/dark" alt="J2TEAM Launch" />
  </a>
</p>

<p align="center">
  <a href="https://antigravity-kit.unikorn.vn/docs" target="_blank">Documentation</a> •
  <a href="https://antigravity-kit.unikorn.vn/docs/guide/examples/brainstorm" target="_blank">Web Example</a> •
  <a href="https://github.com/vudovn/antigravity-kit/issues" target="_blank">Issues</a> •
  <a href="https://buymeacoffee.com/vudovn" target="_blank">Buy Me Coffee</a>
</p>

---

## ⚡ Quick Start

Установи одной командой:

```bash
npx @vudovn/ag-kit init
```

Или установи глобально:

```bash
npm install -g @vudovn/ag-kit
ag-kit init
```

Это создаст папку `.agent` со всеми шаблонами в твоём проекте. **Никакой настройки — всё работает из коробки!**

---

## ✨ Компоненты

| Компонент | Количество | Описание |
|:---|:---:|:---|
| **Агенты** | **20** | Специалисты по фронтенду, бэкенду, безопасности, DevOps, QA и др. |
| **Скиллы** | **37** | Модули знаний: React, Node.js, базы данных, тестирование, дизайн и т.д. |
| **Воркфлоу** | **11** | Slash-команды для планирования, дебага, создания фич, деплоя |

### 🎯 Ключевые возможности

- **Автоматический роутинг агентов** — не нужно выбирать агента вручную. Система сама определяет нужного специалиста по запросу
- **Скиллы по требованию** — знания загружаются контекстуально, только когда нужны
- **Валидация кода** — встроенные скрипты проверяют безопасность, качество, тесты, UX, SEO
- **Мульти-агентная координация** — сложные задачи разбиваются между несколькими специалистами
- **50+ стилей дизайна** — UI-скилл с 50 стилями, 21 палитрой, 50 шрифтами

---

## 🚀 Установка

### Вариант 1: Быстрый (рекомендуется)

```bash
npx @vudovn/ag-kit init
```

### Вариант 2: Глобальная установка

```bash
npm install -g @vudovn/ag-kit
ag-kit init
```

### Вариант 3: Конкретная директория

```bash
ag-kit init --path ./myapp
```

### ⚠️ Важно про `.gitignore`

Если используешь **Cursor** или **Windsurf**, **НЕ добавляй** `.agent/` в `.gitignore` — это сломает индексацию воркфлоу и slash-команды (`/plan`, `/debug`) не появятся в автодополнении чата.

**Решение:** Добавь `.agent/` в локальный `.git/info/exclude` вместо `.gitignore`, чтобы папка не тречилась в Git, но редактор её видел.

---

## 💡 Как это работает

### Автоматическое определение агентов

**Не нужно упоминать агентов!** Просто опиши что нужно — система сама выберет специалиста:

```
Вы: "Добавь JWT аутентификацию"
Система: 🤖 Применяю @security-auditor + @backend-specialist...

Вы: "Почини кнопку тёмной темы"
Система: 🤖 Использую @frontend-specialist...

Вы: "Login возвращает 500 ошибку"
Система: 🤖 Запускаю @debugger для системного анализа...
```

**Как работает:**

1. Анализирует запрос
2. Определяет домен (фронтенд, бэкенд, безопасность и т.д.)
3. Выбирает лучшего специалиста
4. Показывает какой агент применяется
5. Загружает релевантные скиллы

### Slash-команды воркфлоу

Вызывай воркфлоу через `/`:

```
/brainstorm система аутентификации
/create лендинг с hero-секцией
/debug почему логин не работает
/deploy приложение на Vercel
/test генерация тестов для auth
```

---

## 🤖 Агенты (20 специалистов)

### 🎨 Фронтенд & Дизайн

| Агент | Фокус | Скиллы |
|:---|:---|:---|
| `frontend-specialist` | React, Next.js, Vue, UI/UX | react-best-practices, frontend-design, tailwind-patterns, web-design-guidelines |
| `ui-ux-pro-max` | 50 стилей дизайна | 50 styles, 21 palettes, 50 fonts |

### Бэкенд & API

| Агент | Фокус | Скиллы |
|:---|:---|:---|
| `backend-specialist` | API, бизнес-логика | api-patterns, nodejs-best-practices, nestjs-expert |
| `database-architect` | Схемы, SQL, оптимизация | database-design, prisma-expert |

### Мобайл & Игры

| Агент | Фокус | Скиллы |
|:---|:---|:---|
| `mobile-developer` | iOS, Android, React Native, Flutter | mobile-design |
| `game-developer` | Игровая логика, механики | game-development |

### Безопасность

| Агент | Фокус | Скиллы |
|:---|:---|:---|
| `security-auditor` | Аудит безопасности, OWASP | vulnerability-scanner |
| `penetration-tester` | Оффенсив-безопасность | red-team-tactics |

### DevOps & Инфраструктура

| Агент | Фокус | Скиллы |
|:---|:---|:---|
| `devops-engineer` | CI/CD, Docker, деплой | docker-expert, deployment-procedures, server-management |

### Тестирование & QA

| Агент | Фокус | Скиллы |
|:---|:---|:---|
| `test-engineer` | Стратегии тестирования | testing-patterns, tdd-workflow, webapp-testing |
| `qa-automation-engineer` | E2E тесты, CI пайплайны | webapp-testing, testing-patterns |

### Дебаг & Производительность

| Агент | Фокус | Скиллы |
|:---|:---|:---|
| `debugger` | Поиск первопричин | systematic-debugging |
| `performance-optimizer` | Скорость, Web Vitals | performance-profiling |

### Планирование & Документация

| Агент | Фокус | Скиллы |
|:---|:---|:---|
| `project-planner` | Discovery, планирование | brainstorming, plan-writing, architecture |
| `product-manager` | Требования, user stories | plan-writing, brainstorming |
| `product-owner` | Стратегия, backlog, MVP | plan-writing, brainstorming |
| `documentation-writer` | Документация, мануалы | documentation-templates |

### SEO & Рост

| Агент | Фокус | Скиллы |
|:---|:---|:---|
| `seo-specialist` | Ранжирование, видимость | seo-fundamentals, geo-fundamentals |

### Координация & Анализ

| Агент | Фокус | Скиллы |
|:---|:---|:---|
| `orchestrator` | Мульти-агентная координация | parallel-agents, behavioral-modes |
| `code-archaeologist` | Легаси-код, рефакторинг | clean-code, code-review-checklist |
| `explorer-agent` | Анализ кодовой базы | - |

---

## Скиллы (37 модулей знаний)

Скиллы загружаются **автоматически** по контексту задачи. Система читает описания скиллов и применяет релевантные знания.

### Фронтенд & UI

| Скилл | Описание |
|:---|:---|
| `react-best-practices` | React & Next.js оптимизация (Vercel — 57 правил) |
| `web-design-guidelines` | UI-аудит — 100+ правил доступности, UX, производительности |
| `tailwind-patterns` | Утилиты Tailwind CSS v4 |
| `frontend-design` | UI/UX паттерны, дизайн-системы |
| `ui-ux-pro-max` | 50 стилей, 21 палитра, 50 шрифтов |

### ⚙️ Бэкенд & API

| Скилл | Описание |
|:---|:---|
| `api-patterns` | REST, GraphQL, tRPC |
| `nestjs-expert` | NestJS модули, DI, декораторы |
| `nodejs-best-practices` | Node.js async, модули |
| `python-patterns` | Python стандарты, FastAPI |
| `rust-pro` | Мастер Rust 1.75+ |

### 🗄️ Базы данных

| Скилл | Описание |
|:---|:---|
| `database-design` | Проектирование схем, оптимизация |
| `prisma-expert` | Prisma ORM, миграции |

### TypeScript/JavaScript

| Скилл | Описание |
|:---|:---|
| `typescript-expert` | Type-level программирование, производительность |

### ☁️ Облако & Инфраструктура

| Скилл | Описание |
|:---|:---|
| `docker-expert` | Контейнеризация, Compose |
| `deployment-procedures` | CI/CD, воркфлоу деплоя |
| `server-management` | Управление инфраструктурой |

### 🧪 Тестирование & Качество

| Скилл | Описание |
|:---|:---|
| `testing-patterns` | Jest, Vitest, стратегии |
| `webapp-testing` | E2E, Playwright |
| `tdd-workflow` | Test-driven development |
| `code-review-checklist` | Стандарты код-ревью |
| `lint-and-validate` | Линтинг, валидация |

### 🔒 Безопасность

| Скилл | Описание |
|:---|:---|
| `vulnerability-scanner` | Аудит безопасности, OWASP |
| `red-team-tactics` | Оффенсив-безопасность |

### 📐 Архитектура & Планирование

| Скилл | Описание |
|:---|:---|
| `app-builder` | Фулстек- scaffold приложений |
| `architecture` | Паттерны системного дизайна |
| `plan-writing` | Планирование задач, декомпозиция |
| `brainstorming` | Сократовский диалог |

### 📱 Мобайл & Игры

| Скилл | Описание |
|:---|:---|
| `mobile-design` | Мобильные UI/UX паттерны |
| `game-development` | Игровая логика, механики |

### 📈 SEO & Рост

| Скилл | Описание |
|:---|:---|
| `seo-fundamentals` | SEO, E-E-A-T, Core Web Vitals |
| `geo-fundamentals` | Оптимизация для GenAI |

### 💻 Shell/CLI

| Скилл | Описание |
|:---|:---|
| `bash-linux` | Linux команды, скрипты |
| `powershell-windows` | Windows PowerShell |

### 🔧 Инструменты

| Скилл | Описание |
|:---|:---|
| `clean-code` | Стандарты кода (глобальное) |
| `behavioral-modes` | Персоны агентов |
| `parallel-agents` | Мульти-агентные паттерны |
| `mcp-builder` | Model Context Protocol |
| `documentation-templates` | Форматы документации |
| `i18n-localization` | Интернационализация |
| `performance-profiling` | Web Vitals, оптимизация |
| `systematic-debugging` | Траблшутинг |

---

## 🔄 Воркфлоу (11 slash-команд)

Вызывай воркфлоу командой `/`:

| Команда | Описание | Пример |
|:---|:---|:---|
| `/brainstorm` | Исследование вариантов до реализации | `/brainstorm система аутентификации` |
| `/create` | Создание новых фич или приложений | `/create лендинг с hero-секцией` |
| `/debug` | Системный дебаг | `/debug почему логин не работает` |
| `/deploy` | Деплой приложения | `/deploy на Vercel` |
| `/enhance` | Улучшение существующего кода | `/enhance производительность API` |
| `/orchestrate` | Мульти-агентная координация | `/orchestrate фулстек e-commerce` |
| `/plan` | Создание плана задач | `/plan архитектура микросервисов` |
| `/preview` | Превью изменений локально | `/preview` |
| `/status` | Проверка статуса проекта | `/status` |
| `/test` | Генерация и запуск тестов | `/test auth flow` |
| `/ui-ux-pro-max` | Дизайн с 50 стилями | `/ui-ux-pro-max dashboard в стиле glassmorphism` |

### Когда использовать

```
/brainstorm     → Непонятные требования, нужно изучить варианты
/create         → Новая фича, малая-средняя сложность
/orchestrate    → Фулстек фичи, сложные мульти-степ задачи
/debug          → Баг-репорты, неожиданное поведение
/test           → Нужно покрытие тестами, перед деплоем
/deploy         → Готово к продакшену, нужны production URL
/plan           → Большие проекты, командная координация
```

---

## 🏗️ Архитектура

### Структура директорий

```
.agent/
├── agents/          # 20 специалистов-агентов
├── skills/          # 37 модулей знаний
├── workflows/       # 11 slash-команд
├── rules/           # Глобальные правила
├── scripts/         # Мастер-скрипты валидации
└── ARCHITECTURE.md  # Полная документация архитектуры
```

### Протокол загрузки скиллов

```
Запрос пользователя → Совпадение с описанием скилла → Загрузка SKILL.md
                                                            ↓
                                                   Чтение references/
                                                            ↓
                                                   Чтение scripts/
                                                            ↓
                                                   Применение знаний
```

### Pipeline валидации

**Быстрая проверка (в разработке):**

```bash
python .agent/scripts/checklist.py .
```

- Security scan (уязвимости, секреты)
- Code quality (ESLint, TypeScript)
- Schema validation (Prisma/DB)
- Test suite (unit-тесты)
- UX audit (доступность)
- SEO check (мета-теги, производительность)

**Полная верификация (перед деплоем):**

```bash
python .agent/scripts/verify_all.py . --url http://localhost:3000
```

- Все быстрые проверки +
- Lighthouse (Core Web Vitals)
- Playwright E2E тесты
- Bundle analysis (размер, tree-shaking)
- Mobile audit (responsive, touch targets)
- i18n check (переводы, локаль)

---

## 🛠️ CLI команды

| Команда | Описание |
|:---|:---|
| `ag-kit init` | Установка `.agent` папки в проект |
| `ag-kit update` | Обновление до последней версии |
| `ag-kit status` | Проверка статуса установки |

### Флаги

```bash
ag-kit init --force        # Перезаписать существующую .agent папку
ag-kit init --path ./myapp # Установить в конкретную директорию
ag-kit init --branch dev   # Использовать конкретную ветку
ag-kit init --quiet        # Подавить вывод (для CI/CD)
ag-kit init --dry-run      # Предпросмотр без выполнения
```

---

## 📊 Статистика

| Метрика | Значение |
|:---|:---|
| **Всего агентов** | 20 |
| **Всего скиллов** | 37 |
| **Всего воркфлоу** | 11 |
| **Мастер-скриптов** | 2 (checklist, verify_all) |
| **Скилл-скриптов** | 18 |
| **Покрытие** | ~90% веб/мобайл разработки |

### Поддерживаемые фреймворки

```
Фронтенд:  React, Next.js, Vue, Nuxt, Astro
Бэкенд:    Node.js, NestJS, FastAPI, Express
Мобайл:    React Native, Flutter
Базы:      Prisma, TypeORM, Sequelize
Тесты:     Jest, Vitest, Playwright, Cypress
DevOps:    Docker, Vercel, AWS, GitHub Actions
Языки:     TypeScript, JavaScript, Python, Rust
```

---

## 📚 Документация

- **[Web App Example](https://antigravity-kit.unikorn.vn/docs/guide/examples/brainstorm)** — Пошаговый гайд по созданию веб-приложения
- **[Online Docs](https://antigravity-kit.unikorn.vn/docs)** — Полная документация онлайн
- **[Architecture](.agent/ARCHITECTURE.md)** — Детальная архитектура системы
- **[Agent Flow](AGENT_FLOW.md)** — Схема работы и роутинг агентов

---

## ☕ Поддержать проект

<p align="center">
  <a href="https://buymeacoffee.com/vudovn">
    <img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee" width="250" />
  </a>
</p>

<p align="center"> - или - </p>

<p align="center">
  <img src="https://img.vietqr.io/image/mbbank-0779440918-compact.jpg" alt="Buy me coffee" width="200" />
</p>

---

## 📄 Лицензия

MIT © [Vudovn](https://github.com/vudovn)

<p align="center">
  <strong>Сделано для разработчиков</strong>
</p>

<p align="center">
  <a href="https://github.com/vudovn/antigravity-kit">GitHub</a> •
  <a href="https://antigravity-kit.unikorn.vn/docs">Docs</a> •
  <a href="https://unikorn.vn/p/antigravity-kit">Unikorn</a> •
  <a href="https://launch.j2team.dev/products/antigravity-kit">J2TEAM Launch</a>
</p>
