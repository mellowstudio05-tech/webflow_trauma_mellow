/**
 * Optional: Scraped Events in Firebase Firestore schreiben.
 * Aktiv mit FIREBASE_SERVICE_ACCOUNT_JSON oder FIREBASE_SERVICE_ACCOUNT_PATH (lokal).
 */
const admin = require('firebase-admin');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let initialized = false;

function normalizeJsonString(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let s = raw.replace(/^\uFEFF/, '').trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"') && s.indexOf('{') > 0)) {
    s = s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s.trim();
}

function applyPrivateKeyNewlines(account) {
  if (account?.private_key && typeof account.private_key === 'string') {
    account.private_key = account.private_key.replace(/\\n/g, '\n');
  }
  return account;
}

function parseServiceAccount() {
  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim();
  if (filePath) {
    try {
      const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
      const raw = fs.readFileSync(abs, 'utf8');
      const account = applyPrivateKeyNewlines(JSON.parse(raw));
      return account;
    } catch (e) {
      console.error('FIREBASE_SERVICE_ACCOUNT_PATH konnte nicht gelesen werden:', e.message);
      return null;
    }
  }

  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim();
  if (b64) {
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      const account = applyPrivateKeyNewlines(JSON.parse(normalizeJsonString(decoded)));
      return account;
    } catch (e) {
      console.error('FIREBASE_SERVICE_ACCOUNT_BASE64 konnte nicht dekodiert/gelesen werden:', e.message);
      return null;
    }
  }

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw || !String(raw).trim()) return null;
  const normalized = normalizeJsonString(String(raw));
  try {
    return applyPrivateKeyNewlines(JSON.parse(normalized));
  } catch (e) {
    console.error('FIREBASE_SERVICE_ACCOUNT_JSON ist kein gültiges JSON:', e.message);
    return null;
  }
}

function initIfNeeded() {
  if (initialized) return true;
  const serviceAccount = parseServiceAccount();
  if (!serviceAccount) return false;
  try {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    initialized = true;
    console.log('Firebase Admin initialisiert (Firestore).');
    return true;
  } catch (e) {
    console.error('Firebase Admin Init fehlgeschlagen:', e.message);
    return false;
  }
}

function isFirestoreEnabled() {
  return !!(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim() ||
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim() ||
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH?.trim()
  );
}

/** Für API-Antwort: ohne Geheimnisse preiszugeben */
function firestoreEnvHint() {
  const j = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const b = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const p = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  return {
    jsonVariableLength: j ? String(j).length : 0,
    base64VariableLength: b ? String(b).length : 0,
    pathSet: !!(p && p.trim())
  };
}

function fullImageUrl(imageUrl) {
  if (!imageUrl) return '';
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) return imageUrl;
  if (imageUrl.startsWith('/')) return `https://www.hessen-szene.de${imageUrl}`;
  return `https://www.hessen-szene.de/${imageUrl}`;
}

/**
 * Eindeutige Doc-ID: Name + Tabellen-Datum (wie Webflow-Slug-Logik)
 */
function makeDocId(event) {
  const base = (event.title || event.eventName || 'event')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
  const datePart = (event.date || 'nodate').replace(/\./g, '-');
  let id = `${base}-${datePart}`;
  if (id.length > 700) {
    id = crypto.createHash('sha256').update(`${base}-${datePart}`).digest('hex').slice(0, 64);
  }
  return id;
}

const DEFAULT_CMS_TOP_ID = 'QJVcM2zsrnkowCTz4E97';

function eventToDoc(event, extras = {}) {
  const cmsTopId = (process.env.CMS_TOP_ID || DEFAULT_CMS_TOP_ID).trim();
  return {
    cmsTopId,
    eventName: event.title || event.eventName,
    dateTable: event.date || null,
    time: event.time || null,
    dayOfWeek: event.dayOfWeek || null,
    location: event.location || null,
    category: event.category || null,
    detailUrl: event.eventLink || event.detailUrl || null,
    description: event.description || null,
    title: event.title || null,
    fullDateTime: event.fullDateTime || null,
    startTime: event.startTime || null,
    price: event.price || null,
    imageUrl: fullImageUrl(event.imageUrl),
    imageAlt: event.imageAlt || null,
    venue: event.venue || null,
    webflowId: extras.webflowId || null,
    webflowAction: extras.webflowAction || null,
    slug: extras.slug || null,
    scrapedAt: event.scrapedAt || null,
    source: 'hessen-szene.de',
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
}

/**
 * Alle gescrapten Events in Firestore: gleiche Doc-ID (Name + Datum) = bestehendes Dokument wird aktualisiert.
 * Technisch: docRef.get() prüft Existenz; set(..., { merge: true }) legt an oder merged Felder.
 * @param {Array} events - scrapedData.events
 * @param {Array<{eventName:string, date?:string, webflowId?:string, action?:string, slug?:string}>} uploadedList
 * @returns {Promise<{enabled:boolean, collection?:string, written?:number, created?:number, updated?:number, errors?:Array, message?:string}>}
 */
async function syncScrapedEventsToFirestore(events, uploadedList = []) {
  if (!isFirestoreEnabled()) {
    return {
      enabled: false,
      message:
        'Firestore aus – in Vercel: FIREBASE_SERVICE_ACCOUNT_JSON (Inhalt der JSON) oder FIREBASE_SERVICE_ACCOUNT_BASE64 setzen, Environment „Production“ anhaken, danach Redeploy.',
      envHint: firestoreEnvHint()
    };
  }
  if (!initIfNeeded()) {
    return {
      enabled: false,
      message:
        'Firebase-Variable ist gesetzt, aber ungültig oder Init fehlgeschlagen. JSON prüfen oder FIREBASE_SERVICE_ACCOUNT_BASE64 nutzen (siehe FIRESTORE_SETUP.md).',
      envHint: firestoreEnvHint()
    };
  }

  const collectionName = process.env.FIRESTORE_COLLECTION || 'cms';
  const db = admin.firestore();
  let written = 0;
  let created = 0;
  let updated = 0;
  const errors = [];

  for (const event of events) {
    const name = event.title || event.eventName;
    const match = uploadedList.find(
      (u) => u.eventName === name && (u.date || '') === (event.date || '')
    );
    const docId = makeDocId(event);
    const docRef = db.collection(collectionName).doc(docId);
    try {
      const snap = await docRef.get();
      const alreadyExists = snap.exists;

      await docRef.set(
        eventToDoc(event, {
          webflowId: match?.webflowId,
          webflowAction: match?.action,
          slug: match?.slug
        }),
        { merge: true }
      );

      written++;
      if (alreadyExists) {
        updated++;
      } else {
        created++;
      }
    } catch (e) {
      errors.push({ docId, error: e.message });
    }
  }

  return {
    enabled: true,
    collection: collectionName,
    written,
    created,
    updated,
    errors: errors.length ? errors : undefined
  };
}

module.exports = {
  syncScrapedEventsToFirestore,
  makeDocId,
  isFirestoreEnabled,
  firestoreEnvHint
};
