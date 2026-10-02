package ru.finecrm.sms;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.telephony.SmsManager;

import java.util.ArrayList;

/**
 * Отправка SMS со своей SIM-карты.
 *
 * Android отвечает о каждой части дважды: «ушла с телефона» (SENT) и, если
 * оператор умеет, «доставлена» (DELIVERED). Ответы ловит SmsResultReceiver.
 */
final class SmsSender {
    static final String ACTION_SENT = "ru.finecrm.sms.SENT";
    static final String ACTION_DELIVERED = "ru.finecrm.sms.DELIVERED";

    private SmsSender() {}

    static void send(Context c, String id, String phone, String text) {
        if (Build.VERSION.SDK_INT >= 23
                && c.checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            fail(c, id, "Нет разрешения на отправку SMS — откройте приложение FineCRM SMS и разрешите");
            return;
        }
        SmsManager sm = manager(c);
        if (sm == null) {
            fail(c, id, "Этот телефон не умеет отправлять SMS");
            return;
        }
        try {
            ArrayList<String> parts = sm.divideMessage(text);
            int total = Math.max(1, parts.size());
            Store.track(c, id, total);
            ArrayList<PendingIntent> sent = new ArrayList<>();
            ArrayList<PendingIntent> delivered = new ArrayList<>();
            for (int i = 0; i < total; i++) {
                sent.add(pending(c, ACTION_SENT, id, i));
                delivered.add(pending(c, ACTION_DELIVERED, id, i));
            }
            if (total == 1) {
                sm.sendTextMessage(phone, null, text, sent.get(0), delivered.get(0));
            } else {
                sm.sendMultipartTextMessage(phone, null, parts, sent, delivered);
            }
        } catch (Exception e) {
            fail(c, id, "Android не принял SMS: " + e.getMessage());
        }
    }

    @SuppressWarnings("deprecation")
    private static SmsManager manager(Context c) {
        if (Build.VERSION.SDK_INT >= 31) return c.getSystemService(SmsManager.class);
        return SmsManager.getDefault();
    }

    /**
     * Своё намерение на каждую часть: иначе Android склеит их в одно, и об
     * ответах второй части мы не узнаем. Изменяемое (MUTABLE) — в ответ о
     * доставке Android дописывает PDU с её состоянием.
     */
    private static PendingIntent pending(Context c, String action, String id, int part) {
        Intent i = new Intent(c, SmsResultReceiver.class)
                .setAction(action)
                .setData(Uri.parse("finecrmsms://" + (ACTION_SENT.equals(action) ? "sent" : "delivered") + "/" + id + "/" + part))
                .putExtra("id", id)
                .putExtra("part", part);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
        return PendingIntent.getBroadcast(c, 0, i, flags);
    }

    static void fail(Context c, String id, String error) {
        Store.setLastError(c, error);
        Store.enqueue(c, id, "failed", error);
        GatewayService.kick(c);
    }
}
