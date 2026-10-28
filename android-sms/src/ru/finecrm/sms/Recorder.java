package ru.finecrm.sms;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.telecom.TelecomManager;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Где на этом телефоне лежат записи разговоров (Андрей, 28.10.2026:
 * «автоматически опознавать телефон и подстраиваться»).
 *
 * Сами разговоры с Android 10 записывает только встроенная «звонилка»
 * производителя. Каждая кладёт файлы в свою папку: Samsung — «Recordings/Call»,
 * Xiaomi — «MIUI/sound_recorder/call_rec», Honor и Huawei — «Sounds/CallRecord»,
 * realme и OPPO — «Recordings/Call Recordings»… Мы не гадаем по марке, а
 * ищем: какие аудиофайлы в общих папках похожи на записи звонков и где самый
 * свежий. Найденную папку запоминаем — дальше ищем сначала в ней.
 *
 * Марка и звонилка нужны только для подсказки, где включить запись.
 */
final class Recorder {
    private Recorder() {}

    private static final String FILE = "finecrm_recorder";

    /** Части пути, по которым узнаём папку записей звонков. */
    private static final String[] HINTS = {
        "recordings/call", "call recordings", "call_rec", "callrecord", "call record", "record/call",
        "phonerecord", "sound_recorder/call", "recorder/call", "/call/", "звонк", "вызов",
    };

    static final class Found {
        final Uri uri;
        final String name;
        final String folder;
        final String mime;
        final long size;

        Found(Uri uri, String name, String folder, String mime, long size) {
            this.uri = uri;
            this.name = name;
            this.folder = folder;
            this.mime = mime;
            this.size = size;
        }
    }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    static String learnedFolder(Context c) {
        return prefs(c).getString("folder", "");
    }

    static long lastRecordAt(Context c) {
        return prefs(c).getLong("lastAt", 0);
    }

    static void learn(Context c, String folder, long at) {
        if (folder == null || folder.isEmpty()) return;
        prefs(c).edit().putString("folder", folder).putLong("lastAt", Math.max(at, lastRecordAt(c))).apply();
    }

    static boolean looksLikeCalls(String folder, String name) {
        String p = (folder + "/" + name).toLowerCase(Locale.ROOT);
        for (String h : HINTS) if (p.contains(h)) return true;
        return false;
    }

    /** Звонилка по умолчанию: «com.samsung.android.dialer», «com.google.android.dialer»… */
    static String dialer(Context c) {
        try {
            if (Build.VERSION.SDK_INT >= 23) {
                TelecomManager tm = (TelecomManager) c.getSystemService(Context.TELECOM_SERVICE);
                if (tm != null) {
                    String p = tm.getDefaultDialerPackage();
                    return p == null ? "" : p;
                }
            }
        } catch (Exception ignored) {
            // нет — подскажем по марке
        }
        return "";
    }

    static String brand() {
        String m = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        return m.isEmpty() ? "" : m.substring(0, 1).toUpperCase(Locale.ROOT) + m.substring(1);
    }

    /** Где включить автоматическую запись — именно на этом телефоне. */
    static String howTo(Context c) {
        String m = (Build.MANUFACTURER == null ? "" : Build.MANUFACTURER).toLowerCase(Locale.ROOT);
        String d = dialer(c);
        String tail = " Потом сделайте пробный звонок на номер клиента из FineCRM и нажмите «Проверить».";
        if (d.startsWith("com.google.android.dialer")) {
            return "Звонилка на телефоне — «Телефон» от Google: записи она хранит внутри себя и другим приложениям не отдаёт. "
                    + "Если в «Настройки → Приложения → Приложения по умолчанию → Телефон» есть звонилка производителя, выберите её и включите в ней "
                    + "автоматическую запись вызовов." + tail;
        }
        if (m.contains("samsung")) {
            return "Samsung: «Телефон» → ⋮ → «Настройки» → «Запись вызовов» → «Автоматическая запись вызовов» → «Все вызовы»." + tail;
        }
        if (m.contains("xiaomi") || m.contains("redmi") || m.contains("poco")) {
            return "Xiaomi: «Телефон» → «Настройки» → «Запись вызовов» → «Записывать вызовы автоматически» → «Все номера»." + tail;
        }
        if (m.contains("huawei") || m.contains("honor")) {
            return "Honor и Huawei: «Телефон» → ⋮ → «Настройки» → «Автозапись вызовов» → «Все вызовы»." + tail;
        }
        if (m.contains("realme") || m.contains("oppo") || m.contains("oneplus")) {
            return "realme, OPPO, OnePlus: «Телефон» → ⋮ → «Настройки» → «Запись вызовов» → «Автозапись» → «Все вызовы»." + tail;
        }
        if (m.contains("vivo") || m.contains("iqoo")) {
            return "vivo: «Телефон» → «Настройки» → «Запись вызовов» → «Автоматически записывать все вызовы»." + tail;
        }
        if (m.contains("tecno") || m.contains("infinix") || m.contains("itel")) {
            return "Tecno и Infinix: «Телефон» → ⋮ → «Настройки» → «Запись вызова» → «Автоматическая запись»." + tail;
        }
        return "Откройте «Телефон» → «Настройки» и найдите «Запись вызовов»: включите автоматическую запись всех вызовов. "
                + "Если такого пункта нет — на этом телефоне встроенной записи нет: звонки и пропущенные всё равно попадут в FineCRM, но без записи разговора.";
    }

