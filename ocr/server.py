"""
Распознаватель шильдиков FineCRM.

Один маленький сервис с одной работой: принять снимок, вернуть строки текста
и прочитанные штрихкоды. Что из этого бренд, а что серийный номер, решает
backend (src/modules/plate/plate.parse.ts): правила разбора меняются чаще,
чем распознаватель, и проверяются там же, где остальной код.

Движок — RapidOCR (модели PaddleOCR в формате ONNX, Apache 2.0) и zxing-cpp
для штрихкодов. Всё работает на процессоре, снимки никуда не уходят.

Снимки обрабатываются строго по одному. Распознавание съедает ядро целиком,
и два одновременных снимка не станут быстрее — только оба медленнее. Очередь
здесь честнее: каждый ждёт, пока закончится предыдущий, а сайт на соседнем
ядре продолжает отвечать.

Порт наружу не открыт: к сервису ходит только backend по внутренней сети.
"""

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np
import zxingcpp
from rapidocr_onnxruntime import RapidOCR

PORT = int(os.environ.get("PORT", "8000"))
MAX_BYTES = int(os.environ.get("MAX_BYTES", str(12 * 1024 * 1024)))
# Длинная сторона снимка для распознавания текста. Больше — медленнее без
# выигрыша: мелкий шрифт шильдика читается уже на 2000 точках.
OCR_SIDE = int(os.environ.get("OCR_SIDE", "2000"))
# Для штрихкодов — побольше: тонкие полосы теряются при уменьшении первыми.
BARCODE_SIDE = int(os.environ.get("BARCODE_SIDE", "3000"))

engine = RapidOCR()
lock = threading.Lock()


def fit(img, side):
    h, w = img.shape[:2]
    k = side / max(h, w)
    if k >= 1:
        return img
    return cv2.resize(img, (int(w * k), int(h * k)), interpolation=cv2.INTER_AREA)


def read_barcodes(img):
    seen, out = set(), []
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # Второй проход по увеличенной копии: мелкий QR в углу шильдика на
    # исходном снимке часто не читается, а вдвое крупнее — читается.
    for variant in (gray, cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)):
        if max(variant.shape) > 5000:
            continue
        try:
            found = zxingcpp.read_barcodes(variant)
        except Exception:
            continue
        for b in found:
            text = (b.text or "").strip()
            if text and text not in seen:
                seen.add(text)
                out.append({"format": b.format.name, "text": text})
    return out


def recognize(data: bytes):
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Не удалось открыть снимок — это точно фотография?")

    small = fit(img, OCR_SIDE)
    h, w = small.shape[:2]
    result, _ = engine(small)
    lines = []
    for box, text, score in result or []:
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        lines.append(
            {
                "text": text,
                "score": round(float(score), 3),
                # Рамка в долях снимка: разбору важно, что рядом, а не пиксели.
                "box": [
                    round(min(xs) / w, 4),
                    round(min(ys) / h, 4),
                    round(max(xs) / w, 4),
                    round(max(ys) / h, 4),
                ],
            }
        )
    return {"lines": lines, "barcodes": read_barcodes(fit(img, BARCODE_SIDE))}


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "Нет такого адреса"})

    def do_POST(self):
        if self.path != "/recognize":
            return self._json(404, {"error": "Нет такого адреса"})
        size = int(self.headers.get("Content-Length") or 0)
        if size <= 0:
            return self._json(400, {"error": "Пустой снимок"})
        if size > MAX_BYTES:
            return self._json(413, {"error": "Снимок слишком большой"})
        data = self.rfile.read(size)

        waited = time.monotonic()
        with lock:
            started = time.monotonic()
            try:
                out = recognize(data)
            except ValueError as err:
                return self._json(400, {"error": str(err)})
            except Exception as err:  # noqa: BLE001 — сервис не должен падать от одного снимка
                return self._json(500, {"error": f"Распознаватель не справился: {err}"})
        out["ms"] = int((time.monotonic() - started) * 1000)
        out["queuedMs"] = int((started - waited) * 1000)
        self._json(200, out)

    def log_message(self, fmt, *args):
        # Без содержимого снимков и текста — только факт запроса.
        print("%s %s" % (self.command, self.path), flush=True)


if __name__ == "__main__":
    # Прогрев: первая загрузка моделей занимает пару секунд, и пусть это
    # будут секунды запуска контейнера, а не первого приёмщика.
    engine(np.full((64, 256, 3), 255, np.uint8))
    print(f"Распознаватель шильдиков слушает :{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
