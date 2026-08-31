# Changelog

All notable changes to ShotShorts will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Интерстишл-режим баннера** — режим «Pause video & play banner with sound»: через каждые N секунд ролик ставится на паузу (стоп-кадр + тишина), поверх проигрывается видео-баннер **со своим звуком**, затем контент продолжается с места паузы. Длительность паузы равна **длительности самого видео-баннера** (настройка не нужна), клип удлиняется на суммарное время пауз; субтитры сдвигаются по таймлайну, а те, что пересекают начало паузы, обрезаются ровно в момент появления баннера; работает в обоих путях рендера — основном (concat) и фолбэке (loop одного фона) (`planInterstitialSegments` / `buildInterstitialFilterGraph` в `banner-utils.js`)
- **Цепочки фолбэков моделей** — для транскрибации и анализа собираются упорядоченные цепочки: если модель упёрлась в rate limits или её ключ/ID отвергнут (429/401/403/404), следующая модель в цепочке подхватывает автоматически, переключение «липкое» и действует до конца запуска, в том числе между чанками длинного аудио
- **Провайдеры с общим ключом** — секция «Custom AI Models» разделена на три шага: провайдер (Base URL + API ключ) → модели (привязаны к провайдеру, сколько угодно моделей на один ключ) → цепочки фолбэков (добавление, перемещение ↑↓, удаление). Старые настройки с моделями «каждая со своим ключом» мигрируют автоматически, одиночные выборы моделей становятся цепочками из одного элемента

### Changed
- **Секции моделей сворачиваются** — «Providers», «Models» и «Fallback chains» в настройках складываются/разворачиваются кликом по заголовку, состояние запоминается между сессиями; в заголовках списков отображается количество записей
- **Цепочки в два столбца** — каждая запись цепочки показывает название провайдера и имя модели (без технического ID) в двух колонках: при сжатии окна текст обрезается с многоточием, при растяжении остаётся свободное место; селекторы цепочек тоже показывают только имена моделей
- **Переработаны промпты анализа историй** — контракт вынесен в system-роль (её раньше не было), user-сообщение несёт только данные (core range, таймкоды, блоки). Промпт объясняет цель (standalone вертикальные клипы), требует группировать мини-анекдоты одной темы в одну дугу и включает самопроверку перед выводом; длительность историй промптом не задаётся — разделение по 1:30/5:00 остаётся заботой системы компоновки. Убраны стилистические примеры границ
- Исправлено: склеенные клипы называются по **первой** истории вместо «Тема A + Тема B»
- **Убран раздел «Groq API Keys»** — кастомные модели стали единственным способом подключить AI: любой OpenAI-совместимый провайдер (включая Groq — просто добавь `https://api.groq.com/openai/v1` как Base URL). Селекторы транскрибации и анализа больше не содержат встроенных моделей; генерация требует собранные цепочки транскрибации и анализа
- Исправлено: кнопки «Добавить» в цепочках транскрибации/анализа не активировались при выборе модели в выпадающем списке (не было обработчика `change` на селекте)
- Очистка настроек: из хранилища удалены `apiKeys`, `groqApiKey` и `apiProvider`; старые значения игнорируются, модельные выборы сбрасываются на пустые
- **Свободная позиция субтитров** — текст перетаскивается прямо в живом превью как баннер: невидимые точки-фиксаторы по центру и краям обеих осей, угловая точка масштабирует текст пропорционально (обе оси сразу, без искажений). В рендере позиция ставится через ASS `\pos()` с центр-анкором; классические «Позиция/Отступ» при этом игнорируются
- **Рекламный баннер** — поверх каждого клипа можно наложить фото или видео **любого формата** (mp4, mov, webm, mkv, avi, wmv, flv, ts, 3gp, gif и т. д.; видео зацикливается автоматически, поворот из метаданных телефона учитывается). Видео-баннеры перед рендером нормализуются в чистый промежуточный файл (поворот, 30fps, чётные размеры, без аудио) — edit lists, VFR и экзотические кодеки больше не ломают воспроизведение; источники с альфа-каналом (ProRes 4444, VP9 alpha) идут напрямую с сохранением прозрачности. Позиция и размер задаются перетаскиванием в общем живом превью 1080x1920 вместе с субтитрами: боковые точки растягивают по осям по отдельности, угловая — масштабирует пропорционально без искажений (точки появляются при наведении), баннер можно выдвигать за край кадра, невидимые полоски-направляющие «прилипают» баннер к краям и центру по обеим осям, слайдер «Видимость» делает баннер полупрозрачным или полностью невидимым, кнопка «Сбросить» возвращает исходное положение. Настройки сохраняются и входят в пресеты (`banner-utils.js`, IPC `media:probe`, секция «Ad Banner» в настройках)
- **Нарезка и склейка историй** — новые модули `story-chunker` и `story-padding`: объединение соседних коротких историй, разделение длинных только по границам сегментов транскрипта, привязка краёв клипов к естественным паузам речи
- **Плавная чёткость превью** — новый селектор sharpness в интерфейсе (`renderer/sharp-select.js`)
- Расширено покрытие тестами: story-chunker, story-padding, groq-story-analyzer

