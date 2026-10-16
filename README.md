# Atlas SMS

Atlas SMS is a local-first lead CRM and bulk SMS campaign tool for wholesale real estate. Lead import, consent records, campaign review, message history, and suppression data are stored in a SQLite database on the computer running the app.

The repository includes an in-house Android companion app. It receives approved message jobs from the local computer and sends them through the Android phone's default SIM. No Twilio account, outside CRM, or third-party SMS dashboard is used. A mobile carrier and an active SIM are still required to deliver SMS.

## Start the dashboard

Requirements: Node.js 20 or newer.

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. On first launch, create a local workspace password. The development dashboard uses Vite; the API and SQLite database run on this computer.

For a local production build:

```bash
npm run build
```

Then start the API and static dashboard together:

```bash
NODE_ENV=production npm start
```

On Windows PowerShell, use `$env:NODE_ENV="production"; npm start`.

The SQLite file is written to `data/atlas.sqlite`. Set `ATLAS_DATA_DIR` to a different local folder if you want to keep it elsewhere. Back up that folder to preserve leads, campaign history, and opt-out records.

## Import a lead file

Choose **Import CSV**, select a file, and map its columns. The app accepts common column names and lets you override the mapping. It rejects duplicate or blank headers, extra values beyond a row's headers, files over 7 MB, and imports over 50,000 rows. Download `public/atlas-leads-template.csv` from the app's empty state for the recommended headers.

Consent does not come from having a phone number or a property record. A CSV row is marked consented only when it contains all of these fields:

- `sms_consent`: an explicit affirmative value such as `yes`
- `consent_source`: where the person opted in
- `consent_evidence`: an auditable reference to the consent record
- `consent_date`: when the consent was given

Other imported rows stay blocked from live campaigns. The UI also lets an admin record consent evidence by hand. You are responsible for verifying that the record is valid for your use and business.

## Pair the Android SIM bridge

1. Open **Settings & phone** in the dashboard and generate a one-time pairing code.
2. Open the `android/` project in Android Studio on your computer and build/install the companion APK on your Android phone. The companion app source is included in this repository; no other messaging app is required.
3. Connect the phone and computer to the same Wi-Fi network. Enter the local computer address and the 6-digit code in Atlas SMS Bridge. The code expires after five minutes.
4. Allow **Send SMS** and **Receive SMS** permissions. Keep the bridge active while a live campaign is running. On dual-SIM phones, choose the default outgoing SIM in Android settings.

The admin dashboard and its API accept connections only from this computer. The phone bridge accepts private-network connections, stores its pairing token on the phone, and Atlas SMS stores only a hash of that token. The local app uses HTTP on the local network; do not expose or port-forward it to the public internet.

## Campaign behavior

- New campaigns default to **Dry run**. A dry run records a preview without sending any text.
- Live send requires a paired, online Android phone, documented consent, a valid unsuppressed number, a typed recipient-count confirmation, and available daily capacity.
- The app caps live sends at 100 texts per rolling 24-hour period. The cap can be lowered in settings. Active queued messages reserve capacity, and canceled campaigns still count messages already attempted.
- The phone rejects a personalized message that would split into more than six SMS segments, and Atlas checks its estimate before a campaign can be queued.
- Messages are sent one at a time by the Android SIM. A failed message is logged and is not automatically retried.
- Inbound replies from numbers the phone has actually messaged are queued on the phone until the local server acknowledges them, then copied to the conversation history. STOP and common opt-out replies are locally blocked as soon as the phone receives them; the server records the suppression, even if the lead row is missing, and cancels queued messages. The app does not send a follow-up text after an opt-out.
- If a phone goes offline after claiming a job, the status changes to **unknown** after five minutes. The app does not automatically retry an uncertain send, which avoids accidental duplicate texts.

## Important limits

This app provides workflow safeguards; it does not determine whether a particular campaign is legally permitted. Confirm consent, applicable federal and state rules, carrier terms, and the recipient's local time before sending. Public-property data alone is not SMS consent. The FCC's consumer guide on unwanted calls and texts is at <https://www.fcc.gov/consumers/guides/stop-unwanted-robocalls-and-texts>.

Consumer SIM plans and Android device policies may not permit high-volume commercial texting. The carrier controls delivery, filtering, and account limits. Do not use the bridge for messages your plan or applicable law does not permit.

## Development checks

```bash
npm test
npm run build
```
