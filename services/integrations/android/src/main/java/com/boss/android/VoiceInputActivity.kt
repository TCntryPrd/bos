package com.boss.android

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException

class VoiceInputActivity : AppCompatActivity() {
    
    private var mediaRecorder: MediaRecorder? = null
    private var mediaPlayer: MediaPlayer? = null
    private var audioFileName: String? = null
    
    companion object {
        private const val REQUEST_RECORD_AUDIO_PERMISSION = 200
    }
    
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // Check for microphone permission
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) 
            != PackageManager.PERMISSION_GRANTED) {
            
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.RECORD_AUDIO),
                REQUEST_RECORD_AUDIO_PERMISSION
            )
        } else {
            startRecordingAndProcessing()
        }
    }
    
    private fun startRecordingAndProcessing() {
        try {
            // Create temporary audio file
            val fileName = "${externalCacheDir?.absolutePath}/temp_audio_${System.currentTimeMillis()}.3gp"
            audioFileName = fileName
            
            mediaRecorder = MediaRecorder().apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.THREE_GPP)
                setOutputFile(fileName)
                setAudioEncoder(MediaRecorder.AudioEncoder.AMR_NB)
                
                prepare()
                start()
            }
            
            // Record for 5 seconds then process
            Thread {
                Thread.sleep(5000) // Record for 5 seconds
                finishRecording()
            }.start()
            
        } catch (e: Exception) {
            Toast.makeText(this, "Error starting recording: ${e.message}", Toast.LENGTH_LONG).show()
            finish()
        }
    }
    
    private fun finishRecording() {
        try {
            mediaRecorder?.apply {
                stop()
                release()
            }
            mediaRecorder = null
            
            // Process the recorded audio
            audioFileName?.let { fileName ->
                sendAudioForProcessing(fileName)
            }
        } catch (e: Exception) {
            Toast.makeText(this, "Error finishing recording: ${e.message}", Toast.LENGTH_LONG).show()
            finish()
        }
    }
    
    private fun sendAudioForProcessing(audioFilePath: String) {
        Thread {
            try {
                val client = OkHttpClient()
                
                // Convert audio file to request body
                val audioFile = File(audioFilePath)
                val requestBody = MultipartBody.Builder().setType(MultipartBody.FORM)
                    .addFormDataPart(
                        "file", 
                        audioFile.name,
                        audioFile.asRequestBody("audio/3gpp".toMediaTypeOrNull())
                    )
                    .build()
                
                val request = Request.Builder()
                    .url("http://127.0.0.1:8001/voice-command")
                    // Token injected at build time via BuildConfig.
                    // See build.gradle (app module) — add:
                    //   buildConfigField "String", "BOSS_API_TOKEN",
                    //     "\"${System.getenv("BOSS_API_TOKEN") ?: ""}\""
                    .addHeader("Authorization", "Bearer ${BuildConfig.BOSS_API_TOKEN}")
                    .post(requestBody)
                    .build()
                
                val response = client.newCall(request).execute()
                
                if (response.isSuccessful) {
                    val responseBody = response.body?.string()
                    // Parse the response to get the audio URL
                    // This is a simplified approach - in a real app, we'd use proper JSON parsing
                    if (responseBody != null) {
                        runOnUiThread {
                            playTtsResponse(responseBody)
                        }
                    }
                } else {
                    runOnUiThread {
                        Toast.makeText(this, "API request failed: ${response.code}", Toast.LENGTH_LONG).show()
                        finish()
                    }
                }
            } catch (e: Exception) {
                runOnUiThread {
                    Toast.makeText(this, "Error processing audio: ${e.message}", Toast.LENGTH_LONG).show()
                    finish()
                }
            }
        }.start()
    }
    
    private fun playTtsResponse(responseJson: String) {
        // Simple approach: look for audio URL in response
        // In a real implementation, we'd properly parse the JSON
        try {
            // Look for the audio URL in the response
            // The API returns a JSON response with audio_url field
            // Example: {"transcript":"hello","intent":"UNKNOWN","response":"Hello there","audio_url":"/boss/tts/speak"}
            
            // For now, simulate playing a TTS response based on the text response
            val simulatedResponse = "IR Custom AIOS processed your request successfully"
            
            // In a real implementation, we would download and play the actual TTS audio
            // For demo purposes, we'll just show a toast and finish
            Toast.makeText(this, simulatedResponse, Toast.LENGTH_LONG).show()
            
            // Clean up audio file
            audioFileName?.let { fileName ->
                File(fileName).delete()
            }
            
            // Close the activity after a delay
            Thread {
                Thread.sleep(2000)
                runOnUiThread {
                    finish()
                }
            }.start()
            
        } catch (e: Exception) {
            Toast.makeText(this, "Error playing response: ${e.message}", Toast.LENGTH_LONG).show()
            finish()
        }
    }
    
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        
        when (requestCode) {
            REQUEST_RECORD_AUDIO_PERMISSION -> {
                if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                    startRecordingAndProcessing()
                } else {
                    Toast.makeText(this, "Microphone permission is required to use voice commands", Toast.LENGTH_LONG).show()
                    finish()
                }
            }
        }
    }
    
    override fun onDestroy() {
        super.onDestroy()
        
        mediaRecorder?.apply {
            release()
        }
        mediaRecorder = null
        
        mediaPlayer?.apply {
            if (isPlaying) {
                stop()
            }
            release()
        }
        mediaPlayer = null
        
        // Clean up audio file if it exists
        audioFileName?.let { fileName ->
            File(fileName).delete()
        }
    }
}