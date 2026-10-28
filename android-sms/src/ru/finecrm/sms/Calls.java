package ru.finecrm.sms;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.os.Build;
import android.provider.CallLog;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.InputStream;

/**
 * Звонки клиентов (с версии 1.3, 28.10.2026).
 *
 * После каждого опроса сервера смотрим журнал звонков: что появилось после
 * последнего просмотренного. Каждый звонок — серверу; сервер отвечает, наш
 * ли это клиент. Чужой номер — дальше ничего: личные звонки остаются на
 * телефоне. Клиент — и сервер хочет запись — ищем файл встроенной звонилки
 * (Recorder) и отправляем его. Звонилка может дописать файл через минуту после
 * звонка, поэтому ищем ещё 30 минут, потом бросаем.
 *
 * Всё, что не дошло из-за связи, ждёт в файле настроек и уходит позже.
 */
final class Calls {
    private Calls() {}

    private static final String FILE = "finecrm_calls";
    private static final long GIVE_UP_MS = 30 * 60 * 1000;
    private static final long DETECT_EVERY_MS = 10 * 60 * 1000;
    private static long lastDetect;

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    // ------------------------------------------------------------ настройки от сервера

    /** {enabled, audio, missed} из ответа /next. Старый сервер не шлёт — звонки выключены. */
    static synchronized void setConfig(Context c, JSONObject cfg) {
        boolean on = cfg != null && cfg.optBoolean("enabled", false);
        SharedPreferences p = prefs(c);
        SharedPreferences.Editor e = p.edit()
                .putBoolean("enabled", on)
                .putBoolean("audio", cfg != null && cfg.optBoolean("audio", true));
        // Включили только что — начинаем с этой минуты: старый журнал не выгружаем.
        if (on && p.getLong("cursor", 0) == 0) e.putLong("cursor", System.currentTimeMillis());
        if (!on) e.remove("cursor").remove("pending");
        e.apply();
    }

    static synchronized boolean enabled(Context c) {
        return prefs(c).getBoolean("enabled", false);
    }

    static synchronized boolean audioWanted(Context c) {
        return prefs(c).getBoolean("audio", true);
    }

    static synchronized int sentToday(Context c) {
        String day = String.valueOf(System.currentTimeMillis() / 86_400_000L);
        return day.equals(prefs(c).getString("day", "")) ? prefs(c).getInt("count", 0) : 0;
    }

    private static synchronized void countSent(Context c) {
        String day = String.valueOf(System.currentTimeMillis() / 86_400_000L);
        int n = day.equals(prefs(c).getString("day", "")) ? prefs(c).getInt("count", 0) : 0;
        prefs(c).edit().putString("day", day).putInt("count", n + 1).apply();
    }

