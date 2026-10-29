package ru.finecrm.sms;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.telephony.TelephonyManager;

/**
 * Разговор закончился (1.4) — через минуту сторож передаст звонок в FineCRM,
 * даже если Android закрыл приложение. Минута — чтобы звонилка успела
 * дописать файл записи. Номер и сам звонок отсюда не берём: их приносит
 * журнал звонков, как и раньше.
 */
public class CallEndReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        if (intent == null || !TelephonyManager.ACTION_PHONE_STATE_CHANGED.equals(intent.getAction())) return;
        if (!Store.paired(c) || !Calls.enabled(c)) return;
        String state = intent.getStringExtra(TelephonyManager.EXTRA_STATE);
        if (TelephonyManager.EXTRA_STATE_IDLE.equals(state)) {
            Watchdog.soon(c.getApplicationContext(), 60 * 1000);
        }
    }
}
