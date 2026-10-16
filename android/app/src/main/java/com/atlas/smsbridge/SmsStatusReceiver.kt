package com.atlas.smsbridge

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

class SmsStatusReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != BridgeService.ACTION_SMS_SENT) return
        val jobId = intent.getStringExtra(BridgeService.EXTRA_JOB_ID) ?: return
        val base = intent.getStringExtra(BridgeService.EXTRA_SERVER_URL) ?: return
        val token = intent.getStringExtra(BridgeService.EXTRA_TOKEN) ?: return
        val index = intent.getIntExtra(BridgeService.EXTRA_SEGMENT_INDEX, 0)
        val count = intent.getIntExtra(BridgeService.EXTRA_SEGMENT_COUNT, 1)
        val success = resultCode == Activity.RESULT_OK
        val prefs = context.getSharedPreferences("atlas_bridge", Context.MODE_PRIVATE)
        val doneKey = "sms_done_$jobId"
        val failKey = "sms_fail_$jobId"
        val done = prefs.getInt(doneKey, 0) + 1
        val previousFailures = prefs.getInt(failKey, 0)
        val failures = previousFailures + if (success) 0 else 1
        prefs.edit().putInt(doneKey, done).putInt(failKey, failures).apply()
        if (done < count) return
        val error = if (failures > 0) "Android SMS send failed (result ${resultCode}, segment ${index + 1}/$count)." else ""
        prefs.edit().remove(doneKey).remove(failKey).apply()
        Thread {
            try {
                val connection = (URL("$base/api/bridge/jobs/$jobId/result").openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"; connectTimeout = 10000; readTimeout = 10000; doOutput = true
                    setRequestProperty("Authorization", "Bearer $token")
                    setRequestProperty("Content-Type", "application/json")
                }
                connection.outputStream.use { it.write(JSONObject().put("success", failures == 0).put("error", error).toString().toByteArray()) }
                connection.inputStream.close()
            } catch (_: Exception) { }
            finally { prefs.edit().remove("inflight_job").remove("inflight_started_at").apply() }
        }.start()
    }
}
