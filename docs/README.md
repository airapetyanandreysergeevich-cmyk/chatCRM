# Инструкция пользователя

`instrukciya.md` — текст. `instrukciya.pdf` — он же со снимками экрана, для печати
и для рассылки мастерским.

## Откуда берутся снимки

Экраны первого запуска (`shots/main.png`, `client.png`, `online.png`,
`working.png`) снимаются прямо с `desktop/src/setup.html` — это настоящий файл
программы, а не рисунок.

Экраны самой CRM сняты с настоящего собранного интерфейса (`frontend/dist`), но с
выдуманными данными: `mock/server.js` отвечает вместо базы. Так снимки можно
переснять в любой момент, не заводя демо-мастерскую и не показывая ничьи
настоящие заказы.

```bash
node mock/server.js          # витрина на http://127.0.0.1:4100
node mock/shoot.js           # обходит разделы и складывает снимки в shots/
```

`shoot.js` ходит headless-браузером; пути к Chromium и к playwright-core в нём
прописаны сверху — поправьте под свою машину.

## Как пересобрать PDF

```bash
chromium --headless --no-pdf-header-footer \
  --run-all-compositor-stages-before-draw --virtual-time-budget=15000 \
  --print-to-pdf=instrukciya.pdf instrukciya.html
```

Вёрстка живёт в `instrukciya.html`: A4, поля 18/16 мм, шрифт Carlito с запасным
DejaVu Sans — оба с кириллицей.
