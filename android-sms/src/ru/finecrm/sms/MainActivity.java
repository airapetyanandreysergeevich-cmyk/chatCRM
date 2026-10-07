package ru.finecrm.sms;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Единственный экран: подключение к мастерской, состояние связи и три
 * разрешения, без которых шлюз не работает (SMS, уведомления, экономия
 * батареи). Экран собран кодом, без разметки: здесь пять строк и две кнопки.
 */
public class MainActivity extends Activity {
    private static final int REQ_SMS = 1;
    private static final int REQ_NOTIFY = 2;
    private static final int REQ_RECEIVE = 3;

    private static final int INK = Color.parseColor("#161A22");
    private static final int MUTED = Color.parseColor("#5B6475");
    private static final int BRAND = Color.parseColor("#2F8FE0");
    private static final int OK = Color.parseColor("#1F8A4C");
    private static final int BAD = Color.parseColor("#C4362F");

    private final Handler ui = new Handler(Looper.getMainLooper());
    private LinearLayout root;
    private EditText address;
    private EditText code;
    private TextView message;
    private boolean busy;

    private String shown = "";

    /**
     * Раз в две секунды — перерисовать, если что-то изменилось. Только если
     * изменилось: иначе поле ввода кода пересоздавалось бы посреди набора.
     */
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!signature().equals(shown)) render();
            ui.postDelayed(this, 2000);
        }
    };

    private String signature() {
        return Store.paired(this) + "|" + Store.online(this) + "|" + Store.status(this) + "|" + Store.sentToday(this)
                + "|" + Store.lastError(this) + "|" + granted(Manifest.permission.SEND_SMS)
                + "|" + (Build.VERSION.SDK_INT >= 33 && granted(Manifest.permission.POST_NOTIFICATIONS))
                + "|" + batteryFree();
    }

    private boolean batteryFree() {
        if (Build.VERSION.SDK_INT < 23) return true;
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
    }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.parseColor("#F3F5F9"));
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        root.setPadding(pad, dp(28), pad, pad);
        scroll.addView(root);
        setContentView(scroll);
        handleLink(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleLink(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (Store.paired(this)) GatewayService.start(this);
        ui.post(tick);
    }

    @Override
    protected void onPause() {
        ui.removeCallbacks(tick);
        super.onPause();
    }

    /** Запасные адреса из QR-кода: у компьютера бывает несколько сетей, и первая может оказаться не той. */
    private final List<String> alternates = new ArrayList<>();

    /** Ссылка из QR-кода: finecrmsms://pair?u=<адрес>&c=<код>[&a=<запасной>…] — подключаемся сразу. */
    private void handleLink(Intent intent) {
        Uri data = intent == null ? null : intent.getData();
        render();
        if (data == null || !"finecrmsms".equals(data.getScheme())) return;
        String u = data.getQueryParameter("u");
        String c = data.getQueryParameter("c");
        if (u == null || c == null) return;
        alternates.clear();
        for (String a : data.getQueryParameters("a")) {
            String n = Http.normalizeBase(a);
            if (!n.isEmpty()) alternates.add(n);
        }
        if (Store.paired(this)) {
            say("Телефон уже подключён к «" + Store.workshop(this) + "». Чтобы подключить к другой мастерской, сначала нажмите «Отключить».", BAD);
            return;
        }
        address.setText(u);
        code.setText(c);
        pair();
    }

    // ------------------------------------------------------------ экран

    private void render() {
        shown = signature();
        root.removeAllViews();
        text("FineCRM SMS", 26, INK, true);
        text("Этот телефон отправляет SMS клиентам мастерской со своей SIM-карты — сам, по заданиям FineCRM.", 15, MUTED, false);
        space(18);

        if (!Store.paired(this)) {
            renderPairing();
        } else {
            renderStatus();
        }
        if (message != null && message.getText().length() > 0) {
            space(12);
            root.addView(message);
        }
    }

    private void renderPairing() {
        String why = Store.status(this);
        if (!why.isEmpty() && !Store.online(this)) {
            text(why, 14, BAD, false);
            space(10);
        }
        text("Подключение к мастерской", 18, INK, true);
        text("В FineCRM откройте «Настройки → Интеграции → SMS клиентам → Подключить телефон» и наведите камеру на QR-код. Или введите адрес и код вручную:", 14, MUTED, false);
        space(10);
        String a = address != null ? address.getText().toString() : "";
        String k = code != null ? code.getText().toString() : "";
        address = input("Адрес, например www.finecrm.ru", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        address.setText(a);
        code = input("Код из 6 цифр", InputType.TYPE_CLASS_NUMBER);
        code.setText(k);
        space(8);
        button(busy ? "Подключаемся…" : "Подключить", true, new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                pair();
            }
        });
    }

    private void renderStatus() {
        boolean online = Store.online(this);
        text("Мастерская: " + Store.workshop(this), 18, INK, true);
        text(online ? "● На связи" : "● " + Store.status(this), 15, online ? OK : BAD, true);
        text("Сегодня отправлено SMS: " + Store.sentToday(this), 15, INK, false);
        String last = Store.lastError(this);
        if (!last.isEmpty()) text("Последняя ошибка: " + last, 13, MUTED, false);
        space(18);

        text("Чтобы всё работало", 18, INK, true);
        boolean sms = granted(Manifest.permission.SEND_SMS);
        check(sms, "Разрешение на отправку SMS", "Разрешить", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (Build.VERSION.SDK_INT >= 23) requestPermissions(new String[] {Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_SMS}, REQ_SMS);
            }
        });
        if (!sms) {
            // Android 13+ для приложений не из магазина может закрыть разрешение «ограниченной настройкой».
            text("Если Android пишет «Ограниченная настройка»: «О приложении» → ⋮ → «Разрешить ограниченные настройки», затем снова «Разрешить».", 13, MUTED, false);
            button("О приложении", false, new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
                }
            });
        }
        check(granted(Manifest.permission.RECEIVE_SMS), "Ответы клиентов на согласование", "Разрешить", new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (Build.VERSION.SDK_INT >= 23) requestPermissions(new String[] {Manifest.permission.RECEIVE_SMS}, REQ_RECEIVE);
            }
        });
        text("В FineCRM уходят только ответы клиентов, которых мастерская спросила о ремонте. Остальные SMS остаются на телефоне.", 13, MUTED, false);
        if (Build.VERSION.SDK_INT >= 33) {
            check(granted(Manifest.permission.POST_NOTIFICATIONS), "Значок «на связи» в шторке", "Разрешить", new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
                }
            });
        }
        if (Build.VERSION.SDK_INT >= 23) {
            check(batteryFree(), "Работа без экономии батареи", "Отключить экономию", new View.OnClickListener() {
                @Override
                public void onClick(View v) {
                    try {
                        startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                                Uri.parse("package:" + getPackageName())));
                    } catch (Exception e) {
                        startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                    }
                }
            });
        }
        text("На Xiaomi, Huawei, Honor и Samsung также включите для FineCRM SMS «Автозапуск» и уберите ограничения фоновой работы в настройках приложения.", 13, MUTED, false);
        space(18);
        text("Телефону лучше лежать на зарядке и быть в сети: Wi-Fi или мобильный интернет.", 13, MUTED, false);
        space(18);
        button("Отключить от мастерской", false, new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                unpair();
            }
        });
    }

    // ------------------------------------------------------------ действия

    private void pair() {
        if (busy) return;
        final String base = Http.normalizeBase(address.getText().toString());
        final String c = code.getText().toString().replaceAll("\\D", "");
        if (base.isEmpty() || c.length() != 6) {
            say("Введите адрес мастерской и код из 6 цифр", BAD);
            return;
        }
        busy = true;
        say("Подключаемся…", MUTED);
        new Thread(new Runnable() {
            @Override
            public void run() {
                // Сначала введённый адрес, потом запасные из QR-кода. Сервер ответил
                // отказом (код устарел) — дальше не перебираем: ответ уже есть.
                List<String> tries = new ArrayList<>();
                tries.add(base);
                for (String a : alternates) if (!tries.contains(a)) tries.add(a);
                String error = null;
                String worked = null;
                for (int i = 0; i < tries.size(); i++) {
                    String at = tries.get(i);
                    try {
                        JSONObject body = new JSONObject();
                        body.put("code", c);
                        body.put("name", Build.MANUFACTURER + " " + Build.MODEL);
                        body.put("info", GatewayService.state(MainActivity.this));
                        // С запасными адресами не ждём по 15 секунд на каждый.
                        int connect = tries.size() > 1 ? 7000 : 15000;
                        JSONObject r = Http.request("POST", at + "api/sms/phone/pair", null, body, 20000, connect);
                        Store.pair(MainActivity.this, at, r.getString("token"), r.optString("workshop", ""));
                        worked = at;
                        error = null;
                        break;
                    } catch (Http.NotFineCrm e) {
                        error = e.getMessage() + " (" + at + ")";
                    } catch (Http.Refused e) {
                        error = e.getMessage();
                        break;
                    } catch (Exception e) {
                        error = Http.human(e) + " (" + at + ")";
                    }
                }
                final String failed = error;
                final String address2 = worked;
                final boolean many = tries.size() > 1;
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        busy = false;
                        if (failed != null) {
                            say("Не получилось: " + failed + ".\n\n"
                                    + (many ? "Ни один из адресов мастерской не ответил. " : "")
                                    + "Телефон должен быть в том же Wi-Fi, что и компьютер с FineCRM. "
                                    + "Или включите в FineCRM «Настройки → Доступ из интернета» и возьмите новый код — "
                                    + "тогда телефон подключится откуда угодно.", BAD);
                            return;
                        }
                        if (address2 != null) address.setText(address2);
                        say("Подключено к «" + Store.workshop(MainActivity.this) + "»", OK);
                        GatewayService.start(MainActivity.this);
                        if (!granted(Manifest.permission.SEND_SMS) && Build.VERSION.SDK_INT >= 23) {
                            requestPermissions(new String[] {Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_SMS}, REQ_SMS);
                        }
                    }
                });
            }
        }).start();
    }

    private void unpair() {
        final String base = Store.base(this);
        final String token = Store.token(this);
        GatewayService.stop(this);
        Store.unpair(this, "Отключено");
        say("Телефон отключён от мастерской", MUTED);
        // Сказать серверу — по возможности: не вышло, так в настройках его отключат вручную.
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Http.request("POST", base + "api/sms/phone/unpair", token, new JSONObject(), 15000);
                } catch (Exception ignored) {
                    // без связи — не беда
                }
            }
        }).start();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_SMS && Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
        }
        render();
    }

    private boolean granted(String permission) {
        return Build.VERSION.SDK_INT < 23 || checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    // ------------------------------------------------------------ элементы

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void space(int height) {
        View v = new View(this);
        root.addView(v, new LinearLayout.LayoutParams(1, dp(height)));
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        t.setLineSpacing(0, 1.15f);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setPadding(0, dp(3), 0, dp(3));
        root.addView(t);
        return t;
    }

    private EditText input(String hint, int type) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setInputType(type);
        e.setSingleLine(true);
        e.setTextSize(17);
        root.addView(e, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return e;
    }

    private void button(String label, boolean primary, View.OnClickListener click) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(16);
        b.setTextColor(primary ? Color.WHITE : INK);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(12));
        bg.setColor(primary ? BRAND : Color.parseColor("#E6E9EF"));
        b.setBackground(bg);
        b.setOnClickListener(click);
        b.setEnabled(!busy || !primary);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        lp.topMargin = dp(6);
        root.addView(b, lp);
    }

    /** Строка проверки: «✓ Разрешение на SMS» или «✗ … [Разрешить]». */
    private void check(boolean ok, String label, String action, View.OnClickListener click) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(6), 0, dp(6));
        TextView t = new TextView(this);
        t.setText((ok ? "✓  " : "✗  ") + label);
        t.setTextSize(15);
        t.setTextColor(ok ? OK : BAD);
        row.addView(t, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        if (!ok) {
            Button b = new Button(this);
            b.setText(action);
            b.setAllCaps(false);
            b.setTextColor(Color.WHITE);
            GradientDrawable bg = new GradientDrawable();
            bg.setCornerRadius(dp(10));
            bg.setColor(BRAND);
            b.setBackground(bg);
            b.setPadding(dp(14), 0, dp(14), 0);
            b.setOnClickListener(click);
            row.addView(b, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(40)));
        }
        root.addView(row);
    }

    private void say(String s, int color) {
        if (message == null) {
            message = new TextView(this);
            message.setTextSize(15);
            message.setPadding(0, dp(6), 0, dp(6));
        }
        message.setText(s);
        message.setTextColor(color);
        render();
    }
}
