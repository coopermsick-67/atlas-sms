package com.atlas.smsbridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

class InboundSmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val pendingResult = goAsync()
        val prefs = context.getSharedPreferences("atlas_bridge", Context.MODE_PRIVATE)
        val base = prefs.getString("server_url", null)
        val token = prefs.getString("bridge_token", null)
        if (base.isNullOrBlank() || token.isNullOrBlank()) { pendingResult.finish(); return }
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
        val grouped = messages.groupBy { message -> normalizePhone(message.originatingAddress ?: "") to message.timestampMillis }
            .filterKeys { (phone, _) -> phone.isNotBlank() && BridgeStore.isKnownOrPendingNumber(context, phone) }
        Thread {
            try {
                grouped.forEach { (senderKey, parts) ->
                    val sender = senderKey.first
                    val body = parts.joinToString(separator = "") { it.messageBody ?: "" }.trim()
                    if (sender.isBlank() || body.isBlank()) return@forEach
                    BridgeStore.enqueueInbound(context, sender, body)
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
