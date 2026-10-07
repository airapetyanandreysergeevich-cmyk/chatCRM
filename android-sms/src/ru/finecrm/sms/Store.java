package ru.finecrm.sms;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Всё, что приложение помнит: куда подключено, ключ, состояние связи, счётчик
 * за день, неотправленные отчёты и части длинных SMS.
 *
 * Один файл настроек на всё. Методы синхронизированы: пишут сюда и служба
 * (поток опроса), и приёмник результатов SMS, и экран.
 */
final class Store {
    private static final String FILE = "finecrm_sms";

    private Store() {}

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    // ------------------------------------------------------------ подключение

    static synchronized boolean paired(Context c) {
        return !prefs(c).getString("token", "").isEmpty() && !prefs(c).getString("base", "").isEmpty();
    }

    static synchronized String base(Context c) {
        return prefs(c).getString("base", "");
    }

    static synchronized String token(Context c) {
        return prefs(c).getString("token", "");
    }

    static synchronized String workshop(Context c) {
        return prefs(c).getString("workshop", "");
    }

    static synchronized void pair(Context c, String base, String token, String workshop) {
        prefs(c).edit()
                .putString("base", base)
                .putString("token", token)
                .putString("workshop", workshop)
                .putString("status", "Подключаемся…")
                .remove("pending")
                .remove("parts")
                .apply();
    }

    static synchronized void setWorkshop(Context c, String workshop) {
        if (workshop != null && !workshop.isEmpty()) prefs(c).edit().putString("workshop", workshop).apply();
    }

    static synchronized void unpair(Context c, String why) {
        prefs(c).edit()
                .remove("token")
                .remove("pending")
                .remove("parts")
                .remove("watch")
                .remove("incoming")
                .putString("status", why)
                .apply();
    }

    // ------------------------------------------------------------ состояние

    static synchronized void setStatus(Context c, boolean online, String text) {
        SharedPreferences.Editor e = prefs(c).edit().putString("status", text).putBoolean("online", online);
        if (online) e.putLong("lastOnline", System.currentTimeMillis());
        e.apply();
    }

    static synchronized boolean online(Context c) {
        return prefs(c).getBoolean("online", false);
    }

    static synchronized String status(Context c) {
        return prefs(c).getString("status", "");
    }

    private static String today() {
        return new SimpleDateFormat("yyyyMMdd", Locale.US).format(new Date());
    }

    static synchronized int sentToday(Context c) {
        SharedPreferences p = prefs(c);
        return today().equals(p.getString("sentDay", "")) ? p.getInt("sentCount", 0) : 0;
    }

    static synchronized void countSent(Context c) {
        int n = sentToday(c) + 1;
        prefs(c).edit().putString("sentDay", today()).putInt("sentCount", n).apply();
    }

    static synchronized void setLastError(Context c, String text) {
        prefs(c).edit().putString("lastError", text).apply();
    }

    static synchronized String lastError(Context c) {
        return prefs(c).getString("lastError", "");
    }

    // ------------------------------------------------------------ отчёты серверу

    /** Отчёт «отправлено / доставлено / ошибка» ждёт, пока будет связь. */
    static synchronized void enqueue(Context c, String id, String status, String error) {
        try {
            JSONArray all = new JSONArray(prefs(c).getString("pending", "[]"));
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("status", status);
            if (error != null) o.put("error", error);
            all.put(o);
            prefs(c).edit().putString("pending", all.toString()).apply();
        } catch (JSONException ignored) {
            // испорченную очередь не чиним — отчёт просто не уйдёт
        }
    }

    /** Забрать первый неотправленный отчёт (не удаляя). */
    static synchronized JSONObject peek(Context c) {
        try {
            JSONArray all = new JSONArray(prefs(c).getString("pending", "[]"));
            return all.length() > 0 ? all.getJSONObject(0) : null;
        } catch (JSONException e) {
            prefs(c).edit().remove("pending").apply();
            return null;
        }
    }

    /** Отчёт доставлен серверу — убрать из очереди. */
    static synchronized void drop(Context c) {
        try {
            JSONArray all = new JSONArray(prefs(c).getString("pending", "[]"));
            JSONArray rest = new JSONArray();
            for (int i = 1; i < all.length(); i++) rest.put(all.get(i));
            prefs(c).edit().putString("pending", rest.toString()).apply();
        } catch (JSONException e) {
            prefs(c).edit().remove("pending").apply();
        }
    }

    // ------------------------------------------------------------ части длинной SMS

