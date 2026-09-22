/**
 * Распознавание текста без сервера: PaddleOCR (PP-OCRv4) на onnxruntime.
 *
 * Это тот же конвейер, что у RapidOCR в облачном контейнере ocr, переписанный
 * без OpenCV: поиск строк (DB), поворот (cls), чтение (CRNN + CTC). Нужен
 * локальной версии для Windows: там нет облачного распознавателя, а Python
 * в установщик тащить незачем. Модели те же, поэтому и результат тот же —
 * это проверяет test/ocr-engine.ts на тех же шильдиках, что и разбор.
 *
 * Модуль ничего не знает ни о браузере, ни о Node: картинку ему дают
 * массивом точек, а модели запускает переданный `run`. Так его можно
 * проверить в Node и запускать в окне программы.
 */

/** Картинка RGBA — как ImageData из canvas. */
export interface Rgba {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export type ModelName = "det" | "cls" | "rec";

/** Запуск модели: плоский тензор и его размеры → плоский выход и его размеры. */
export type RunModel = (
  model: ModelName,
  data: Float32Array,
  dims: number[]
) => Promise<{ data: Float32Array; dims: readonly number[] }>;

export interface OcrLine {
  text: string;
  score: number;
  /** Рамка в долях снимка: [x0, y0, x1, y1]. */
  box: [number, number, number, number];
}

// Настройки RapidOCR 1.4.4 (config.yaml) — чтобы результат совпадал с облаком.
const MAX_SIDE = 2000;
const MIN_SIDE = 30;
const MIN_HEIGHT = 30;
const WH_RATIO = 8;
const DET_LIMIT = 736;
const DET_THRESH = 0.3;
const BOX_THRESH = 0.5;
const UNCLIP = 1.6;
const MAX_CANDIDATES = 1000;
const TEXT_SCORE = 0.5;
const CLS_H = 48;
const CLS_W = 192;
const CLS_THRESH = 0.9;
const REC_H = 48;
const REC_W = 320;
const BATCH = 6;

// ------------------------------------------------------------ картинка BGR

/** Трёхканальная картинка, каналы в порядке BGR — как у OpenCV. */
interface Bgr {
  data: Uint8Array;
  width: number;
  height: number;
}

function toBgr(img: Rgba): Bgr {
  const n = img.width * img.height;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = img.data[i * 4 + 2];
    out[i * 3 + 1] = img.data[i * 4 + 1];
    out[i * 3 + 2] = img.data[i * 4];
  }
  return { data: out, width: img.width, height: img.height };
}

/** Билинейное масштабирование с выравниванием по центрам точек, как cv2.resize. */
function resize(src: Bgr, w: number, h: number): Bgr {
  const out = new Uint8Array(w * h * 3);
  const sx = src.width / w;
  const sy = src.height / h;
  for (let y = 0; y < h; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    let y0 = Math.floor(fy);
    if (y0 > src.height - 1) y0 = src.height - 1;
    const y1 = Math.min(y0 + 1, src.height - 1);
    const dy = fy - y0;
    for (let x = 0; x < w; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      let x0 = Math.floor(fx);
      if (x0 > src.width - 1) x0 = src.width - 1;
      const x1 = Math.min(x0 + 1, src.width - 1);
      const dx = fx - x0;
      const a = (y0 * src.width + x0) * 3;
      const b = (y0 * src.width + x1) * 3;
      const c = (y1 * src.width + x0) * 3;
      const d = (y1 * src.width + x1) * 3;
      const o = (y * w + x) * 3;
      for (let k = 0; k < 3; k++) {
        const top = src.data[a + k] + (src.data[b + k] - src.data[a + k]) * dx;
        const bottom = src.data[c + k] + (src.data[d + k] - src.data[c + k]) * dx;
        out[o + k] = Math.round(top + (bottom - top) * dy);
      }
    }
  }
  return { data: out, width: w, height: h };
}

/** Картинка → тензор 1×3×H×W, (x/255 − 0.5) / 0.5. */
function toTensor(img: Bgr, into?: Float32Array, offset = 0, padW = img.width): Float32Array {
  const plane = img.height * padW;
  const out = into ?? new Float32Array(3 * plane);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 3;
      const o = y * padW + x;
      for (let k = 0; k < 3; k++) out[offset + k * plane + o] = (img.data[i + k] / 255 - 0.5) / 0.5;
    }
  }
  return out;
}

