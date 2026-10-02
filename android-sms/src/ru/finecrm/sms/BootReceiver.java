package ru.finecrm.sms;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Телефон перезагрузился или приложение обновилось — шлюз снова на связи сам. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent intent) {
        if (Store.paired(c)) GatewayService.start(c);
    }
}
