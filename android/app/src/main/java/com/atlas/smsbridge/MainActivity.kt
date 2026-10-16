package com.atlas.smsbridge

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.URL
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val prefs by lazy { getSharedPreferences("atlas_bridge", MODE_PRIVATE) }
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var serverInput: EditText
    private lateinit var codeInput: EditText
    private lateinit var deviceInput: EditText
    private lateinit var statusText: TextView
    private lateinit var pairButton: Button
    private lateinit var serviceButton: Button
    private lateinit var unpairButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        fillSavedState()
        if (hasBridgeToken()) showPairedState() else showUnpairedState()
    }

    private fun buildUi() {
        val outer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(20), dp(22), dp(24))
            setBackgroundColor(0xFFF6F8F6.toInt())
        }
        val scroll = ScrollView(this).apply { addView(outer) }
        val brand = TextView(this).apply {
            text = "Atlas SMS  /  Bridge"
            textSize = 22f
            setTextColor(0xFF15211C.toInt())
            typeface = Typeface.create("sans-serif-medium", Typeface.BOLD)
            setPadding(0, dp(4), 0, dp(4))
        }
        outer.addView(brand)
        outer.addView(text("Send reviewed Atlas campaigns through this phone’s SIM. Keep this app running while a campaign is active.", 14, 0xFF718078.toInt(), top = 3, bottom = 18))

        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(17), dp(16), dp(17), dp(17))
            background = rounded(0xFFFFFFFF.toInt(), 0xFFE3E9E5.toInt())
        }
        outer.addView(panel)
        panel.addView(text("Pair with your computer", 17, 0xFF203128.toInt(), bold = true, bottom = 13))
        serverInput = field("Computer address, for example http://192.168.1.12:3001")
        codeInput = field("6-digit one-time code", InputType.TYPE_CLASS_NUMBER)
        deviceInput = field("Phone name", InputType.TYPE_CLASS_TEXT).apply { setText(Build.MODEL.ifBlank { "Android phone" }) }
        panel.addView(serverInput, fieldParams())
        panel.addView(codeInput, fieldParams())
        panel.addView(deviceInput, fieldParams())
        pairButton = button("Pair phone", primary = true).also { panel.addView(it, fullWidthParams(top = 6)) }
        pairButton.setOnClickListener { pair() }

        statusText = text("", 12, 0xFF617167.toInt(), top = 14)
        panel.addView(statusText)
        serviceButton = button("Start SMS bridge", primary = true).also { panel.addView(it, fullWidthParams(top = 13)) }
        serviceButton.setOnClickListener { requestPermissionsThenStart() }
        unpairButton = button("Unpair this phone", primary = false).also { panel.addView(it, fullWidthParams(top = 8)) }
        unpairButton.setOnClickListener { unpair() }

        val note = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(13), dp(14), dp(13))
            background = rounded(0xFFFFF7E8.toInt(), 0xFFF4E6C9.toInt())
        }
        note.addView(text("Before live sending", 12, 0xFF81530F.toInt(), bold = true, bottom = 5))
        note.addView(text("Use a SIM with a plan that permits your messages. Android asks for SMS permissions. Set your default outgoing SIM in Android settings if this phone has two SIMs. Carrier rules and limits still apply.", 11, 0xFF876521.toInt()))
        outer.addView(note, fullWidthParams(top = 14))
        setContentView(scroll)
    }

    private fun pair() {
        val base = serverInput.text.toString().trim().trimEnd('/')
        val code = codeInput.text.toString().filter { it.isDigit() }
        val deviceName = deviceInput.text.toString().trim().ifBlank { "Android phone" }
        if (!isLocalServerAddress(base)) {
            statusText.text = "Use the local computer address shown in Atlas SMS Settings. Public server addresses are blocked so the phone token stays on your network."
            return
        }
        if (code.length != 6) { statusText.text = "Enter the 6-digit pairing code."; return }
        pairButton.isEnabled = false
        statusText.text = "Pairing with your computer…"
        executor.execute {
            try {
                val connection = URL("$base/api/bridge/pair").openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.connectTimeout = 8000
                connection.readTimeout = 8000
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(JSONObject().put("code", code).put("name", deviceName).toString().toByteArray()) }
                val response = connection.inputStream.bufferedReader().use { it.readText() }
                val data = JSONObject(response)
                prefs.edit().putString("server_url", base).putString("bridge_token", data.getString("token")).putString("device_id", data.getString("device_id")).putString("device_name", deviceName).apply()
                runOnUiThread { statusText.text = "Phone paired. Allow SMS access, then start the bridge."; pairButton.isEnabled = true; showPairedState() }
            } catch (error: Exception) {
                runOnUiThread { statusText.text = "Could not pair. Check the computer address, same Wi-Fi, and that the pairing code has not expired."; pairButton.isEnabled = true }
            }
        }
    }

    private fun requestPermissionsThenStart() {
        val needed = listOf(Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_SMS)
        val missing = needed.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) {
            requestPermissions(missing.toTypedArray(), PERMISSION_REQUEST)
            statusText.text = "Allow SMS permissions to send campaigns and process opt-out replies."
            return
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_PERMISSION_REQUEST)
            return
        }
        startBridgeService()
    }

    private fun startBridgeService() {
        val intent = Intent(this, BridgeService::class.java).setAction(BridgeService.ACTION_START)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent) else startService(intent)
        statusText.text = "Bridge running. Keep the phone online while messages are queued."
        serviceButton.text = "Bridge is running"
        serviceButton.isEnabled = false
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == NOTIFICATION_PERMISSION_REQUEST) {
            startBridgeService()
            return
        }
        if (requestCode != PERMISSION_REQUEST) return
        val smsPermissionsAllowed = checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED
                && checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
        if (smsPermissionsAllowed) requestPermissionsThenStart()
        else statusText.text = "SMS permission is required to send messages and honor inbound STOP replies."
    }

    private fun unpair() {
        stopService(Intent(this, BridgeService::class.java))
        val base = prefs.getString("server_url", null)
        val token = prefs.getString("bridge_token", null)
        if (!base.isNullOrBlank() && !token.isNullOrBlank()) executor.execute {
            try {
                val connection = URL("$base/api/bridge/device").openConnection() as HttpURLConnection
                connection.requestMethod = "DELETE"
                connection.connectTimeout = 5000
                connection.readTimeout = 5000
                connection.setRequestProperty("Authorization", "Bearer $token")
                connection.inputStream.close()
            } catch (_: Exception) { }
        }
        prefs.edit().remove("bridge_token").remove("device_id").remove("server_url").remove("inflight_job").remove("inflight_started_at").remove("known_numbers").apply()
        showUnpairedState()
        statusText.text = "This phone is unpaired. Revoke the device in Atlas SMS Settings if it is still shown there."
    }

    private fun fillSavedState() {
        serverInput.setText(prefs.getString("server_url", ""))
        deviceInput.setText(prefs.getString("device_name", Build.MODEL.ifBlank { "Android phone" }))
    }

    private fun hasBridgeToken() = !prefs.getString("bridge_token", null).isNullOrBlank()
    private fun showPairedState() {
        pairButton.visibility = View.GONE
        codeInput.visibility = View.GONE
        statusText.text = "This phone is paired. Tap Start SMS bridge to connect."
        serviceButton.visibility = View.VISIBLE
        unpairButton.visibility = View.VISIBLE
    }
    private fun showUnpairedState() {
        pairButton.visibility = View.VISIBLE
        codeInput.visibility = View.VISIBLE
        serviceButton.visibility = View.GONE
        unpairButton.visibility = View.GONE
    }

    private fun isLocalServerAddress(value: String): Boolean {
        return try {
            val url = URL(value)
            if (url.protocol != "http" || url.port !in 1..65535) return false
            val host = url.host.lowercase()
            if (host == "localhost") return true
            val address = java.net.InetAddress.getByName(host)
            if (address !is Inet4Address) return false
            val bytes = address.address.map { it.toInt() and 0xff }
            bytes[0] == 10 || (bytes[0] == 192 && bytes[1] == 168) || (bytes[0] == 172 && bytes[1] in 16..31) || (bytes[0] == 127) || (bytes[0] == 169 && bytes[1] == 254)
        } catch (_: Exception) { false }
    }

    private fun field(hintText: String, type: Int = InputType.TYPE_CLASS_TEXT) = EditText(this).apply {
        hint = hintText
        inputType = type
        textSize = 13f
        setTextColor(0xFF24352B.toInt())
        setHintTextColor(0xFF98A29C.toInt())
        setPadding(dp(11), dp(10), dp(11), dp(10))
        background = rounded(0xFFFFFFFF.toInt(), 0xFFDAE3DD.toInt())
    }

    private fun text(value: String, size: Int, color: Int, bold: Boolean = false, top: Int = 0, bottom: Int = 0) = TextView(this).apply {
        text = value
        textSize = size.toFloat()
        setTextColor(color)
        if (bold) typeface = Typeface.create("sans-serif-medium", Typeface.BOLD)
        setPadding(0, dp(top), 0, dp(bottom))
        gravity = Gravity.CENTER_VERTICAL
    }

    private fun button(label: String, primary: Boolean): Button = Button(this).apply {
        text = label
        textSize = 13f
        isAllCaps = false
        setTextColor(if (primary) 0xFFFFFFFF.toInt() else 0xFF405247.toInt())
        setBackgroundColor(if (primary) 0xFF146342.toInt() else 0xFFEAF1EC.toInt())
        minHeight = dp(48)
    }

    private fun rounded(fill: Int, stroke: Int): android.graphics.drawable.Drawable = android.graphics.drawable.GradientDrawable().apply {
        setColor(fill); cornerRadius = dp(7).toFloat(); setStroke(dp(1), stroke)
    }

    private fun fieldParams() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)).apply { bottomMargin = dp(9) }
    private fun fullWidthParams(top: Int = 0) = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(top) }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    companion object { private const val PERMISSION_REQUEST = 7001; private const val NOTIFICATION_PERMISSION_REQUEST = 7002 }
}
