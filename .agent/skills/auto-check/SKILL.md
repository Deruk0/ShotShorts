---
name: auto-check
description: Automated validation of completed work. Runs checklist.py or verify_all.py to verify code quality, security, tests, and functionality. Use when: large refactoring, new modules/features, complex bug fixes, or before marking complex tasks as done. Skip for simple changes, typos, docs updates.
allowed-tools: Read, Glob, Grep, Bash
---

# Auto-Check Skill

> **RULE:** Run validation ONLY for complex tasks. Skip for simple changes.

### When to Run

**✅ ЗАПУСКАТЬ при:**
- Большой рефакторинг (изменение архитектуры, переименование модулей)
- Новый модуль/фича (добавление API, компонентов, страниц)
- Сложный баг-фикс (изменение логики, затронутое несколько файлов)
- Изменено 5+ файлов или 200+ строк
- Перед завершением сложной задачи

**❌ НЕ ЗАПУСКАТЬ при:**
- Исправление опечаток, форматирование
- Обновление документации
- Простые изменения конфигурации
- Добавление комментариев
- Изменения в 1-2 файлах < 50 строк

### Procedures

#### 1. Быстрая проверка (разработка)
```bash
python .agent/scripts/checklist.py .
```
Проверяет:
- P0: Безопасность (уязвимости, секреты)
- P1: Линтер и типы
- P2: Схема БД (если есть)
- P3: Тесты
- P4: UX аудит
- P5: SEO

#### 2. Полная проверка (перед релизом/деплоем)
```bash
python .agent/scripts/verify_all.py .
```
Всё из checklist + Lighthouse, Playwright E2E, Bundle Analysis, Mobile Audit

### Execution Flow

1. **Оцени сложность задачи:**
   - Простая → пропустить проверку
   - Сложная → перейти к шагу 2

2. **Запусти checklist.py:**
   ```bash
   python .agent/scripts/checklist.py .
   ```

3. **Проанализируй отчёт:**
   - ✅ Всё прошло → задача готова
   - ❌ Есть ошибки → исправь и повтори

4. **Если задача критичная (деплой, релиз):**
   ```bash
   python .agent/scripts/verify_all.py .
   ```

### Report Format

После проверки выведи отчёт:

```
## 📋 Результат проверки

| Check | Status | Notes |
|-------|--------|-------|
| Security | ✅/❌ | ... |
| Lint | ✅/❌ | ... |
| Types | ✅/❌ | ... |
| Tests | ✅/❌ | ... |
| UX | ✅/❌ | ... |

### Проблемы для исправления:
- [ ] ...

### Итого: ГОТОВО / ТРЕБУЕТ ИСПРАВЛЕНИЙ
```

### Error Handling

- Если скрипт не найден → проверь путь `.agent/scripts/`
- Если Python не установлен → предложи установить Python 3.8+
- Если тесты упали → проанализируй вывод, исправь, повтори
- Если нет тестов → отметь что тесты отсутствуют (не блокирует)
