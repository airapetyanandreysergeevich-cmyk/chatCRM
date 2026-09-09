/**
 * Access-токен живёт только в памяти вкладки: в localStorage его положить нельзя —
 * оттуда его достанет любой скрипт на странице. Refresh лежит в httpOnly-куке,
 * до которой JavaScript не дотягивается вовсе.
 */
let accessToken: string | null = null;
let onLogout: (() => void) | null = null;

export const setAccessToken = (t: string | null) => {
  accessToken = t;
};
export const setLogoutHandler = (fn: (() => void) | null) => {
  onLogout = fn;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public fields?: Array<{ path: string; message: string }>
  ) {
    super(message);
  }
  /** Текст ошибки для конкретного поля формы. */
  field(path: string) {
    return this.fields?.find((f) => f.path === path)?.message;
  }
}

let refreshing: Promise<boolean> | null = null;

/** Обновление токена идёт одним запросом, даже если 401 прилетел сразу из нескольких мест. */
function refreshOnce(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch("/api/auth/refresh", { method: "POST", credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return false;
        const data = await res.json();
        accessToken = data.accessToken;
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

async function request<T>(path: string, init: RequestInit = {}, allowRetry = true): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  // Для FormData заголовок не ставим: браузер добавит его сам вместе с границей,
  // а наш application/json сломал бы разбор multipart на сервере.
  if (init.body && !(init.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(`/api${path}`, { ...init, headers, credentials: "include" });

  if (res.status === 401 && allowRetry && !path.startsWith("/auth/refresh") && !path.startsWith("/auth/login")) {
    if (await refreshOnce()) return request<T>(path, init, false);
    accessToken = null;
    onLogout?.();
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "Что-то пошло не так", data?.fields);
  return data as T;
}

/**
 * Имя файла из Content-Disposition. Сначала смотрим filename*= с кодировкой:
 * кириллица переживает пересылку только там, а обычный filename= сервер шлёт
 * ради старых браузеров и пишет в него латиницу.
 */
function fileNameFrom(headers: Headers): string {
  const raw = headers.get("Content-Disposition") ?? "";
  const encoded = raw.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      /* испорченное имя — возьмём запасное ниже */
    }
  }
  const plain = raw.match(/filename="([^"]+)"/i);
  return plain ? plain[1] : "finecrm-выгрузка";
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T,>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  put: <T,>(path: string, body: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  /** Загрузка файлов: тело — FormData, Content-Type ставит сам браузер вместе с границей. */
  upload: <T,>(path: string, form: FormData) => request<T>(path, { method: "POST", body: form }),
  /**
   * Скачивание файла. Отдельно от request: тот разбирает ответ как JSON,
   * а здесь нужен двоичный файл и имя из заголовка. Токен доступа живёт
   * в памяти вкладки, поэтому просто перейти по ссылке нельзя — запрос
   * должен нести заголовок авторизации, как и все остальные.
   */
  download: async (path: string): Promise<{ blob: Blob; fileName: string }> => {
    const headers: Record<string, string> = {};
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    let res = await fetch(`/api${path}`, { headers, credentials: "include" });
    if (res.status === 401 && (await refreshOnce())) {
      const retry: Record<string, string> = {};
      if (accessToken) retry.Authorization = `Bearer ${accessToken}`;
      res = await fetch(`/api${path}`, { headers: retry, credentials: "include" });
    }

    if (!res.ok) {
      const text = await res.text();
      let message = "Не удалось выгрузить";
      try {
        message = JSON.parse(text)?.error ?? message;
      } catch {
        /* сервер ответил не json — оставим общее сообщение */
      }
      throw new ApiError(res.status, message);
    }

    return { blob: await res.blob(), fileName: fileNameFrom(res.headers) };
  },
  del: <T,>(path: string) => request<T>(path, { method: "DELETE" }),
  refresh: refreshOnce,
};