function rotate180(img: Bgr): Bgr {
  const n = img.width * img.height;
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const j = n - 1 - i;
    out[j * 3] = img.data[i * 3];
    out[j * 3 + 1] = img.data[i * 3 + 1];
    out[j * 3 + 2] = img.data[i * 3 + 2];
  }
  return { data: out, width: img.width, height: img.height };
}

/** np.rot90 — поворот на 90° против часовой. */
function rotate90(img: Bgr): Bgr {
  const w = img.height;
  const h = img.width;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 3;
      const ny = img.width - 1 - x;
      const nx = y;
      const o = (ny * w + nx) * 3;
      out[o] = img.data[i];
      out[o + 1] = img.data[i + 1];
      out[o + 2] = img.data[i + 2];
    }
  }
  return { data: out, width: w, height: h };
}

// ------------------------------------------------------------ геометрия

type Pt = [number, number];

function hull(points: Pt[]): Pt[] {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

interface Rect {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Направление стороны w. */
  ux: number;
  uy: number;
}

/** Прямоугольник наименьшей площади вокруг выпуклой оболочки (cv2.minAreaRect). */
function minAreaRect(points: Pt[]): Rect {
  const hp = hull(points);
  if (hp.length === 1) return { cx: hp[0][0], cy: hp[0][1], w: 0, h: 0, ux: 1, uy: 0 };
  let best: Rect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hp.length; i++) {
    const a = hp[i];
    const b = hp[(i + 1) % hp.length];
    let ux = b[0] - a[0];
    let uy = b[1] - a[1];
    const len = Math.hypot(ux, uy);
    if (len === 0) continue;
    ux /= len;
    uy /= len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const q of hp) {
      const u = q[0] * ux + q[1] * uy;
      const v = -q[0] * uy + q[1] * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = { cx: cu * ux - cv * uy, cy: cu * uy + cv * ux, w: maxU - minU, h: maxV - minV, ux, uy };
    }
  }
  return best ?? { cx: hp[0][0], cy: hp[0][1], w: 0, h: 0, ux: 1, uy: 0 };
}

function corners(r: Rect): Pt[] {
  const hw = r.w / 2;
  const hh = r.h / 2;
  const vx = -r.uy;
  const vy = r.ux;
  return [
    [r.cx - hw * r.ux - hh * vx, r.cy - hw * r.uy - hh * vy],
    [r.cx + hw * r.ux - hh * vx, r.cy + hw * r.uy - hh * vy],
    [r.cx + hw * r.ux + hh * vx, r.cy + hw * r.uy + hh * vy],
    [r.cx - hw * r.ux + hh * vx, r.cy - hw * r.uy + hh * vy],
  ];
}

/** Углы по часовой, начиная с левого верхнего (как order_points_clockwise). */
function orderClockwise(pts: Pt[]): Pt[] {
  const xs = pts.slice().sort((a, b) => a[0] - b[0]);
  const left = xs.slice(0, 2).sort((a, b) => a[1] - b[1]);
  const right = xs.slice(2).sort((a, b) => a[1] - b[1]);
  return [left[0], right[0], right[1], left[1]];
}