    // ------------------------------------------------------------ поиск

    private static String[] projection() {
        if (Build.VERSION.SDK_INT >= 29) {
            return new String[] {
                MediaStore.Audio.Media._ID, MediaStore.Audio.Media.DISPLAY_NAME, MediaStore.Audio.Media.RELATIVE_PATH,
                MediaStore.Audio.Media.DATE_ADDED, MediaStore.Audio.Media.DATE_MODIFIED, MediaStore.Audio.Media.SIZE,
                MediaStore.Audio.Media.MIME_TYPE, MediaStore.Audio.Media.DURATION,
            };
        }
        return new String[] {
            MediaStore.Audio.Media._ID, MediaStore.Audio.Media.DISPLAY_NAME, MediaStore.Audio.Media.DATA,
            MediaStore.Audio.Media.DATE_ADDED, MediaStore.Audio.Media.DATE_MODIFIED, MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.MIME_TYPE, MediaStore.Audio.Media.DURATION,
        };
    }

    /** Папка файла: «Recordings/Call/» (Android 10+) или каталог из полного пути. */
    private static String folderOf(Cursor cur) {
        if (Build.VERSION.SDK_INT >= 29) {
            String rel = cur.getString(2);
            return rel == null ? "" : rel;
        }
        String data = cur.getString(2);
        if (data == null) return "";
        int slash = data.lastIndexOf('/');
        String dir = slash > 0 ? data.substring(0, slash + 1) : data;
        // «/storage/emulated/0/MIUI/…» → «MIUI/…»: так же, как на Android 10+.
        return dir.replaceFirst("^/storage/emulated/\\d+/", "").replaceFirst("^/sdcard/", "");
    }

