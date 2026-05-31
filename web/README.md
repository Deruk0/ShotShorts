# ShotShorts Web

Документационный сайт для [ShotShorts](https://github.com/Deruk0/ShotShorts), построенный на **Next.js**.

## Запуск

```bash
cd web
npm install
npm run dev
```

Сайт будет доступен по адресу `http://localhost:3000`.

## Сборка

```bash
npm run build
npm start
```

## Docker

```bash
docker build -t shotshorts-web .
docker run -p 3000:3000 shotshorts-web
```

## Технологии

- **Next.js 16** — React-фреймворк
- **MDX** — документация в Markdown
- **Tailwind CSS 4** — стилизация
- **TypeScript** — типизация
