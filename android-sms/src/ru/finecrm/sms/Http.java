package ru.finecrm.sms;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;

import javax.net.ssl.SSLException;

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
    static class Refused extends IOException {
        final int code;

        Refused(int code, String message) {
            super(message);
            this.code = code;
        }
    }

    /** По адресу ответил кто-то другой (роутер, чужой сайт) — значит, адрес не тот. */
    static final class NotFineCrm extends Refused {
        NotFineCrm(int code) {
            super(code, "по этому адресу отвечает не FineCRM (HTTP " + code + ")");
        }
    }

    static JSONObject request(String method, String url, String token, JSONObject body, int readTimeoutMs)
            throws IOException, Unauthorized {
        return request(method, url, token, body, readTimeoutMs, 15000);
    }

    static JSONObject request(String method, String url, String token, JSONObject body, int readTimeoutMs, int connectTimeoutMs)
            throws IOException, Unauthorized {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestMethod(method);
            conn.setConnectTimeout(connectTimeoutMs);
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
                throw new NotFineCrm(code);
            }
            if (code == 401) throw new Unauthorized(json.optString("error", "Телефон отключён от мастерской"));
            if (code >= 400) throw new Refused(code, json.optString("error", "Сервер ответил ошибкой " + code));
            return json;
        } finally {
            conn.disconnect();
        }
    }

    /**
     * Ошибка связи — человеческими словами. Android пишет «failed to connect to
     * /26.124.34.218 (port 7373) from /192.168.1.246 … after 15000ms», а человеку
     * нужно понять, что делать.
     */
    static String human(Exception e) {
        if (e instanceof Refused) return e.getMessage();
        if (e instanceof UnknownHostException) return "адрес не найден — проверьте адрес и интернет на телефоне";
        if (e instanceof SocketTimeoutException || e instanceof ConnectException || e instanceof NoRouteToHostException) {
            return "компьютер с FineCRM не отвечает по этому адресу";
        }
        if (e instanceof SSLException) return "не удалось установить защищённое соединение";
        String m = e.getMessage();
        return m == null || m.isEmpty() ? "нет связи" : m;
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