    /**
     * Запись этого звонка: аудиофайл, появившийся во время звонка или вскоре
     * после, в папке записей звонков. Лучше всего — с последними цифрами номера
     * в имени и той же длительностью.
     */
    static Found find(Context c, long startMs, int durationSec, String number) {
        ContentResolver cr = c.getContentResolver();
        long endMs = startMs + durationSec * 1000L;
        String digits = number == null ? "" : number.replaceAll("\\D", "");
        String last7 = digits.length() >= 7 ? digits.substring(digits.length() - 7) : "";
        String learned = learnedFolder(c);
        String[] args = {String.valueOf(startMs / 1000 - 60), String.valueOf(endMs / 1000 + 30 * 60)};
        Cursor cur = null;
        Found best = null;
        long bestScore = Long.MIN_VALUE;
        try {
            cur = cr.query(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, projection(),
                    MediaStore.Audio.Media.DATE_ADDED + " >= ? AND " + MediaStore.Audio.Media.DATE_ADDED + " <= ?",
                    args, MediaStore.Audio.Media.DATE_ADDED + " DESC");
            if (cur == null) return null;
            while (cur.moveToNext()) {
                long id = cur.getLong(0);
                String name = cur.getString(1) == null ? "" : cur.getString(1);
                String folder = folderOf(cur);
                long modified = cur.getLong(4) * 1000L;
                long size = cur.getLong(5);
                String mime = cur.getString(6);
                long durMs = cur.getLong(7);
                boolean callsFolder = looksLikeCalls(folder, name) || (!learned.isEmpty() && learned.equals(folder));
                boolean numberInName = !last7.isEmpty() && name.replaceAll("\\D", "").contains(last7);
                if (!callsFolder && !numberInName) continue;
                long score = 0;
                if (numberInName) score += 1000;
                if (!learned.isEmpty() && learned.equals(folder)) score += 300;
                if (callsFolder) score += 200;
                if (durMs > 0 && durationSec > 0 && Math.abs(durMs / 1000 - durationSec) <= Math.max(15, durationSec / 5)) score += 400;
                // Чем ближе конец записи к концу звонка, тем вернее: минус очко за каждые 10 секунд.
                score -= Math.abs(modified - endMs) / 10000;
                if (score > bestScore) {
                    bestScore = score;
                    best = new Found(ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id), name, folder,
                            mime == null ? mimeOf(name) : mime, size);
                }
            }
        } catch (Exception ignored) {
            // нет разрешения или звонилка ещё пишет файл — попробуем позже
        } finally {
            if (cur != null) cur.close();
        }
        return best;
    }

    /**
     * Опознать, куда эта звонилка кладёт записи: из аудиофайлов за 60 дней,
     * похожих на записи звонков, — папка с самым свежим. Ничего нет — "".
     */
    static String detect(Context c) {
        Cursor cur = null;
        Map<String, Long> latest = new HashMap<>();
        try {
            String[] args = {String.valueOf(System.currentTimeMillis() / 1000 - 60L * 24 * 3600)};
            cur = c.getContentResolver().query(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, projection(),
                    MediaStore.Audio.Media.DATE_ADDED + " >= ?", args, MediaStore.Audio.Media.DATE_ADDED + " DESC");
            if (cur == null) return learnedFolder(c);
            int seen = 0;
            while (cur.moveToNext() && seen++ < 2000) {
                String name = cur.getString(1) == null ? "" : cur.getString(1);
                String folder = folderOf(cur);
                if (!looksLikeCalls(folder, name)) continue;
                long at = cur.getLong(4) * 1000L;
                Long was = latest.get(folder);
                if (was == null || at > was) latest.put(folder, at);
            }
        } catch (Exception ignored) {
            return learnedFolder(c);
        } finally {
            if (cur != null) cur.close();
        }
        String bestFolder = "";
        long bestAt = 0;
        for (Map.Entry<String, Long> e : latest.entrySet()) {
            if (e.getValue() > bestAt) {
                bestAt = e.getValue();
                bestFolder = e.getKey();
            }
        }
        if (!bestFolder.isEmpty()) learn(c, bestFolder, bestAt);
        return bestFolder.isEmpty() ? learnedFolder(c) : bestFolder;
    }

    static String mimeOf(String name) {
        String n = name == null ? "" : name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".m4a") || n.endsWith(".mp4")) return "audio/mp4";
        if (n.endsWith(".amr")) return "audio/amr";
        if (n.endsWith(".3gp") || n.endsWith(".3gpp")) return "audio/3gpp";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".aac")) return "audio/aac";
        if (n.endsWith(".ogg")) return "audio/ogg";
        if (n.endsWith(".opus")) return "audio/opus";
        if (n.endsWith(".wav")) return "audio/wav";
        return "audio/mp4";
    }

    /** MediaStore иногда отдаёт «audio/x-m4a» или «audio/mp4a-latm» — сервер ждёт простой тип. */
    static String serverMime(Found f) {
        String m = f.mime == null ? "" : f.mime.toLowerCase(Locale.ROOT);
        if (m.equals("audio/x-m4a") || m.equals("audio/mp4a-latm") || m.equals("audio/m4a")) return "audio/mp4";
        if (m.equals("audio/amr-wb") || m.equals("audio/amr")) return "audio/amr";
        if (m.startsWith("audio/")) {
            String[] ok = {"audio/mp4", "audio/aac", "audio/3gpp", "audio/mpeg", "audio/ogg", "audio/opus", "audio/wav", "audio/x-wav"};
            for (String o : ok) if (o.equals(m)) return m;
        }
        return mimeOf(f.name);
    }
}
