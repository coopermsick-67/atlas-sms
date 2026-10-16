package com.atlas.smsbridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class InboundSmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val pendingResult = goAsync()
        val prefs = context.getSharedPreferences("atlas_bridge", Context.MODE_PRIVATE)
        val base = prefs.getString("server_url", null)
        val token = prefs.getString("bridge_token", null)
        if (base.isNullOrBlank() || token.isNullOrBlank()) { pendingResult.finish(); return }
        val knownNumbers = prefs.getStringSet("known_numbers", emptySet())?.toSet() ?: emptySet()
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        val grouped = messages.groupBy { normalizePhone(it.originatingAddress ?: "") }
            .filterKeys { it.isNotBlank() && it in knownNumbers }
        Thread {
            try {
                grouped.forEach { (sender, parts) ->
                    val body = parts.joinToString(separator = "") { it.messageBody ?: "" }.trim()
                    if (sender.isBlank() || body.isBlank()) return@forEach
                    try {
                        val connection = (URL("$base/api/bridge/inbound").openConnection() as HttpURLConnection).apply {
                            requestMethod = "POST"; connectTimeout = 10000; readTimeout = 10000; doOutput = true
                            setRequestProperty("Authorization", "Bearer $token")
                            setRequestProperty("Content-Type", "application/json")
                        }
                        connection.outputStream.use { it.write(JSONObject().put("phone", sender).put("body", body).toString().toByteArray()) }
                        val response = connection.inputStream.bufferedReader().use { JSONObject(it.readText()) }
                        if (response.optBoolean("opted_out")) {
                            val updated = (prefs.getStringSet("known_numbers", emptySet()) ?: emptySet()).toMutableSet()
                            updated.remove(sender)
                            prefs.edit().putStringSet("known_numbers", updated).apply()
                        }
                    } catch (_: Exception) { }
                }
            } finally { pendingResult.finish() }
        }.start()
    }

    private fun normalizePhone(value: String): String {
        val text = value.trim()
        val digits = text.filter { it.isDigit() }
        if (digits.length == 10) return "+1$digits"
        if (digits.length == 11 && digits.startsWith("1")) return "+$digits"
        if (text.startsWith("+") && digits.length in 8..15) return "+$digits"
        return ""
    }
}
