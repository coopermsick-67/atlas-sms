package com.atlas.smsbridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.telephony.SmsManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class BridgeService : Service() {
    private val executor = Executors.newSingleThreadExecutor()
    private val active = AtomicBoolean(false)
    private val prefs by lazy { getSharedPreferences("atlas_bridge", MODE_PRIVATE) }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            active.set(false)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        startForeground(NOTIFICATION_ID, notification())
        if (active.compareAndSet(false, true)) executor.execute { pollLoop() }
        return START_STICKY
    }

    private fun pollLoop() {
        while (active.get()) {
            val base = prefs.getString("server_url", null)
            val token = prefs.getString("bridge_token", null)
            if (base.isNullOrBlank() || token.isNullOrBlank()) {
                active.set(false)
                stopSelf()
                break
            }
            try {
                postJson("$base/api/bridge/heartbeat", token, JSONObject().put("phone_number", ""))
                val inflightJob = prefs.getString("inflight_job", null)
                if (!inflightJob.isNullOrBlank()) {
                    val startedAt = prefs.getLong("inflight_started_at", 0L)
                    if (startedAt == 0L) {
                        prefs.edit().putLong("inflight_started_at", System.currentTimeMillis()).apply()
                    } else if (System.currentTimeMillis() - startedAt >= 6 * 60 * 1000L) {
                        // The server marks jobs unknown after five minutes. Clear the local
                        // lock after that point, but never retry the uncertain SMS.
                        prefs.edit().remove("inflight_job").remove("inflight_started_at").apply()
                    }
                }
                if (prefs.getString("inflight_job", null).isNullOrBlank()) {
                    val result = requestJson("$base/api/bridge/jobs/next", token)
                    if (!result.isNull("job")) {
                        val job = result.getJSONObject("job")
                        val id = job.getString("id")
                        prefs.edit().putString("inflight_job", id).putLong("inflight_started_at", System.currentTimeMillis()).apply()
                        sendJob(base, token, job)
                    }
                }
            } catch (_: Exception) {
                Thread.sleep(4000)
            }
            if (active.get()) Thread.sleep(3000)
        }
    }

    private fun sendJob(base: String, token: String, job: JSONObject) {
        try {
            val numbers = (prefs.getStringSet("known_numbers", emptySet()) ?: emptySet()).toMutableSet()
            numbers.add(job.getString("phone"))
            prefs.edit().putStringSet("known_numbers", numbers).apply()
            val manager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) getSystemService(SmsManager::class.java) else SmsManager.getDefault()
            val body = job.getString("message")
            val parts = manager.divideMessage(body)
            if (parts.size > 6) {
                reportResult(base, token, job.getString("id"), false, "Message is too long for the local SMS bridge.")
                return
            }
            val sentIntents = ArrayList<PendingIntent>()
            parts.forEachIndexed { index, _ ->
                val callback = Intent(this, SmsStatusReceiver::class.java).apply {
                    action = ACTION_SMS_SENT
                    putExtra(EXTRA_JOB_ID, job.getString("id"))
                    putExtra(EXTRA_SERVER_URL, base)
                    putExtra(EXTRA_TOKEN, token)
                    putExtra(EXTRA_SEGMENT_INDEX, index)
                    putExtra(EXTRA_SEGMENT_COUNT, parts.size)
                }
                val requestCode = (job.getString("id").hashCode() * 31) + index
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
                sentIntents.add(PendingIntent.getBroadcast(this, requestCode, callback, flags))
            }
            if (parts.size == 1) manager.sendTextMessage(job.getString("phone"), null, body, sentIntents[0], null)
            else manager.sendMultipartTextMessage(job.getString("phone"), null, parts, sentIntents, null)
        } catch (error: Exception) {
            reportResult(base, token, job.getString("id"), false, error.message ?: "Android could not send this SMS.")
        }
    }

    private fun reportResult(base: String, token: String, jobId: String, success: Boolean, error: String) {
        try {
            postJson("$base/api/bridge/jobs/$jobId/result", token, JSONObject().put("success", success).put("error", error.take(240)))
        } catch (_: Exception) { }
        prefs.edit().remove("inflight_job").remove("inflight_started_at").apply()
    }

    private fun requestJson(address: String, token: String): JSONObject {
        val connection = (URL(address).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"; connectTimeout = 8000; readTimeout = 8000
            setRequestProperty("Authorization", "Bearer $token")
        }
        return connection.inputStream.bufferedReader().use { JSONObject(it.readText()) }
    }

    private fun postJson(address: String, token: String, json: JSONObject): JSONObject {
        val connection = (URL(address).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"; connectTimeout = 8000; readTimeout = 8000; doOutput = true
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Content-Type", "application/json")
        }
        connection.outputStream.use { it.write(json.toString().toByteArray()) }
        return connection.inputStream.bufferedReader().use { JSONObject(it.readText()) }
    }

    private fun notification(): Notification {
        val channelId = "atlas_sms_bridge"
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) manager.createNotificationChannel(NotificationChannel(channelId, "Atlas SMS Bridge", NotificationManager.IMPORTANCE_LOW))
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
        val openApp = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), flags)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return Notification.Builder(this, channelId)
                .setSmallIcon(android.R.drawable.sym_action_chat).setContentTitle("Atlas SMS Bridge is active")
                .setContentText("Waiting for reviewed campaign messages").setOngoing(true).setContentIntent(openApp).build()
        }
        @Suppress("DEPRECATION")
        return Notification.Builder(this).setSmallIcon(android.R.drawable.sym_action_chat)
            .setContentTitle("Atlas SMS Bridge is active").setContentText("Waiting for reviewed campaign messages")
            .setOngoing(true).setContentIntent(openApp).build()
    }

    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() { active.set(false); executor.shutdownNow(); super.onDestroy() }

    companion object {
        const val ACTION_START = "com.atlas.smsbridge.START"
        const val ACTION_STOP = "com.atlas.smsbridge.STOP"
        const val ACTION_SMS_SENT = "com.atlas.smsbridge.SMS_SENT"
        const val EXTRA_JOB_ID = "job_id"
        const val EXTRA_SERVER_URL = "server_url"
        const val EXTRA_TOKEN = "bridge_token"
        const val EXTRA_SEGMENT_INDEX = "segment_index"
        const val EXTRA_SEGMENT_COUNT = "segment_count"
        private const val NOTIFICATION_ID = 7401
    }
}
