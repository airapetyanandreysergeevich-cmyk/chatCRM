package ru.finecrm.sms;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.telephony.SmsManager;
import android.telephony.SmsMessage;

/**
 * Ответы Android о судьбе SMS: ушла ли с телефона и дошла ли до адресата.
 * Итог по всей SMS (а не по части) уходит серверу через очередь отчётов.
 */
public class SmsResultReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        String id = intent.getStringExtra("id");
        if (id == null) return;
        String action = intent.getAction();
        String result = null;
        String error = null;

        if (SmsSender.ACTION_SENT.equals(action)) {
            int code = getResultCode();
            if (code == Activity.RESULT_OK) {
                result = Store.part(c, id, "sent");
                if ("sent".equals(result)) Store.countSent(c);
            } else {
                error = reason(code);
                result = Store.part(c, id, "failed");
            }
        } else if (SmsSender.ACTION_DELIVERED.equals(action)) {
            int state = deliveryState(intent);
            if (state > 0) result = Store.part(c, id, "delivered");
            else if (state < 0) {
                error = "Оператор сообщил, что SMS не доставлена";
                result = Store.part(c, id, "failed");
            }
        }

        if (result != null) {
            if (error != null) Store.setLastError(c, error);
            Store.enqueue(c, id, result, error);
            GatewayService.kick(c);
        }
    }

    /** 1 — доставлена, -1 — не доставлена, 0 — ещё в пути или неизвестно. */
    @SuppressWarnings("deprecation")
    private static int deliveryState(Intent intent) {
        byte[] pdu = intent.getByteArrayExtra("pdu");
        if (pdu == null) return 1; // телефон не прислал подробностей — само сообщение о доставке и есть ответ
        try {
            String format = intent.getStringExtra("format");
            SmsMessage m = format != null ? SmsMessage.createFromPdu(pdu, format) : SmsMessage.createFromPdu(pdu);
            if (m == null) return 1;
            int status = m.getStatus();
            if ("3gpp2".equals(format)) {
                // CDMA: ошибка — в старших битах.
                int err = (status >> 24) & 0x03;
                return err == 0 ? 1 : err == 3 ? -1 : 0;
            }
            // GSM (TP-Status): 0x00–0x1F — доставлено, 0x20–0x3F — ещё пытаются, дальше — отказ.
            if (status < 0x20) return 1;
            if (status < 0x40) return 0;
            return -1;
        } catch (Exception e) {
            return 1;
        }
    }

    private static String reason(int code) {
        switch (code) {
            case SmsManager.RESULT_ERROR_RADIO_OFF:
                return "Связь выключена — режим полёта или нет SIM-карты";
            case SmsManager.RESULT_ERROR_NO_SERVICE:
                return "Нет сети оператора";
            case SmsManager.RESULT_ERROR_NULL_PDU:
                return "Android не смог собрать SMS";
            case 5: // RESULT_ERROR_LIMIT_EXCEEDED — числом: константа открыта не во всех версиях SDK
                return "Android ограничил количество SMS — подтвердите на телефоне";
            case 7: // RESULT_ERROR_SHORT_CODE_NOT_ALLOWED
            case 8: // RESULT_ERROR_SHORT_CODE_NEVER_ALLOWED
                return "На короткие номера отправка запрещена";
            default:
                return "Оператор не принял SMS (код " + code + ")";
        }
    }
}
