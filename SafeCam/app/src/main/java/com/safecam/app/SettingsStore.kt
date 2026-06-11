package com.safecam.app

import android.content.Context

/** Lightweight wrapper over SharedPreferences for user recording preferences. */
class SettingsStore(context: Context) {

    private val prefs = context.getSharedPreferences("safecam_prefs", Context.MODE_PRIVATE)

    /** Boost exposure for low-light / night scenes. */
    var nightMode: Boolean
        get() = prefs.getBoolean(KEY_NIGHT, true)
        set(value) = prefs.edit().putBoolean(KEY_NIGHT, value).apply()

    /** Turn on the torch/flashlight while recording (only when night mode is on). */
    var useTorch: Boolean
        get() = prefs.getBoolean(KEY_TORCH, false)
        set(value) = prefs.edit().putBoolean(KEY_TORCH, value).apply()

    /** Record audio along with video. */
    var recordAudio: Boolean
        get() = prefs.getBoolean(KEY_AUDIO, true)
        set(value) = prefs.edit().putBoolean(KEY_AUDIO, value).apply()

    /** Use the front camera instead of the back camera. */
    var useFrontCamera: Boolean
        get() = prefs.getBoolean(KEY_FRONT, false)
        set(value) = prefs.edit().putBoolean(KEY_FRONT, value).apply()

    /** Auto-start recording after device reboot. */
    var startOnBoot: Boolean
        get() = prefs.getBoolean(KEY_BOOT, false)
        set(value) = prefs.edit().putBoolean(KEY_BOOT, value).apply()

    /** Split recording into segments of this length (minutes); 0 = single file. */
    var segmentMinutes: Int
        get() = prefs.getInt(KEY_SEGMENT, 10)
        set(value) = prefs.edit().putInt(KEY_SEGMENT, value).apply()

    companion object {
        private const val KEY_NIGHT = "night_mode"
        private const val KEY_TORCH = "use_torch"
        private const val KEY_AUDIO = "record_audio"
        private const val KEY_FRONT = "use_front"
        private const val KEY_BOOT = "start_on_boot"
        private const val KEY_SEGMENT = "segment_minutes"
    }
}
