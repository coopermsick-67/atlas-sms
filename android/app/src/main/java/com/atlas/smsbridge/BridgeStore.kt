package com.atlas.smsbridge

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

object BridgeStore {
    private const val PREFS = "atlas_bridge"
    private const val PENDING_INBOUND = "pending_inbound"
    private const val KNOWN_NUMBERS = "known_numbers"
    private const val PENDING_NUMBERS = "pending_numbers"
    private const val SUPPRESSED_NUMBERS = "locally_suppressed_numbers"
    private const val MAX_PENDING_INBOUND = 500
    private val lock = Any()

    fun enqueueInbound(context: Context, phone: String, body: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val optedOut = OptOutRules.matches(body)
        synchronized(lock) {
            val queued = readQueue(prefs)
            if (optedOut && containsPendingOptOut(queued, phone)) {
                saveLocalSuppression(prefs, phone)
                return
            }
            if (queued.length() >= MAX_PENDING_INBOUND) {
                if (!optedOut) return
                removeOldestNonOptOut(queued)
            }
            val event = JSONObject()
                .put("id", java.util.UUID.randomUUID().toString())
                .put("phone", phone)
                .put("body", body)
            queued.put(event)
            val editor = prefs.edit().putString(PENDING_INBOUND, queued.toString())
            if (optedOut) {
                val suppressed = prefs.getStringSet(SUPPRESSED_NUMBERS, emptySet())?.toMutableSet() ?: mutableSetOf()
                suppressed.add(phone)
                editor.putStringSet(SUPPRESSED_NUMBERS, suppressed)
            }
            editor.commit()
        }
    }

    fun pendingInbound(context: Context): List<JSONObject> = synchronized(lock) {
        val queue = readQueue(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE))
        (0 until queue.length()).mapNotNull { index -> queue.optJSONObject(index) }
    }

    fun removePendingInbound(context: Context, id: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        synchronized(lock) {
            val queue = readQueue(prefs)
            val remaining = JSONArray()
            for (index in 0 until queue.length()) {
                val event = queue.optJSONObject(index) ?: continue
                if (event.optString("id") != id) remaining.put(event)
            }
            prefs.edit().putString(PENDING_INBOUND, remaining.toString()).commit()
        }
    }

    fun isLocallySuppressed(context: Context, phone: String): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getStringSet(SUPPRESSED_NUMBERS, emptySet())?.contains(phone) == true

    fun acknowledgeOptOut(context: Context, phone: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        synchronized(lock) {
            val suppressed = prefs.getStringSet(SUPPRESSED_NUMBERS, emptySet())?.toMutableSet() ?: mutableSetOf()
            suppressed.remove(phone)
            prefs.edit().putStringSet(SUPPRESSED_NUMBERS, suppressed).commit()
        }
    }

    fun isKnownOrPendingNumber(context: Context, phone: String): Boolean {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return prefs.getStringSet(KNOWN_NUMBERS, emptySet())?.contains(phone) == true
            || prefs.getStringSet(PENDING_NUMBERS, emptySet())?.contains(phone) == true
    }

    fun markOutboundPending(context: Context, phone: String) {
        updateNumberSets(context) { known, pending -> pending.add(phone) }
    }

    fun finishOutbound(context: Context, phone: String, success: Boolean) {
        updateNumberSets(context) { known, pending ->
            pending.remove(phone)
            if (success) known.add(phone)
        }
    }

    fun setInflight(context: Context, jobId: String, phone: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        synchronized(lock) {
            prefs.edit().putString("inflight_job", jobId).putString("inflight_phone", phone)
                .putLong("inflight_started_at", System.currentTimeMillis()).commit()
        }
    }

    fun clearStaleInflight(context: Context, now: Long, maxAgeMs: Long): Boolean {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        synchronized(lock) {
            if (prefs.getString("inflight_job", null).isNullOrBlank()) return false
            val startedAt = prefs.getLong("inflight_started_at", 0L)
            if (startedAt == 0L) {
                prefs.edit().putLong("inflight_started_at", now).commit()
                return false
            }
            if (now - startedAt < maxAgeMs) return false
            val phone = prefs.getString("inflight_phone", null).orEmpty()
            val known = prefs.getStringSet(KNOWN_NUMBERS, emptySet())?.toMutableSet() ?: mutableSetOf()
            val pending = prefs.getStringSet(PENDING_NUMBERS, emptySet())?.toMutableSet() ?: mutableSetOf()
            if (phone.isNotBlank()) {
                pending.remove(phone)
                known.add(phone)
            }
            prefs.edit().putStringSet(KNOWN_NUMBERS, known).putStringSet(PENDING_NUMBERS, pending)
                .remove("inflight_job").remove("inflight_phone").remove("inflight_started_at").commit()
            return true
        }
    }

    fun clearInflightIfMatches(context: Context, jobId: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        synchronized(lock) {
            if (prefs.getString("inflight_job", null) == jobId) {
                prefs.edit().remove("inflight_job").remove("inflight_phone").remove("inflight_started_at").commit()
            }
        }
    }

    fun clearInflight(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        synchronized(lock) {
            prefs.edit().remove("inflight_job").remove("inflight_phone").remove("inflight_started_at").commit()
        }
    }

    private fun updateNumberSets(context: Context, update: (MutableSet<String>, MutableSet<String>) -> Unit) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        synchronized(lock) {
            val known = prefs.getStringSet(KNOWN_NUMBERS, emptySet())?.toMutableSet() ?: mutableSetOf()
            val pending = prefs.getStringSet(PENDING_NUMBERS, emptySet())?.toMutableSet() ?: mutableSetOf()
            update(known, pending)
            prefs.edit().putStringSet(KNOWN_NUMBERS, known).putStringSet(PENDING_NUMBERS, pending).commit()
        }
    }

    private fun readQueue(prefs: android.content.SharedPreferences): JSONArray = try {
        JSONArray(prefs.getString(PENDING_INBOUND, "[]") ?: "[]")
    } catch (_: Exception) {
        JSONArray()
    }

    private fun containsPendingOptOut(queue: JSONArray, phone: String): Boolean {
        for (index in 0 until queue.length()) {
            val event = queue.optJSONObject(index) ?: continue
            if (event.optString("phone") == phone && OptOutRules.matches(event.optString("body"))) return true
        }
        return false
    }

    private fun removeOldestNonOptOut(queue: JSONArray) {
        val replacement = JSONArray()
        var removed = false
        for (index in 0 until queue.length()) {
            val event = queue.optJSONObject(index) ?: continue
            if (!removed && !OptOutRules.matches(event.optString("body"))) {
                removed = true
                continue
            }
            replacement.put(event)
        }
        if (removed) {
            while (queue.length() > 0) queue.remove(queue.length() - 1)
            for (index in 0 until replacement.length()) queue.put(replacement.getJSONObject(index))
        }
    }

    private fun saveLocalSuppression(prefs: android.content.SharedPreferences, phone: String) {
        val suppressed = prefs.getStringSet(SUPPRESSED_NUMBERS, emptySet())?.toMutableSet() ?: mutableSetOf()
        suppressed.add(phone)
        prefs.edit().putStringSet(SUPPRESSED_NUMBERS, suppressed).commit()
    }
}
