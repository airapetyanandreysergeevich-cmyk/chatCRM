package ru.finecrm.sms;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Запросы к FineCRM: JSON туда и обратно, ключ телефона — в заголовке
 * X-Phone-Token. Без библиотек: хватает того, что есть в самом Android.
 */
final class Http {
    private Http() {}

    /** Сервер больше не знает этот телефон: его отключили в настройках мастерской. */
    static final class Unauthorized extends Exception {
        Unauthorized(String message) {
            super(message);
        }
    }

    /** Сервер ответил отказом с объяснением — его и показываем. */
    static final class Refused extends IOException {
        final int code;

        Refused(int code, String message) {
            super(message);
            this.code = code;
        }
    }

    static JSONObject request(String method, String url, String token, JSONObject body, int readTimeoutMs)
            throws IOException, Unauthorized {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestMethod(method);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(readTimeoutMs);
            conn.setUseCaches(false);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("User-Agent", "FineCRM-SMS/" + BuildInfo.VERSION);
            if (token != null && !token.isEmpty()) conn.setRequestProperty("X-Phone-Token", token);
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                conn.setFixedLengthStreamingMode(bytes.length);
                OutputStream out = conn.getOutputStream();
                try {
                    out.write(bytes);
                } finally {
                    out.close();
                }
            }
            int code = conn.getResponseCode();
            InputStream in = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = in == null ? "" : read(in);
            JSONObject json;
            try {
                json = text.isEmpty() ? new JSONObject() : new JSONObject(text);
            } catch (JSONException e) {
                // Вместо ответа FineCRM пришла страница: адрес не тот или мешает сеть.
                throw new Refused(code, "По этому адресу отвечает не FineCRM (HTTP " + code + ")");
            }
            if (code == 401) throw new Unauthorized(json.optString("error", "Телефон отключён от мастерской"));
            if (code >= 400) throw new Refused(code, json.optString("error", "Сервер ответил ошибкой " + code));
            return json;
        } finally {
            conn.disconnect();
        }
    }

    private static String read(InputStream in) throws IOException {
        try {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            return new String(buf.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            in.close();
        }
    }

    /**
     * Адрес мастерской в привычный вид: «www.finecrm.ru/b/код» →
     * «https://www.finecrm.ru/b/код/». Голый IP в сети мастерской — по http.
     */
    static String normalizeBase(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return "";
        if (!s.startsWith("http://") && !s.startsWith("https://")) {
            boolean lan = s.matches("^(\\d{1,3}\\.){3}\\d{1,3}(:\\d+)?(/.*)?$") || s.startsWith("localhost");
            s = (lan ? "http://" : "https://") + s;
        }
        if (!s.endsWith("/")) s = s + "/";
        return s;
    }
}