/** Средняя вероятность внутри четырёхугольника (box_score_fast). */
function boxScore(prob: Float32Array, pw: number, ph: number, quad: Pt[]): number {
  const xmin = Math.max(0, Math.min(pw - 1, Math.floor(Math.min(...quad.map((q) => q[0])))));
  const xmax = Math.max(0, Math.min(pw - 1, Math.ceil(Math.max(...quad.map((q) => q[0])))));
  const ymin = Math.max(0, Math.min(ph - 1, Math.floor(Math.min(...quad.map((q) => q[1])))));
  const ymax = Math.max(0, Math.min(ph - 1, Math.ceil(Math.max(...quad.map((q) => q[1])))));
  // Сторона каждого ребра, на которой лежит центр, — «внутри».
  const cx = quad.reduce((s, q) => s + q[0], 0) / 4;
  const cy = quad.reduce((s, q) => s + q[1], 0) / 4;
  const edges = quad.map((a, i) => {
    const b = quad[(i + 1) % 4];
    const side = Math.sign((b[0] - a[0]) * (cy - a[1]) - (b[1] - a[1]) * (cx - a[0])) || 1;
    return { a, b, side };
  });
  let sum = 0;
  let n = 0;
  for (let y = ymin; y <= ymax; y++) {
    for (let x = xmin; x <= xmax; x++) {
      let inside = true;
      for (const { a, b, side } of edges) {
        const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
        if (c * side < -0.5 * Math.hypot(b[0] - a[0], b[1] - a[1])) {
          inside = false;
          break;
        }
      }
      if (inside) {
        sum += prob[y * pw + x];
        n += 1;
      }
    }
  }
  return n ? sum / n : 0;
}

/** Решение 8×8 для перспективного преобразования (getPerspectiveTransform). */
function perspective(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = [];
  const B: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    B.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    B.push(v);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [B[c], B[p]] = [B[p], B[c]];
    const d = A[c][c] || 1e-12;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      if (!f) continue;
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      B[r] -= f * B[c];
    }
  }
  return [...B.map((b, i) => b / A[i][i]), 1];
}

/** Вырезать строку по четырём углам и выпрямить (get_rotate_crop_image). */
function cropQuad(img: Bgr, q: Pt[]): Bgr {
  const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = Math.max(1, Math.floor(Math.max(dist(q[0], q[1]), dist(q[2], q[3]))));
  const h = Math.max(1, Math.floor(Math.max(dist(q[0], q[3]), dist(q[1], q[2]))));
  // Обратное преобразование: точка результата → точка снимка.
  const m = perspective(
    [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ],
    q
  );
  const out = new Uint8Array(w * h * 3);
  const W = img.width;
  const H = img.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const den = m[6] * x + m[7] * y + m[8];
      let sx = (m[0] * x + m[1] * y + m[2]) / den;
      let sy = (m[3] * x + m[4] * y + m[5]) / den;
      sx = Math.min(Math.max(sx, 0), W - 1);
      sy = Math.min(Math.max(sy, 0), H - 1);
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, W - 1);
      const y1 = Math.min(y0 + 1, H - 1);
      const dx = sx - x0;
      const dy = sy - y0;
      const o = (y * w + x) * 3;
      for (let k = 0; k < 3; k++) {
        const a = img.data[(y0 * W + x0) * 3 + k];
        const b = img.data[(y0 * W + x1) * 3 + k];
        const c = img.data[(y1 * W + x0) * 3 + k];
        const d = img.data[(y1 * W + x1) * 3 + k];
        out[o + k] = Math.round((a + (b - a) * dx) * (1 - dy) + (c + (d - c) * dx) * dy);
      }
    }
  }
  const crop = { data: out, width: w, height: h };
  return h / w >= 1.5 ? rotate90(crop) : crop;
}

// ------------------------------------------------------------ поиск строк

