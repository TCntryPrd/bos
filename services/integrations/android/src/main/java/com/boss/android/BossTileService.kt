package com.boss.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * Android TileService that appears in Quick Settings panel.
 * Tile label: "IR Custom AIOS"
 * Tap: opens voice input activity that records mic, sends to POST /spoken-command, 
 * plays TTS response via MediaPlayer
 */
class IR Custom AIOSTileService : TileService() {
    
    override fun onClick() {
        super.onClick()
        
        // Check if we have microphone permission
        if (hasMicrophonePermission()) {
            // Start the voice input activity
            val intent = Intent(this, VoiceInputActivity::class.java)
            intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            startActivityAndCollapse(intent)
        } else {
            // Request permission and notify user
            qsTile?.let {
                it.state = Tile.STATE_UNAVAILABLE
                it.label = "Mic Permission Needed"
                it.updateTile()
            }
        }
    }
    
    override fun onStartListening() {
        super.onStartListening()
        
        qsTile?.let {
            it.state = Tile.STATE_ACTIVE
            it.label = "IR Custom AIOS"
            it.updateTile()
        }
    }
    
    private fun hasMicrophonePermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.RECORD_AUDIO
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            // On older versions, permissions are granted at install time
            true
        }
    }
}