### Removed
- Экспериментальная поддержка OpenRouter и NVIDIA NIM удалена — клиенты `base-audio-client.js`, `openrouter-client.js` и `nvidia-client.js` больше не поставляются. Пайплайн снова работает только через **Groq** (Whisper для транскрибации + Qwen для анализа)


## [2.0.2] - 2026-02-04
- **New Skills**:
    - `rust-pro` - Master Rust 1.75+ 
- **Agent Workflows**:
    - Updated `orchestrate.md` fix output turkish


## [2.0.1] - 2026-01-26

### Added

- **Agent Flow Documentation**: New comprehensive workflow documentation
    - Added `.agent/AGENT_FLOW.md` - Complete agent flow architecture guide
    - Documented Agent Routing Checklist (mandatory steps before code/design work)
    - Documented Socratic Gate Protocol for requirement clarification
    - Added Cross-Skill References pattern documentation
- **New Skills**:
    - `react-best-practices` - Consolidated Next.js and React expertise
    - `web-design-guidelines` - Professional web design standards and patterns

### Changed

- **Skill Consolidation**: Merged `nextjs-best-practices` and `react-patterns` into unified `react-best-practices` skill
- **Architecture Updates**:
    - Enhanced `.agent/ARCHITECTURE.md` with improved flow diagrams
    - Updated `.agent/rules/GEMINI.md` with Agent Routing Checklist
- **Agent Updates**:
    - Updated `frontend-specialist.md` with new skill references
    - Updated `qa-automation-engineer.md` with enhanced testing workflows
- **Frontend Design Skill**: Enhanced `frontend-design/SKILL.md` with cross-references to `web-design-guidelines`

### Removed

- Deprecated `nextjs-best-practices` skill (consolidated into `react-best-practices`)
- Deprecated `react-patterns` skill (consolidated into `react-best-practices`)

### Fixed

- **Agent Flow Accuracy**: Corrected misleading terminology in AGENT_FLOW.md
    - Changed "Parallel Execution" → "Sequential Multi-Domain Execution"
    - Changed "Integration Layer" → "Code Coherence" with accurate description
    - Added reality notes about AI's sequential processing vs. simulated multi-agent behavior
    - Clarified that scripts require user approval (not auto-executed)

## [2.0.0] - Unreleased

### Initial Release

- Initial release of ShotShorts
- 20 specialized AI agents
- 37 domain-specific skills
- 11 workflow slash commands
- CLI tool for easy installation and updates
- Comprehensive documentation and architecture guide

[Unreleased]: https://github.com/Deruk0/ShotShorts/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/Deruk0/ShotShorts/releases/tag/v2.0.0