function findBoxes(prob: Float32Array, pw: number, ph: number, destW: number, destH: number): Pt[][] {
  // Порог и расширение 2×2 (use_dilation): dst(x,y) = max(src[y-1..y][x-1..x]).
  const raw = new Uint8Array(pw * ph);
  for (let i = 0; i < raw.length; i++) raw[i] = prob[i] > DET_THRESH ? 1 : 0;
  const bin = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const y0 = Math.max(0, y - 1);
      const x0 = Math.max(0, x - 1);
      bin[y * pw + x] = raw[y * pw + x] | raw[y * pw + x0] | raw[y0 * pw + x] | raw[y0 * pw + x0];
    }
  }

  // Связные области (8 соседей) и точки их границы.
  const seen = new Uint8Array(pw * ph);
  const stack: number[] = [];
  const boxes: Pt[][] = [];
  let candidates = 0;
  for (let start = 0; start < bin.length; start++) {
    if (!bin[start] || seen[start]) continue;
    if (candidates++ >= MAX_CANDIDATES) break;
    const edge: Pt[] = [];
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % pw;
      const y = (i - x) / pw;
      let border = x === 0 || y === 0 || x === pw - 1 || y === ph - 1;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= pw || ny >= ph) continue;
          const j = ny * pw + nx;
          if (!bin[j]) {
            if (!dx || !dy) border = true;
            continue;
          }
          if (!seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
      if (border) edge.push([x, y]);
    }

    const rect = minAreaRect(edge);
    if (Math.min(rect.w, rect.h) < 3) continue;
    const quad = corners(rect);
    if (boxScore(prob, pw, ph, quad) < BOX_THRESH) continue;

    // Расширение (unclip): для прямоугольника — на d с каждой стороны.
    const d = (rect.w * rect.h * UNCLIP) / (2 * (rect.w + rect.h));
    const grown: Rect = { ...rect, w: rect.w + 2 * d, h: rect.h + 2 * d };
    if (Math.min(grown.w, grown.h) < 5) continue;

    const box = corners(grown).map(
      ([x, y]) =>
        [
          Math.min(Math.max(Math.round((x / pw) * destW), 0), destW),
          Math.min(Math.max(Math.round((y / ph) * destH), 0), destH),
        ] as Pt
    );
    const ordered = orderClockwise(box).map(
      ([x, y]) => [Math.min(Math.max(Math.trunc(x), 0), destW - 1), Math.min(Math.max(Math.trunc(y), 0), destH - 1)] as Pt
    );
    const bw = Math.trunc(Math.hypot(ordered[0][0] - ordered[1][0], ordered[0][1] - ordered[1][1]));
    const bh = Math.trunc(Math.hypot(ordered[0][0] - ordered[3][0], ordered[0][1] - ordered[3][1]));
    if (bw <= 3 || bh <= 3) continue;
    boxes.push(ordered);
  }

  // Сверху вниз, в одной строке — слева направо (sorted_boxes).
  boxes.sort((a, b) => a[0][1] - b[0][1] || a[0][0] - b[0][0]);
  for (let i = 0; i < boxes.length - 1; i++) {
    for (let j = i; j >= 0; j--) {
      if (Math.abs(boxes[j + 1][0][1] - boxes[j][0][1]) < 10 && boxes[j + 1][0][0] < boxes[j][0][0]) {
        [boxes[j], boxes[j + 1]] = [boxes[j + 1], boxes[j]];
      } else break;
    }
  }
  return boxes;
}

// ------------------------------------------------------------ конвейер

function fitWidth(img: Bgr, h: number, maxW: number): Bgr {
  const ratio = img.width / img.height;
  const w = Math.min(Math.ceil(h * ratio), maxW);
  return resize(img, Math.max(1, w), h);
}

