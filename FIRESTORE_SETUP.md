# Firebase Firestore (optional)

Nach jedem Scrape werden die Events **weiterhin nach Webflow** geschickt und **zusätzlich** (wenn konfiguriert) in eine **Firestore-Collection** geschrieben.

## 1. Firebase-Projekt

1. [Firebase Console](https://console.firebase.google.com/) → Projekt anlegen oder wählen  
2. **Firestore Database** anlegen (Testmodus reicht zum Start; später Regeln anpassen)

## 2. Service Account (Server / Vercel)

1. Firebase → **Projekteinstellungen** (Zahnrad) → **Dienstkonten**  
2. **Neuen privaten Schlüssel generieren** → JSON-Datei herunterladen  
3. Den **gesamten Inhalt** der JSON-Datei als **eine Zeile** in eine Umgebungsvariable packen:

**Lokal (.env) – eine der beiden Varianten:**

**A) Pfad zur JSON-Datei** (einfach, z. B. aus Downloads):

```env
FIREBASE_SERVICE_ACCOUNT_PATH=/Users/dein-user/Downloads/dein-projekt-firebase-adminsdk-xxxxx.json
```

**B) Gesamter JSON-Inhalt in einer Zeile:**

```env
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"dein-projekt",...}
```

In `private_key` bleiben `\n` wie in der Datei; der Code wandelt sie in echte Zeilenumbrüche um.

**Vercel:** Nur **B** oder **C** – kein Dateizugriff auf dem Server.

**C) Base64 (oft zuverlässiger als langes JSON im Vercel-Feld)**

Im Terminal (im Ordner mit der JSON-Datei):

```bash
base64 -i mellowedit-d9c74-firebase-adminsdk-fbsvc-d3954eff4b.json | tr -d '\n' | pbcopy
```

Dann in Vercel:

- Key: **`FIREBASE_SERVICE_ACCOUNT_BASE64`**
- Value: einfügen (eine lange Zeile)
- **`FIREBASE_SERVICE_ACCOUNT_JSON` für dieses Projekt löschen oder leer lassen**, damit es keinen Konflikt gibt.

---

### Wenn Firestore trotzdem „aus“ bleibt

1. Variable wirklich für **Production** gesetzt?  
2. Nach dem Speichern **Redeploy**?  
3. API-Antwort unter **`firestore.envHint`** prüfen:
   - **`jsonVariableLength: 0`** → Vercel liefert die Variable nicht (falsches Projekt, falscher Name, nur Preview statt Production).
   - **Länge > 0**, aber Fehlermeldung zu ungültigem JSON → Inhalt kaputt; **Base64 (C)** probieren.

**Vercel:**  
`Settings` → `Environment Variables` → `FIREBASE_SERVICE_ACCOUNT_JSON` = kompletter JSON-Inhalt (als Value einfügen; bei sehr langen Keys ggf. in einem Stück einfügen).

## 3. Collection-Name (optional)

Standard im Scraper: **`cms`** – dort landen die Veranstaltungs-Dokumente.

```env
FIRESTORE_COLLECTION=cms
```

Andere Namen gehen auch, wenn du die Variable setzt (überschreibt den Standard).

## 4. Dokumente

- **Gleiche Doc-ID = Update:** Existiert bereits ein Dokument mit derselben ID (Name + Datum), werden die Felder **aktualisiert** (`merge`), kein Duplikat. In der API-Antwort siehst du `firestore.created` / `firestore.updated`.
- **Doc-ID:** aus Eventname + Tabellen-Datum (z. B. `widersetzen-soli-party-06-03-26`)  
- **Felder u. a.:** `cmsTopId` (fest **`vh060ZY8Hm63yohFiYFB`**, änderbar mit Env **`CMS_TOP_ID`**), `eventName`, `dateTable`, `time`, `location`, `category`, `detailUrl`, `description`, `imageUrl`, `price`, `webflowId`, `webflowAction`, `slug`, `scrapedAt`, `source`, `updatedAt`

Ohne `FIREBASE_SERVICE_ACCOUNT_JSON` läuft der Scraper wie bisher nur mit Webflow; Firestore wird übersprungen (in der API-Antwort: `firestore.enabled: false`).

## 5. Sicherheit

Der **Admin SDK** umgeht Firestore Security Rules. Schlüssel nur serverseitig (`.env` / Vercel), **nie** ins Git committen.
