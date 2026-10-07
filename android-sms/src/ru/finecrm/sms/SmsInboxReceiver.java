package ru.finecrm.sms;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import android.telephony.SmsMessage;

/**
 * Входящие SMS: ответы клиентов на согласование ремонта.
 *
 * Пересылаем в FineCRM только SMS с номеров, от которых мастерская ждёт
 * ответа — этот список сервер присылает вместе с заданиями (Store.watching).
 * Всё остальное, личные сообщения в том числе, остаётся на телефоне и никуда
 * не уходит. Само сообщение у получателя на телефоне тоже остаётся: мы его
 * только читаем, не удаляем и не перехватываем.
 */
public class SmsInboxReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        if (intent == null || !Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) return;
        if (!Store.paired(c)) return;
        SmsMessage[] parts;
        try {
            parts = Telephony.Sms.Intents.getMessagesFromIntent(intent);
        } catch (Exception e) {
            return;
        }
        if (parts == null || parts.length == 0) return;
        // Длинная SMS приходит частями — склеиваем по отправителю.
        String from = null;
        StringBuilder text = new StringBuilder();
        long at = 0;
        for (SmsMessage m : parts) {
            if (m == null) continue;
            if (from == null) from = m.getOriginatingAddress();
            String body = m.getMessageBody();
            if (body != null) text.append(body);
            if (at == 0) at = m.getTimestampMillis();
        }
        if (from == null || !Store.watching(c, from)) return;
        Store.enqueueIncoming(c, from, text.toString(), at > 0 ? at : System.currentTimeMillis());
        GatewayService.kick(c);
    }
}
