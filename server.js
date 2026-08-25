// שרת קטן ששולח הודעות וואטסאפ מחשבון הוואטסאפ הקיים של מכון מנטליקס.
// לא משתמש ב-API הרשמי של מטא - מדמה חיבור WhatsApp Web רגיל (ספריית Baileys), בלי דפדפן/כרום.
// מיועד לשימוש פנימי בלבד: שליחת הודעה אחת ביום (דוח בוקר) למספר יעד קבוע.
//
// חשוב: זו לא שיטה רשמית של WhatsApp/מטא - יש סיכון (נמוך יחסית לשימוש בנפח כזה) שהחשבון יוגבל.

const http = require('http');
const { URL } = require('url');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 10000;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
// מספר היעד, בפורמט בינלאומי בלי + ובלי אפס מוביל, למשל מספר ישראלי 050-1234567 => 972501234567
const TARGET_NUMBER = process.env.TARGET_NUMBER;
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_info');

if (!ADMIN_SECRET) {
  console.error('שגיאה: חובה להגדיר את משתנה הסביבה ADMIN_SECRET.');
  process.exit(1);
}
if (!TARGET_NUMBER) {
  console.error('שגיאה: חובה להגדיר את משתנה הסביבה TARGET_NUMBER (מספר היעד, בפורמט בינלאומי, למשל 972501234567).');
  process.exit(1);
}

const logger = pino({ level: 'silent' });

let sock = null;
let latestQrDataUrl = null;
let isConnected = false;
let lastConnectError = null;