    /**
     * Длинная SMS уходит частями, и Android отвечает за каждую отдельно.
     * «Отправлено» — когда отправлены все части, «ошибка» — при первой же
     * неудачной, «доставлено» — когда подтверждены все.
     */
    static synchronized void track(Context c, String id, int parts) {
        try {
            JSONObject all = new JSONObject(prefs(c).getString("parts", "{}"));
            JSONObject m = new JSONObject();
            m.put("total", parts);
            m.put("sent", 0);
            m.put("delivered", 0);
            m.put("failed", false);
            m.put("at", System.currentTimeMillis());
            all.put(id, m);
            // Старше суток — забываем: доставка так и не пришла, ждать нечего.
            JSONArray names = all.names();
            long old = System.currentTimeMillis() - 24L * 60 * 60 * 1000;
            if (names != null) {
                for (int i = 0; i < names.length(); i++) {
                    String k = names.getString(i);
                    if (all.getJSONObject(k).optLong("at", 0) < old) all.remove(k);
                }
            }
            prefs(c).edit().putString("parts", all.toString()).apply();
        } catch (JSONException ignored) {
            prefs(c).edit().remove("parts").apply();
        }
    }

    /** Отметить событие части. Возвращает итог для сервера или null, если ещё рано. */
    static synchronized String part(Context c, String id, String event) {
        try {
            JSONObject all = new JSONObject(prefs(c).getString("parts", "{}"));
            JSONObject m = all.optJSONObject(id);
            if (m == null) return null;
            int total = m.optInt("total", 1);
            String result = null;
            if ("failed".equals(event)) {
                if (!m.optBoolean("failed", false)) result = "failed";
                m.put("failed", true);
            } else if ("sent".equals(event)) {
                int n = m.optInt("sent", 0) + 1;
                m.put("sent", n);
                if (n == total && !m.optBoolean("failed", false)) result = "sent";
            } else if ("delivered".equals(event)) {
                int n = m.optInt("delivered", 0) + 1;
                m.put("delivered", n);
                if (n == total && !m.optBoolean("failed", false)) result = "delivered";
            }
            all.put(id, m);
            prefs(c).edit().putString("parts", all.toString()).apply();
            return result;
        } catch (JSONException e) {
            return null;
        }
    }

    // ------------------------------------------------------------ ответы клиентов

    /** Номер — только цифры, «8…» и «+7…» одинаково: 79211234567. */
    static String digits(String phone) {
        if (phone == null) return "";
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < phone.length(); i++) {
            char ch = phone.charAt(i);
            if (ch >= '0' && ch <= '9') b.append(ch);
        }
        String d = b.toString();
        if (d.length() == 11 && d.charAt(0) == '8') d = "7" + d.substring(1);
        if (d.length() == 10 && d.charAt(0) == '9') d = "7" + d;
        return d;
    }

    /** Номера, от которых ждём ответа на согласование: их присылает сервер. */
    static synchronized void setWatch(Context c, JSONArray phones) {
        JSONArray clean = new JSONArray();
        if (phones != null) {
            for (int i = 0; i < phones.length() && i < 500; i++) {
                String d = digits(phones.optString(i, ""));
                if (d.length() >= 10) clean.put(d);
            }
        }
        prefs(c).edit().putString("watch", clean.toString()).apply();
    }

    static synchronized boolean watching(Context c, String phone) {
        String d = digits(phone);
        if (d.length() < 10) return false;
        try {
            JSONArray all = new JSONArray(prefs(c).getString("watch", "[]"));
            for (int i = 0; i < all.length(); i++) if (d.equals(all.optString(i))) return true;
        } catch (JSONException ignored) {
            // испорченный список — значит, никого не ждём
        }
        return false;
    }

    /** Ответ клиента ждёт, пока будет связь с FineCRM. */
    static synchronized void enqueueIncoming(Context c, String from, String text, long at) {
        try {
            JSONArray all = new JSONArray(prefs(c).getString("incoming", "[]"));
            JSONObject o = new JSONObject();
            o.put("from", from);
            o.put("text", text.length() > 2000 ? text.substring(0, 2000) : text);
            o.put("at", at);
            all.put(o);
            // Больше сотни неотправленных — старые уже не нужны.
            JSONArray keep = new JSONArray();
            for (int i = Math.max(0, all.length() - 100); i < all.length(); i++) keep.put(all.get(i));
            prefs(c).edit().putString("incoming", keep.toString()).apply();
        } catch (JSONException ignored) {
            prefs(c).edit().remove("incoming").apply();
        }
    }

    static synchronized JSONObject peekIncoming(Context c) {
        try {
            JSONArray all = new JSONArray(prefs(c).getString("incoming", "[]"));
            return all.length() > 0 ? all.getJSONObject(0) : null;
        } catch (JSONException e) {
            prefs(c).edit().remove("incoming").apply();
            return null;
        }
    }

    static synchronized void dropIncoming(Context c) {
        try {
            JSONArray all = new JSONArray(prefs(c).getString("incoming", "[]"));
            JSONArray rest = new JSONArray();
            for (int i = 1; i < all.length(); i++) rest.put(all.get(i));
            prefs(c).edit().putString("incoming", rest.toString()).apply();
        } catch (JSONException e) {
            prefs(c).edit().remove("incoming").apply();
        }
    }
}
