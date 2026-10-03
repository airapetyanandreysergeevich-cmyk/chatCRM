package ru.finecrm.sms;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.BatteryManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONObject;

/**
 * Служба-шлюз: всё время на связи с FineCRM и отправляет то, что пришло.
 *
 * Работает как «станция печати» в программе FineCRM: сама спрашивает сервер
 * «есть ли что отправить?» и ждёт ответа до 25 секунд. Поэтому телефону не
 * нужен ни белый адрес, ни открытые порты — достаточно интернета.
 *
 * Служба «на переднем плане» с постоянным значком: без этого Android через
 * несколько минут остановит её в фоне. Тип — remoteMessaging: Android 14+
 * не ограничивает его по времени работы.
 */
public class GatewayService extends Service {
    private static final String CHANNEL = "gateway";
    private static final int NOTIFICATION = 1;
    private static final long STATE_EVERY_MS = 5 * 60 * 1000;

    private static volatile GatewayService instance;
    private volatile boolean running;
    private Thread loop;
    private PowerManager.WakeLock wake;
    private long lastState;

    static void start(Context c) {
        Intent i = new Intent(c, GatewayService.class);
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
        else c.startService(i);
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, GatewayService.class));
    }

    /** Есть свежий отчёт — отправить сразу, не дожидаясь конца долгого опроса. */
    static void kick(final Context c) {
        final Context app = c.getApplicationContext();
        new Thread(new Runnable() {
            @Override
            public void run() {
                flushResults(app);
            }
        }, "finecrm-sms-kick").start();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Связь с FineCRM", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Пока этот значок есть, телефон отправляет SMS клиентам мастерской");
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(ch);
        }
        foreground("Подключаемся к FineCRM…");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!Store.paired(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (loop == null) {
            running = true;
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "finecrm:sms");
            wake.setReferenceCounted(false);
            wake.acquire();
            loop = new Thread(new Runnable() {
                @Override
                public void run() {
                    work();
                }
            }, "finecrm-sms-loop");
            loop.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (loop != null) loop.interrupt();
        if (wake != null && wake.isHeld()) wake.release();
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ------------------------------------------------------------ цикл

    private void work() {
        long backoff = 5000;
        while (running && Store.paired(this)) {
            String base = Store.base(this);
            String token = Store.token(this);
            try {
                flushResults(this);
                if (System.currentTimeMillis() - lastState > STATE_EVERY_MS) {
                    JSONObject r = Http.request("POST", base + "api/sms/phone/state", token, state(this), 20000);
                    Store.setWorkshop(this, r.optString("workshop", ""));
                    lastState = System.currentTimeMillis();
                }
                JSONObject r = Http.request("GET", base + "api/sms/phone/next?wait=25", token, null, 45000);
                online();
                JSONObject job = r.optJSONObject("job");
                if (job != null) {
                    SmsSender.send(this, job.getString("id"), job.getString("phone"), job.getString("text"));
                }
                backoff = 5000;
            } catch (Http.Unauthorized e) {
                Store.unpair(this, e.getMessage());
                break;
            } catch (Exception e) {
                if (!running) break;
                Store.setStatus(this, false, "Нет связи с FineCRM: " + Http.human(e));
                update("Нет связи с FineCRM — пробуем снова");
                sleep(backoff);
                backoff = Math.min(backoff * 2, 60000);
            }
        }
        running = false;
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        stopSelf();
    }

    private void online() {
        boolean was = Store.online(this);
        Store.setStatus(this, true, "На связи");
        if (!was) update(null);
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    /** Отчёты о SMS — серверу, по одному, пока есть что и пока есть связь. */
    static synchronized void flushResults(Context c) {
        String base = Store.base(c);
        String token = Store.token(c);
        if (base.isEmpty() || token.isEmpty()) return;
        for (int guard = 0; guard < 100; guard++) {
            JSONObject next = Store.peek(c);
            if (next == null) break;
            try {
                Http.request("POST", base + "api/sms/phone/result", token, next, 20000);
                Store.drop(c);
            } catch (Http.Refused e) {
                // 400/404 — сервер этот отчёт не примет никогда (сообщение удалено), не держим его.
                if (e.code >= 400 && e.code < 500) Store.drop(c);
                else break;
            } catch (Exception e) {
                break;
            }
        }
        GatewayService s = instance;
        if (s != null) s.update(null);
    }

    /** Что телефон сообщает о себе: батарея, разрешения, версия. */
    static JSONObject state(Context c) {
        JSONObject o = new JSONObject();
        try {
            BatteryManager bm = (BatteryManager) c.getSystemService(BATTERY_SERVICE);
            if (bm != null) {
                o.put("battery", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY));
                if (Build.VERSION.SDK_INT >= 23) o.put("charging", bm.isCharging());
            }
            o.put("smsPermission", Build.VERSION.SDK_INT < 23
                    || c.checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED);
            if (Build.VERSION.SDK_INT >= 23) {
                PowerManager pm = (PowerManager) c.getSystemService(POWER_SERVICE);
                o.put("batteryOptimized", pm != null && !pm.isIgnoringBatteryOptimizations(c.getPackageName()));
            }
            o.put("appVersion", BuildInfo.VERSION);
            o.put("android", Build.VERSION.RELEASE);
            o.put("model", Build.MANUFACTURER + " " + Build.MODEL);
        } catch (Exception ignored) {
            // что успели собрать — то и отправим
        }
        return o;
    }

    // ------------------------------------------------------------ значок

    private Notification build(String text) {
        Intent open = new Intent(this, MainActivity.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, flags);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        String workshop = Store.workshop(this);
        return b.setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(workshop.isEmpty() ? "FineCRM SMS" : "FineCRM SMS · " + workshop)
                .setContentText(text)
                .setContentIntent(tap)
                .setOngoing(true)
                .build();
    }

    private String summary() {
        int n = Store.sentToday(this);
        return Store.online(this) ? "На связи · сегодня отправлено SMS: " + n : "Нет связи с FineCRM · сегодня отправлено: " + n;
    }

    private void foreground(String text) {
        Notification n = build(text);
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else {
            startForeground(NOTIFICATION, n);
        }
    }

    void update(String text) {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION, build(text != null ? text : summary()));
    }
}