export async function recognizeText(image: Rgba, run: RunModel, characters: string[]): Promise<OcrLine[]> {
  let img = toBgr(image);
  const rawW = img.width;
  const rawH = img.height;

  // Длинная сторона не больше 2000, короткая не меньше 30.
  let ratioW = 1;
  let ratioH = 1;
  if (Math.max(img.width, img.height) > MAX_SIDE) {
    const k = MAX_SIDE / Math.max(img.width, img.height);
    const w = Math.round(Math.trunc(img.width * k) / 32) * 32 || 32;
    const h = Math.round(Math.trunc(img.height * k) / 32) * 32 || 32;
    ratioW = img.width / w;
    ratioH = img.height / h;
    img = resize(img, w, h);
  }
  if (Math.min(img.width, img.height) < MIN_SIDE) {
    const k = MIN_SIDE / Math.min(img.width, img.height);
    const w = Math.round(Math.trunc(img.width * k) / 32) * 32 || 32;
    const h = Math.round(Math.trunc(img.height * k) / 32) * 32 || 32;
    ratioW = img.width / w;
    ratioH = img.height / h;
    img = resize(img, w, h);
  }

  // Слишком вытянутую картинку дополняем полями сверху и снизу.
  let padTop = 0;
  if (img.height <= MIN_HEIGHT || img.width / img.height > WH_RATIO) {
    const newH = Math.max(Math.trunc(img.width / WH_RATIO), MIN_HEIGHT) * 2;
    padTop = Math.trunc(Math.abs(newH - img.height) / 2);
    const h = img.height + padTop * 2;
    const data = new Uint8Array(img.width * h * 3);
    data.set(img.data, padTop * img.width * 3);
    img = { data, width: img.width, height: h };
  }

  // Поиск строк.
  const k = Math.min(img.width, img.height) < DET_LIMIT ? DET_LIMIT / Math.min(img.width, img.height) : 1;
  const dw = Math.round(Math.trunc(img.width * k) / 32) * 32;
  const dh = Math.round(Math.trunc(img.height * k) / 32) * 32;
  if (dw <= 0 || dh <= 0) return [];
  const detIn = toTensor(resize(img, dw, dh));
  const det = await run("det", detIn, [1, 3, dh, dw]);
  const ph = det.dims[2];
  const pw = det.dims[3];
  const boxes = findBoxes(det.data, pw, ph, img.width, img.height);
  if (!boxes.length) return [];

  let crops = boxes.map((b) => cropQuad(img, b));

  // Перевёрнутые строки (cls).
  for (let s = 0; s < crops.length; s += BATCH) {
    const part = crops.slice(s, s + BATCH);
    const input = new Float32Array(part.length * 3 * CLS_H * CLS_W);
    part.forEach((c, i) => toTensor(fitWidth(c, CLS_H, CLS_W), input, i * 3 * CLS_H * CLS_W, CLS_W));
    const out = await run("cls", input, [part.length, 3, CLS_H, CLS_W]);
    part.forEach((c, i) => {
      const p0 = out.data[i * 2];
      const p1 = out.data[i * 2 + 1];
      if (p1 > p0 && p1 > CLS_THRESH) crops[s + i] = rotate180(c);
    });
  }

  // Чтение: пачками, отсортированными по ширине, как в RapidOCR.
  const order = crops.map((c, i) => ({ i, r: c.width / c.height })).sort((a, b) => a.r - b.r);
  const texts: Array<{ text: string; score: number }> = new Array(crops.length);
  for (let s = 0; s < order.length; s += BATCH) {
    const part = order.slice(s, s + BATCH);
    const maxRatio = Math.max(REC_W / REC_H, ...part.map((p) => p.r));
    const W = Math.trunc(REC_H * maxRatio);
    const input = new Float32Array(part.length * 3 * REC_H * W);
    part.forEach((p, n) => toTensor(fitWidth(crops[p.i], REC_H, W), input, n * 3 * REC_H * W, W));
    const out = await run("rec", input, [part.length, 3, REC_H, W]);
    const [, T, C] = out.dims;
    part.forEach((p, n) => {
      let text = "";
      let sum = 0;
      let count = 0;
      let prev = -1;
      for (let t = 0; t < T; t++) {
        let best = 0;
        let bestP = -Infinity;
        const base = (n * T + t) * C;
        for (let c = 0; c < C; c++) {
          const v = out.data[base + c];
          if (v > bestP) {
            bestP = v;
            best = c;
          }
        }
        if (best !== 0 && best !== prev) {
          text += characters[best] ?? "";
          sum += bestP;
          count += 1;
        }
        prev = best;
      }
      texts[p.i] = { text, score: count ? sum / count : 0 };
    });
  }

  const lines: OcrLine[] = [];
  boxes.forEach((b, i) => {
    const { text, score } = texts[i];
    if (!text || score < TEXT_SCORE) return;
    const xs = b.map((p) => p[0] * ratioW);
    const ys = b.map((p) => (p[1] - padTop) * ratioH);
    lines.push({
      text,
      score: Math.round(score * 1000) / 1000,
      box: [
        Math.round((Math.min(...xs) / rawW) * 1e4) / 1e4,
        Math.round((Math.min(...ys) / rawH) * 1e4) / 1e4,
        Math.round((Math.max(...xs) / rawW) * 1e4) / 1e4,
        Math.round((Math.max(...ys) / rawH) * 1e4) / 1e4,
      ],
    });
  });
  return lines;
}

/** Словарь модели чтения: пустой знак в начале, пробел в конце (CTCLabelDecode). */
export const charactersFrom = (keys: string): string[] => ["", ...keys.split(/\r?\n/), " "];
