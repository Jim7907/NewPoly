package com.safecam.app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import android.widget.Toast
import androidx.camera.core.CameraSelector
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.MediaStoreOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Foreground service that performs background video recording with CameraX.
 *
 * A persistent notification is shown for the entire duration the camera is in
 * use, as required by Android for camera/microphone foreground services. This
 * app does not hide that it is recording.
 */
class RecordingService : LifecycleService() {

    private lateinit var settings: SettingsStore
    private var cameraProvider: ProcessCameraProvider? = null
    private var videoCapture: VideoCapture<Recorder>? = null
    private var activeRecording: Recording? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var segmentRunnable: Runnable? = null

    override fun onCreate() {
        super.onCreate()
        settings = SettingsStore(this)
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)

        when (intent?.action) {
            ACTION_STOP -> {
                stopRecordingAndService()
                return START_NOT_STICKY
            }
            else -> startForegroundWithNotification()
        }

        if (!hasRequiredPermissions()) {
            Toast.makeText(this, R.string.error_missing_permissions, Toast.LENGTH_LONG).show()
            stopRecordingAndService()
            return START_NOT_STICKY
        }

        startCamera()
        // If killed, restart so monitoring resumes.
        return START_STICKY
    }

    private fun startCamera() {
        val providerFuture = ProcessCameraProvider.getInstance(this)
        providerFuture.addListener({
            try {
                val provider = providerFuture.get()
                cameraProvider = provider
                bindAndRecord(provider)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start camera", e)
                Toast.makeText(this, R.string.error_camera_start, Toast.LENGTH_LONG).show()
                stopRecordingAndService()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun bindAndRecord(provider: ProcessCameraProvider) {
        provider.unbindAll()

        val recorder = Recorder.Builder()
            .setQualitySelector(
                QualitySelector.fromOrderedList(
                    listOf(Quality.HD, Quality.SD, Quality.FHD)
                )
            )
            .build()
        val capture = VideoCapture.withOutput(recorder)
        videoCapture = capture

        val selector = if (settings.useFrontCamera) {
            CameraSelector.DEFAULT_FRONT_CAMERA
        } else {
            CameraSelector.DEFAULT_BACK_CAMERA
        }

        // Bind without a Preview use case so recording works headless/in background.
        val camera = provider.bindToLifecycle(this, selector, capture)

        applyNightTuning(camera)
        beginRecording(capture)
    }

    /**
     * Low-light tuning for video: max out exposure compensation and optionally
     * enable the torch. (Image-capture NIGHT extensions are not used here
     * because they are generally unsupported for the VideoCapture use case.)
     */
    private fun applyNightTuning(camera: androidx.camera.core.Camera) {
        if (!settings.nightMode) return
        try {
            val range = camera.cameraInfo.exposureState.exposureCompensationRange
            if (camera.cameraInfo.exposureState.isExposureCompensationSupported) {
                camera.cameraControl.setExposureCompensationIndex(range.upper)
            }
            if (settings.useTorch && camera.cameraInfo.hasFlashUnit()) {
                camera.cameraControl.enableTorch(true)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Night tuning not fully applied", e)
        }
    }

    private fun beginRecording(capture: VideoCapture<Recorder>) {
        val name = "SafeCam_" +
            SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val contentValues = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, "video/mp4")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/SafeCam")
            }
        }
        val outputOptions = MediaStoreOutputOptions
            .Builder(contentResolver, MediaStore.Video.Media.EXTERNAL_CONTENT_URI)
            .setContentValues(contentValues)
            .build()

        var pending = capture.output.prepareRecording(this, outputOptions)

        val audioGranted = ActivityCompat.checkSelfPermission(
            this, Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
        if (settings.recordAudio && audioGranted) {
            pending = pending.withAudioEnabled()
        }

        activeRecording = pending.start(ContextCompat.getMainExecutor(this)) { event ->
            when (event) {
                is VideoRecordEvent.Start ->
                    Log.i(TAG, "Recording started: $name")
                is VideoRecordEvent.Finalize -> {
                    if (event.hasError()) {
                        Log.e(TAG, "Recording error: ${event.error}")
                    } else {
                        Log.i(TAG, "Saved: ${event.outputResults.outputUri}")
                    }
                }
            }
        }

        scheduleSegmentRollover(capture)
    }

    /** Roll over to a new file every N minutes so footage is chunked, not one huge file. */
    private fun scheduleSegmentRollover(capture: VideoCapture<Recorder>) {
        val minutes = settings.segmentMinutes
        segmentRunnable?.let { mainHandler.removeCallbacks(it) }
        if (minutes <= 0) return
        val runnable = Runnable {
            activeRecording?.stop()
            activeRecording = null
            beginRecording(capture)
        }
        segmentRunnable = runnable
        mainHandler.postDelayed(runnable, minutes * 60_000L)
    }

    private fun stopRecordingAndService() {
        segmentRunnable?.let { mainHandler.removeCallbacks(it) }
        segmentRunnable = null
        try {
            activeRecording?.stop()
        } catch (e: Exception) {
            Log.w(TAG, "Error stopping recording", e)
        }
        activeRecording = null
        cameraProvider?.unbindAll()
        cameraProvider = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        stopRecordingAndService()
        super.onDestroy()
    }

    private fun startForegroundWithNotification() {
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        val stopIntent = PendingIntent.getService(
            this, 1,
            Intent(this, RecordingService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_IMMUTABLE
        )

        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(getString(R.string.notif_text))
            .setSmallIcon(R.drawable.ic_record)
            .setOngoing(true)
            .setContentIntent(openIntent)
            .addAction(0, getString(R.string.action_stop), stopIntent)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIF_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            )
        } else {
            startForeground(NOTIF_ID, notification)
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.channel_desc)
            }
            getSystemService(NotificationManager::class.java)
                .createNotificationChannel(channel)
        }
    }

    private fun hasRequiredPermissions(): Boolean {
        val cam = ActivityCompat.checkSelfPermission(
            this, Manifest.permission.CAMERA
        ) == PackageManager.PERMISSION_GRANTED
        return cam
    }

    companion object {
        private const val TAG = "RecordingService"
        const val ACTION_STOP = "com.safecam.app.STOP"
        private const val CHANNEL_ID = "safecam_recording"
        private const val NOTIF_ID = 1001

        fun start(context: Context) {
            val intent = Intent(context, RecordingService::class.java)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, RecordingService::class.java).apply {
                action = ACTION_STOP
            }
            ContextCompat.startForegroundService(context, intent)
        }
    }
}
