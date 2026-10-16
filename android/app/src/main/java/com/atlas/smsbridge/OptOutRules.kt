package com.atlas.smsbridge

import java.text.Normalizer
import java.util.Locale

object OptOutRules {
    private val exactReplies = setOf(
        "stop", "stopall", "stop all", "unsubscribe", "cancel", "end", "quit", "opt out",
        "remove", "remove me", "do not text", "dont text", "no more texts",
        "do not contact", "dont contact me"
    )
    private val optOutPattern = Regex("\\b(stop|unsubscribe|remove me|do not (text|contact)|dont (text|contact)|no more texts|opt out)\\b")

    fun matches(message: String): Boolean {
        val normalized = Normalizer.normalize(message, Normalizer.Form.NFKC)
            .lowercase(Locale.ROOT)
            .replace(Regex("['’]"), "")
            .replace(Regex("[^a-z0-9\\s]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
        return normalized.isNotEmpty() && (normalized in exactReplies || optOutPattern.containsMatchIn(normalized))
    }
}
