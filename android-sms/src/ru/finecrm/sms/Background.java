package ru.finecrm.sms;

import android.app.ActivityManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import org.json.JSONObject;

/**
 * «Работа в фоне» (1.4): что мешает приложению работать свёрнутым и куда
 * нажать, чтобы не мешало. У каждой прошивки свои настройки — открываем
 * нужный экран напрямую, а не нашёлся — «О приложении».
 */
final class Background {
    private Background() {}

    /** Марка в том виде, в каком её знают люди: «Xiaomi», «Samsung», «Honor»… */
    static String family() {
        String m = (Build.MANUFACTURER == null ? "" : Build.MANUFACTURER).toLowerCase();
        if (m.contains("xiaomi") || m.contains("redmi") || m.contains("poco")) return "xiaomi";
        if (m.contains("huawei")) return "huawei";
        if (m.contains("honor")) return "honor";
        if (m.contains("samsung")) return "samsung";
        if (m.contains("oppo") || m.contains("realme") || m.contains("oneplus")) return "oppo";
        if (m.contains("vivo") || m.contains("iqoo")) return "vivo";
        if (m.contains("tecno") || m.contains("infinix") || m.contains("itel")) return "transsion";
        if (m.contains("asus")) return "asus";
        return "other";
    }

    static boolean batteryFree(Context c) {
        if (Build.VERSION.SDK_INT < 23) return true;
        PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName());
    }

    /** Android 9+: пользователь (или прошивка) запретил фоновую работу в «О приложении → Батарея». */
    static boolean restricted(Context c) {
        if (Build.VERSION.SDK_INT < 28) return false;
        ActivityManager am = (ActivityManager) c.getSystemService(Context.ACTIVITY_SERVICE);
        return am != null && am.isBackgroundRestricted();
    }

    /** Всё ли хорошо: экономия выключена, фон не запрещён, за неделю ни разу не закрывали. */
    static boolean fine(Context c) {
        return batteryFree(c) && !restricted(c) && Store.restartsWeek(c) == 0;
    }

    static JSONObject state(Context c) {
        JSONObject o = new JSONObject();
        try {
            o.put("watchdog", true);
            o.put("restricted", restricted(c));
            o.put("restarts", Store.restartsWeek(c));
            long last = Store.lastRestart(c);
            if (last > 0) {
                o.put("lastRestartAt", last);
                o.put("lastGapMin", Math.round(Store.lastGap(c) / 60000.0));
            }
            o.put("family", family());
        } catch (Exception ignored) {
            // что успели
        }
        return o;
    }

    /** Подсказка для этой марки: где автозапуск и фоновая работа. */
    static String howTo() {
        switch (family()) {
            case "xiaomi":
                return "Xiaomi, Redmi, POCO:\n"
                        + "1. «Автозапуск» — включить для FineCRM Телефон.\n"
                        + "2. «Контроль активности» (Батарея) — «Нет ограничений».\n"
                        + "3. В списке недавних приложений потяните карточку FineCRM Телефон вниз или нажмите замок — так MIUI не закроет его при очистке.";
            case "huawei":
            case "honor":
                return "Huawei и Honor:\n"
                        + "1. «Запуск приложений» — у FineCRM Телефон выключить «Автоматическое управление» и оставить включёнными все три переключателя: автозапуск, косвенный запуск, работа в фоне.\n"
                        + "2. В списке недавних потяните карточку вниз — появится замок.";
            case "samsung":
                return "Samsung:\n"
                        + "1. Батарея → «Ограничения фоновой активности» → «Приложения, которые никогда не переходят в спящий режим» → добавить FineCRM Телефон.\n"
                        + "2. Проверьте, что его нет в «Спящих» и «Глубоко спящих» приложениях.\n"
                        + "3. «О приложении → Батарея» — «Без ограничений».";
            case "oppo":
                return "OPPO, realme, OnePlus:\n"
                        + "1. «Автозапуск» — включить для FineCRM Телефон.\n"
                        + "2. «О приложении → Использование батареи» — разрешить фоновую активность.\n"
                        + "3. В списке недавних нажмите ⋮ на карточке → «Заблокировать».";
            case "vivo":
                return "vivo и iQOO:\n"
                        + "1. «Высокое энергопотребление в фоне» — разрешить FineCRM Телефон.\n"
                        + "2. «Автозапуск» — включить.\n"
                        + "3. В списке недавних потяните карточку вниз — замок.";
            case "transsion":
                return "Tecno, Infinix, itel:\n"
                        + "Phone Master → «Управление автозапуском» — включить FineCRM Телефон; там же уберите его из «Ускорения в фоне».";
            default:
                return "В «О приложении → Батарея» выберите «Без ограничений». Если в настройках телефона есть «Автозапуск» — включите его для FineCRM Телефон.";
        }
    }

    /** Экран автозапуска прошивки, по порядку — от свежих прошивок к старым. */
    private static String[][] autostart() {
        switch (family()) {
            case "xiaomi":
                return new String[][] {
                    {"com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"},
                };
            case "huawei":
                return new String[][] {
                    {"com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"},
                    {"com.huawei.systemmanager", "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity"},
                    {"com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"},
                };
            case "honor":
                return new String[][] {
                    {"com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity"},
                    {"com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"},
                };
            case "oppo":
                return new String[][] {
                    {"com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"},
                    {"com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity"},
                    {"com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"},
                    {"com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"},
                };
            case "vivo":
                return new String[][] {
                    {"com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"},
                    {"com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"},
                    {"com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"},
                };
            case "transsion":
                return new String[][] {
                    {"com.transsion.phonemaster", "com.cyin.himgr.autostart.AutoStartActivity"},
                };
            case "asus":
                return new String[][] {
                    {"com.asus.mobilemanager", "com.asus.mobilemanager.autostart.AutoStartActivity"},
                    {"com.asus.mobilemanager", "com.asus.mobilemanager.MainActivity"},
                };
            default:
                return new String[0][];
        }
    }

    /** Экран батареи прошивки — у кого он свой (Samsung, Xiaomi). */
    private static String[][] battery() {
        switch (family()) {
            case "samsung":
                return new String[][] {
                    {"com.samsung.android.lool", "com.samsung.android.sm.battery.ui.BatteryActivity"},
                    {"com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"},
                    {"com.samsung.android.sm", "com.samsung.android.sm.ui.battery.BatteryActivity"},
                };
            case "xiaomi":
                return new String[][] {
                    {"com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"},
                };
            case "oppo":
                return new String[][] {
                    {"com.coloros.oppoguardelf", "com.coloros.powermanager.fuelgaue.PowerUsageModelActivity"},
                };
            default:
                return new String[0][];
        }
    }

    static boolean hasAutostart() {
        return autostart().length > 0;
    }

    static boolean hasBattery() {
        return battery().length > 0;
    }

    /** Открыть автозапуск прошивки. Не вышло ни одно — «О приложении». */
    static void openAutostart(Context c) {
        if (!tryAll(c, autostart())) openDetails(c);
    }

    static void openBattery(Context c) {
        if (!tryAll(c, battery())) openDetails(c);
    }

    static void openDetails(Context c) {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + c.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
        } catch (Exception ignored) {
            // настройки не открылись — подсказка на экране всё равно есть
        }
    }

    private static boolean tryAll(Context c, String[][] list) {
        for (String[] x : list) {
            try {
                Intent i = new Intent();
                i.setComponent(new ComponentName(x[0], x[1]));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                // Экрану батареи Xiaomi нужно знать, про какое приложение речь.
                i.putExtra("package_name", c.getPackageName());
                i.putExtra("package_label", "FineCRM Телефон");
                c.startActivity(i);
                return true;
            } catch (Exception ignored) {
                // нет такого экрана в этой прошивке — следующий
            }
        }
        return false;
    }
}
