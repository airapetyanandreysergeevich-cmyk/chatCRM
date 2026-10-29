package ru.finecrm.sms;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import org.json.JSONObject;

/**
 * Сторож (1.4): поднимает шлюз, если Android его закрыл.
 *
 * Жалоба: «работает, только когда приложение открыто». Служба шлюза и так
 * «на переднем плане», но прошивки Xiaomi, Huawei, Honor, Samsung, OPPO и
 * vivo всё равно закрывают приложение, когда его смахнули из недавних или
 * телефон полежал с погашенным экраном. Поэтому:
 *
 *   • раз в 15 минут (чаще Android не даёт) система сама будит сторожа;
 *   • после каждого звонка и когда приложение смахнули — тоже, через минуту;
 *   • сторож смотрит, жива ли служба; нет — запускает её снова, а если
 *     Android не разрешает запуск из фона, сам делает один проход: отчёты
 *     SMS, очередное задание, звонки. И показывает уведомление «Откройте
 *     FineCRM Телефон» — нажатие поднимает всё как было.
 *
 * Сколько раз пришлось поднимать — уходит в FineCRM («Интеграции»), чтобы
 * было видно, что телефону нужна настройка «Работа в фоне».
 */
public class Watchdog extends JobService {
    private static final int JOB_PERIODIC = 41;
    private static final int JOB_SOON = 42;
    private static final long PERIOD_MS = 15 * 60 * 1000;
    private static final String CHANNEL = "watchdog";
    private static final int NOTIFICATION = 7;
    /** Проход сторожа без службы — не дольше этого: у задания системы есть свой предел. */
    private static final long PASS_MS = 60 * 1000;

    /** Каждые 15 минут, переживает перезагрузку. Повторный вызов ничего не ломает. */
    static void schedule(Context c) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return;
            if (Build.VERSION.SDK_INT >= 24 && js.getPendingJob(JOB_PERIODIC) != null) return;
            JobInfo job = new JobInfo.Builder(JOB_PERIODIC, new ComponentName(c, Watchdog.class))
                    .setPeriodic(PERIOD_MS)
                    .setPersisted(true)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .build();
            js.schedule(job);
        } catch (Exception ignored) {
            // без сторожа шлюз работает как раньше
        }
    }

    /** Разбудить сторожа через delayMs — после звонка, после «смахнули из недавних». */
    static void soon(Context c, long delayMs) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return;
            JobInfo job = new JobInfo.Builder(JOB_SOON, new ComponentName(c, Watchdog.class))
                    .setMinimumLatency(delayMs)
                    .setOverrideDeadline(delayMs + 2 * 60 * 1000)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .build();
            js.schedule(job);
        } catch (Exception ignored) {
            // не вышло — разбудит плановый
        }
    }

    static void cancel(Context c) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js != null) {
                js.cancel(JOB_PERIODIC);
                js.cancel(JOB_SOON);
            }
        } catch (Exception ignored) {
            // нечего отменять
        }
    }

    private volatile Thread worker;

    @Override
    public boolean onStartJob(final JobParameters params) {
        final Context app = getApplicationContext();
        if (!Store.paired(app)) {
            cancel(app);
            return false;
        }
        worker = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    check(app);
                } finally {
                    jobFinished(params, false);
                }
            }
        }, "finecrm-watchdog");
        worker.start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        Thread t = worker;
        if (t != null) t.interrupt();
        return false;
    }

    /** Жива служба — ничего не делаем. Нет — поднимаем; не дают — проходим сами. */
    static void check(Context c) {
        if (GatewayService.alive()) {
            hideNotice(c);
            return;
        }
        long gap = Store.sinceAlive(c);
        // Служба останавливалась не по нашей воле: «Отключить» снимает сторожа.
        if (gap > 2 * 60 * 1000) Store.countRestart(c, gap);
        boolean started = false;
        try {
            GatewayService.start(c);
            started = true;
        } catch (Exception e) {
            // Android 12+: запуск службы из фона запрещён, пока для приложения
            // не выключена экономия батареи. Работаем сами и просим открыть.
        }
        if (started) {
            hideNotice(c);
            return;
        }
        pass(c);
        showNotice(c);
    }

    /** Один проход без службы: отчёты, задания (сколько успеем), звонки. */
    private static void pass(Context c) {
        String base = Store.base(c);
        String token = Store.token(c);
        if (base.isEmpty() || token.isEmpty()) return;
        long until = System.currentTimeMillis() + PASS_MS;
        try {
            GatewayService.flushResults(c);
            while (System.currentTimeMillis() < until && !Thread.currentThread().isInterrupted()) {
                JSONObject r = Http.request("GET", base + "api/sms/phone/next?wait=5", token, null, 20000);
                Store.setStatus(c, true, "На связи");
                Store.markAlive(c);
                Store.setWatch(c, r.optJSONArray("watch"));
                Calls.setConfig(c, r.optJSONObject("calls"));
                JSONObject job = r.optJSONObject("job");
                if (job == null) break;
                SmsSender.send(c, job.getString("id"), job.getString("phone"), job.getString("text"));
            }
            Calls.tick(c, base, token);
            GatewayService.flushResults(c);
        } catch (Http.Unauthorized e) {
            Store.unpair(c, e.getMessage());
            cancel(c);
        } catch (Exception ignored) {
            // нет связи — следующий раз
        }
    }

    // ------------------------------------------------------------ уведомление

    private static void showNotice(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Шлюз остановлен", NotificationManager.IMPORTANCE_DEFAULT);
            ch.setDescription("Android закрыл FineCRM Телефон — SMS и звонки клиентов не передаются, пока его не открыть");
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(c, MainActivity.class);
        open.putExtra("screen", "background");
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent tap = PendingIntent.getActivity(c, 1, open, flags);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(c, CHANNEL) : new Notification.Builder(c);
        nm.notify(NOTIFICATION, b.setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("FineCRM Телефон остановлен")
                .setContentText("Android закрыл приложение. Нажмите, чтобы снова включить, и настройте «Работу в фоне»")
                .setContentIntent(tap)
                .setAutoCancel(true)
                .build());
    }

    static void hideNotice(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTIFICATION);
    }
}
