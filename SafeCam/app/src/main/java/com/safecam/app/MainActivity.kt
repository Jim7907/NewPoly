package com.safecam.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.safecam.app.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var settings: SettingsStore

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { result ->
        val cameraGranted = result[Manifest.permission.CAMERA] == true
        if (cameraGranted) {
            RecordingService.start(this)
            refreshUi(recording = true)
        } else {
            binding.statusText.setText(R.string.status_need_camera)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        settings = SettingsStore(this)

        bindSettingsToggles()

        binding.startButton.setOnClickListener { requestPermissionsAndStart() }
        binding.stopButton.setOnClickListener {
            RecordingService.stop(this)
            refreshUi(recording = false)
        }

        refreshUi(recording = false)
    }

    private fun bindSettingsToggles() {
        binding.nightSwitch.isChecked = settings.nightMode
        binding.torchSwitch.isChecked = settings.useTorch
        binding.audioSwitch.isChecked = settings.recordAudio
        binding.frontSwitch.isChecked = settings.useFrontCamera
        binding.bootSwitch.isChecked = settings.startOnBoot

        binding.nightSwitch.setOnCheckedChangeListener { _, v -> settings.nightMode = v }
        binding.torchSwitch.setOnCheckedChangeListener { _, v -> settings.useTorch = v }
        binding.audioSwitch.setOnCheckedChangeListener { _, v -> settings.recordAudio = v }
        binding.frontSwitch.setOnCheckedChangeListener { _, v -> settings.useFrontCamera = v }
        binding.bootSwitch.setOnCheckedChangeListener { _, v -> settings.startOnBoot = v }
    }

    private fun requestPermissionsAndStart() {
        val needed = mutableListOf(Manifest.permission.CAMERA)
        if (settings.recordAudio) needed.add(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS)
        }

        val allGranted = needed.all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }
        if (allGranted) {
            RecordingService.start(this)
            refreshUi(recording = true)
        } else {
            permissionLauncher.launch(needed.toTypedArray())
        }
    }

    private fun refreshUi(recording: Boolean) {
        binding.startButton.isEnabled = !recording
        binding.stopButton.isEnabled = recording
        binding.statusText.setText(
            if (recording) R.string.status_recording else R.string.status_idle
        )
    }
}
