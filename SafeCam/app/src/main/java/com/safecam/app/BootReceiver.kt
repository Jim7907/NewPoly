package com.safecam.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restarts recording after a reboot, but only if the user opted in. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (SettingsStore(context).startOnBoot) {
            RecordingService.start(context)
        }
    }
}