function jidFromNumber(number) {
  const clean = String(number).replace(/[^0-9]/g, '');
  return `${clean}@s.whatsapp.net`;
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[whatsapp] גרסת פרוטוקול WhatsApp: ${version.join('.')} (עדכנית: ${isLatest})`);

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    getMessage: async () => undefined,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        latestQrDataUrl = await QRCode.toDataURL(qr);
      } catch (e) {
        console.error('שגיאה ביצירת קוד QR:', e.message);
      }
    }

    if (connection === 'open') {
      isConnected = true;
      latestQrDataUrl = null;
      lastConnectError = null;
      console.log('[whatsapp] מחובר בהצלחה.');
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      lastConnectError = lastDisconnect?.error?.message || 'התנתק';
      console.log(`[whatsapp] החיבור נסגר (${lastConnectError}). loggedOut=${loggedOut}`);
      if (!loggedOut) {
        // ניתוק זמני (לא logout) - מתחברים מחדש אוטומטית
        setTimeout(() => startSock().catch((e) => console.error('שגיאה בחיבור מחדש:', e.message)), 3000);
      } else {
        console.log('[whatsapp] נותקת (logged out) - צריך לסרוק QR חדש דרך /qr.');
      }
    }
  });
}

startSock().catch((e) => console.error('שגיאה בהפעלה ראשונית:', e.message));

function checkSecret(providedKey) {
  return providedKey === ADMIN_SECRET;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(html);
}

// גודל מקסימלי לגוף בקשה - הוגדל כדי לאפשר שליחת קבצים (כמו PDF) בקידוד base64.
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8MB

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY_BYTES) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // בקשת preflight של CORS (נדרש כדי שדף HTML מקומי יוכל לשלוח קבצים לשרת מהדפדפן)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    if (pathname === '/health' && req.method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        connected: isConnected,
        hasQrPending: !!latestQrDataUrl,
        lastConnectError,
      });
    }

    if (pathname === '/qr' && req.method === 'GET') {
      const key = url.searchParams.get('key');
      if (!checkSecret(key)) return sendJson(res, 403, { error: 'FORBIDDEN' });

      if (isConnected) {
        return sendHtml(res, 200, `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8">
          <body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>✅ מחובר בהצלחה</h2>
          <p>חשבון הוואטסאפ כבר מחובר. אין צורך לסרוק שוב.</p>
          </body></html>`);
      }

      if (!latestQrDataUrl) {
        return sendHtml(res, 200, `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta http-equiv="refresh" content="5">
          <body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>ממתין לקוד QR...</h2>
          <p>הדף יתרענן אוטומטית כל כמה שניות.</p>
          </body></html>`);
      }

      return sendHtml(res, 200, `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><meta http-equiv="refresh" content="20">
        <body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>סרקו את הקוד עם הוואטסאפ של המכון</h2>
        <p>וואטסאפ במכשיר &larr; הגדרות &larr; מכשירים מקושרים &larr; קישור מכשיר</p>
        <img src="${latestQrDataUrl}" style="width:280px;height:280px" />
        <p style="color:#888">הדף מתרענן כל 20 שניות - הקוד מתחדש אוטומטית.</p>
        </body></html>`);
    }

    if (pathname === '/send-test' && req.method === 'GET') {
      // נתיב בדיקה נוח - מאפשר להפעיל שליחה ישירות מהדפדפן (GET), בלי POST.
      const key = url.searchParams.get('key');
      if (!checkSecret(key)) return sendJson(res, 403, { error: 'FORBIDDEN' });
      if (!isConnected || !sock) {
        return sendJson(res, 409, { error: 'NOT_CONNECTED', message: 'הוואטסאפ לא מחובר כרגע.' });
      }
      const text = url.searchParams.get('text') || 'הודעת בדיקה ממנטליקס ✅';
      const to = url.searchParams.get('to') || TARGET_NUMBER;
      try {
        await sock.sendMessage(jidFromNumber(to), { text });
        return sendJson(res, 200, { ok: true, to, text });
      } catch (e) {
        return sendJson(res, 502, { error: 'SEND_FAILED', message: e.message });
      }
    }

    if (pathname === '/send' && req.method === 'POST') {
      const key = url.searchParams.get('key');
      if (!checkSecret(key)) return sendJson(res, 403, { error: 'FORBIDDEN' });

      if (!isConnected || !sock) {
        return sendJson(res, 409, { error: 'NOT_CONNECTED', message: 'הוואטסאפ לא מחובר כרגע. יש לסרוק QR דרך /qr.' });
      }

      let payload;
      try {
        const raw = await readBody(req);
        payload = JSON.parse(raw || '{}');
      } catch (e) {
        return sendJson(res, 400, { error: 'BAD_JSON', message: e.message });
      }

      const text = payload.text;
      const to = payload.to || TARGET_NUMBER;
      if (!text || typeof text !== 'string') {
        return sendJson(res, 400, { error: 'MISSING_TEXT', message: 'יש לשלוח { "text": "..." } בגוף הבקשה.' });
      }

      try {
        await sock.sendMessage(jidFromNumber(to), { text });
        return sendJson(res, 200, { ok: true, to });
      } catch (e) {
        return sendJson(res, 502, { error: 'SEND_FAILED', message: e.message });
      }
    }

    if (pathname === '/send-document' && req.method === 'POST') {
      // שליחת קובץ (למשל PDF) כמסמך בוואטסאפ. מצפה לגוף JSON:
      // { "fileBase64": "...", "fileName": "report.pdf", "caption": "...", "mimetype": "application/pdf", "to": "..." }
      const key = url.searchParams.get('key');
      if (!checkSecret(key)) return sendJson(res, 403, { error: 'FORBIDDEN' });

      if (!isConnected || !sock) {
        return sendJson(res, 409, { error: 'NOT_CONNECTED', message: 'הוואטסאפ לא מחובר כרגע. יש לסרוק QR דרך /qr.' });
      }

      let payload;
      try {
        const raw = await readBody(req);
        payload = JSON.parse(raw || '{}');
      } catch (e) {
        return sendJson(res, 400, { error: 'BAD_JSON', message: e.message });
      }

      const { fileBase64, fileName, caption } = payload;
      const to = payload.to || TARGET_NUMBER;
      const mimetype = payload.mimetype || 'application/pdf';

      if (!fileBase64 || typeof fileBase64 !== 'string') {
        return sendJson(res, 400, { error: 'MISSING_FILE', message: 'יש לשלוח { "fileBase64": "..." } בגוף הבקשה.' });
      }

      let buffer;
      try {
        buffer = Buffer.from(fileBase64, 'base64');
      } catch (e) {
        return sendJson(res, 400, { error: 'BAD_BASE64', message: e.message });
      }

      try {
        await sock.sendMessage(jidFromNumber(to), {
          document: buffer,
          mimetype,
          fileName: fileName || 'report.pdf',
          caption: caption || undefined,
        });
        return sendJson(res, 200, { ok: true, to });
      } catch (e) {
        return sendJson(res, 502, { error: 'SEND_FAILED', message: e.message });
      }
    }

    return sendJson(res, 404, { error: 'NOT_FOUND' });
  } catch (e) {
    console.error('שגיאה כללית:', e);
    return sendJson(res, 500, { error: 'INTERNAL', message: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`[whatsapp] שרת רץ על פורט ${PORT}`);
});
