const db = require('../db');

/**
 * Sends a WhatsApp message via Meta's WhatsApp Cloud API.
 *
 * To activate real sending, set these environment variables:
 *   WHATSAPP_PHONE_NUMBER_ID   - from Meta Business > WhatsApp > API Setup
 *   WHATSAPP_ACCESS_TOKEN      - permanent access token for your app
 *
 * Until those are set, messages are only logged to the whatsapp_log table
 * and printed to the console — nothing is actually sent, so you can build
 * and test the rest of the app before signing up with Meta.
 */
async function sendWhatsApp(toPhone, message) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  const logRow = db
    .prepare(`INSERT INTO whatsapp_log (to_phone, message, status) VALUES (?, ?, 'queued')`)
    .run(toPhone, message);
  const logId = logRow.lastInsertRowid;

  if (!phoneNumberId || !accessToken) {
    console.log(`[WhatsApp - NOT CONFIGURED] Would send to ${toPhone}: ${message}`);
    db.prepare(`UPDATE whatsapp_log SET status='failed', error='WhatsApp credentials not configured' WHERE id=?`).run(logId);
    return { sent: false, reason: 'not_configured' };
  }

  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: normalizePhone(toPhone),
        type: 'text',
        text: { body: message },
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));

    db.prepare(`UPDATE whatsapp_log SET status='sent' WHERE id=?`).run(logId);
    return { sent: true };
  } catch (err) {
    console.error('WhatsApp send failed:', err.message);
    db.prepare(`UPDATE whatsapp_log SET status='failed', error=? WHERE id=?`).run(err.message, logId);
    return { sent: false, reason: err.message };
  }
}

// Strips leading zeros/plus and ensures a country code is present.
// Adjust the default country code below to match your market.
function normalizePhone(phone) {
  let p = phone.replace(/[^\d]/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1); // default: Kenya country code
  return p;
}

module.exports = { sendWhatsApp };