    static boolean granted(Context c, String permission) {
        return Build.VERSION.SDK_INT < 23 || c.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean logGranted(Context c) {
        return granted(c, Manifest.permission.READ_CALL_LOG);
    }

    /** Аудиофайлы: с Android 13 — своё разрешение, раньше — общее на память. */
    static String audioPermission() {
        return Build.VERSION.SDK_INT >= 33 ? Manifest.permission.READ_MEDIA_AUDIO : Manifest.permission.READ_EXTERNAL_STORAGE;
    }

    static boolean audioGranted(Context c) {
        return granted(c, audioPermission());
    }

    /** Для /state: что видно серверу в «Интеграциях». */
    static JSONObject state(Context c) {
        JSONObject o = new JSONObject();
        try {
            o.put("log", logGranted(c));
            o.put("audio", audioGranted(c));
            o.put("brand", Recorder.brand());
            o.put("dialer", Recorder.dialer(c));
            String folder = Recorder.learnedFolder(c);
            if (!folder.isEmpty()) o.put("folder", folder);
            long last = Recorder.lastRecordAt(c);
            if (last > 0) o.put("lastRecordAt", last);
            o.put("howTo", Recorder.howTo(c));
        } catch (JSONException ignored) {
            // что успели — то и отправим
        }
        return o;
    }

    // ------------------------------------------------------------ работа

    /** Один проход: новые звонки из журнала и записи, которые ждут отправки. */
    static synchronized void tick(Context c, String base, String token) throws Http.Unauthorized {
        if (!enabled(c) || base.isEmpty() || token.isEmpty()) return;
        if (audioGranted(c) && System.currentTimeMillis() - lastDetect > DETECT_EVERY_MS) {
            lastDetect = System.currentTimeMillis();
            Recorder.detect(c);
        }
        scanLog(c, base, token);
        uploadPending(c, base, token);
    }

    private static String direction(int type) {
        switch (type) {
            case CallLog.Calls.INCOMING_TYPE:
                return "in";
            case CallLog.Calls.OUTGOING_TYPE:
                return "out";
            case CallLog.Calls.MISSED_TYPE:
                return "missed";
            case 5: // CallLog.Calls.REJECTED_TYPE (API 24)
                return "rejected";
            default:
                return null; // голосовая почта, заблокированные, «отвечено на другом устройстве»
        }
    }

    private static void scanLog(Context c, String base, String token) throws Http.Unauthorized {
        if (!logGranted(c)) return;
        long cursor = prefs(c).getLong("cursor", 0);
        if (cursor == 0) {
            prefs(c).edit().putLong("cursor", System.currentTimeMillis()).apply();
            return;
        }
        Cursor cur = null;
        try {
            cur = c.getContentResolver().query(CallLog.Calls.CONTENT_URI,
                    new String[] {CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.TYPE},
                    CallLog.Calls.DATE + " > ?", new String[] {String.valueOf(cursor)}, CallLog.Calls.DATE + " ASC");
            if (cur == null) return;
            int guard = 0;
            while (cur.moveToNext() && guard++ < 50) {
                long id = cur.getLong(0);
                String number = cur.getString(1);
                long date = cur.getLong(2);
                int duration = (int) cur.getLong(3);
                String dir = direction(cur.getInt(4));
                if (dir == null || number == null || number.replaceAll("\\D", "").length() < 10) {
                    advance(c, date);
                    continue;
                }
                JSONObject body = new JSONObject();
                body.put("key", id + ":" + date);
                body.put("direction", dir);
                body.put("number", number);
                body.put("startedAt", date);
                body.put("durationSec", duration);
                JSONObject r;
                try {
                    r = Http.request("POST", base + "api/sms/phone/calls", token, body, 20000);
                } catch (Http.Refused e) {
                    // Сервер такой звонок не примет никогда (старый сервер — 404, кривые часы — 400).
                    if (e.code >= 400 && e.code < 500) {
                        advance(c, date);
                        continue;
                    }
                    break;
                }
                if (r.optBoolean("matched", false)) {
                    countSent(c);
                    if (r.optBoolean("wantAudio", false) && audioWanted(c)) addPending(c, r.optString("id"), date, duration, number);
                }
                advance(c, date);
            }
        } catch (Http.Unauthorized e) {
            throw e;
        } catch (Exception ignored) {
            // нет связи — продолжим со следующего прохода с того же места
        } finally {
            if (cur != null) cur.close();
        }
    }

    private static void advance(Context c, long date) {
        prefs(c).edit().putLong("cursor", date).apply();
    }

    private static JSONArray pending(Context c) {
        try {
            return new JSONArray(prefs(c).getString("pending", "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    private static void addPending(Context c, String id, long start, int duration, String number) throws JSONException {
        if (id == null || id.isEmpty()) return;
        JSONArray list = pending(c);
        if (list.length() >= 200) return; // телефон долго без связи — старое не копим без конца
        JSONObject o = new JSONObject();
        o.put("id", id);
        o.put("start", start);
        o.put("dur", duration);
        o.put("num", number);
        list.put(o);
        prefs(c).edit().putString("pending", list.toString()).apply();
    }

    private static void uploadPending(Context c, String base, String token) throws Http.Unauthorized {
        JSONArray list = pending(c);
        if (list.length() == 0) return;
        JSONArray keep = new JSONArray();
        boolean offline = false;
        for (int i = 0; i < list.length(); i++) {
            JSONObject job = list.optJSONObject(i);
            if (job == null) continue;
            long start = job.optLong("start");
            int dur = job.optInt("dur");
            long ended = start + dur * 1000L;
            if (offline) {
                keep.put(job);
                continue;
            }
            Recorder.Found f = audioGranted(c) ? Recorder.find(c, start, dur, job.optString("num")) : null;
            if (f == null) {
                // Звонилка ещё не сохранила файл — подождём; полчаса нет — записи и не будет.
                if (System.currentTimeMillis() - ended < GIVE_UP_MS) keep.put(job);
                continue;
            }
            if (f.size > 50L * 1024 * 1024) continue; // больше, чем примет сервер
            InputStream in = null;
            try {
                in = c.getContentResolver().openInputStream(f.uri);
                if (in == null) {
                    keep.put(job);
                    continue;
                }
                Http.upload(base + "api/sms/phone/calls/" + job.optString("id") + "/audio", token, in, f.size, Recorder.serverMime(f), 120000);
                Recorder.learn(c, f.folder, System.currentTimeMillis());
            } catch (Http.Unauthorized e) {
                throw e;
            } catch (Http.Refused e) {
                if (e.code < 400 || e.code >= 500) keep.put(job);
            } catch (Exception e) {
                keep.put(job);
                offline = true;
            } finally {
                try {
                    if (in != null) in.close();
                } catch (Exception ignored) {
                    // закрыть не вышло — не страшно
                }
            }
        }
        prefs(c).edit().putString("pending", keep.toString()).apply();
    }
}
