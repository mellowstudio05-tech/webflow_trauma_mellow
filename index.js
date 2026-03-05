require('dotenv').config();
const { scrapeContent } = require('./scraper');
const WebflowAPI = require('./webflow-api');

/**
 * Main function to scrape content and upload to Webflow
 */
async function main() {
  try {
    // Validate environment variables (WEBFLOW_SITE_ID wird für Bild-Upload benötigt)
    if (!process.env.WEBFLOW_API_TOKEN || !process.env.WEBFLOW_COLLECTION_ID || !process.env.SOURCE_URL) {
      throw new Error('Missing required environment variables. Please check your .env file.');
    }
    if (!process.env.WEBFLOW_SITE_ID) {
      console.warn('⚠️ WEBFLOW_SITE_ID fehlt – Veranstaltungsbilder können nicht nach Webflow hochgeladen werden.');
    }

    // Initialize Webflow API
    const webflow = new WebflowAPI(process.env.WEBFLOW_API_TOKEN, process.env.WEBFLOW_SITE_ID);

    // Scrape events from source URL
    console.log('Starting scraping process...');
    const scrapedData = await scrapeContent(process.env.SOURCE_URL);

    console.log(`Found ${scrapedData.events.length} events`);

    // Upload each event to Webflow
    const uploadedEvents = [];
    
    for (const event of scrapedData.events) {
      try {
        const eventName = event.title || event.eventName;
        
        console.log(`Creating event: ${eventName}...`);
        
        // Datum für Webflow Date Field formatieren
        const formatDateForWebflow = (event) => {
          // Versuche das Datum aus der Detailseite zu parsen
          if (event.fullDateTime) {
            // Entferne Zeilenumbrüche und extrahiere Datum
            const cleanDate = event.fullDateTime.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
            // Beispiel: "Dienstag, 28. Oktober 2025, 18:30 Uhr"
            
            // Konvertiere zu ISO Format für Webflow
            try {
              // Parse das deutsche Datum
              const dateStr = cleanDate.match(/(\d{1,2})\.\s*(\w+)\s*(\d{4})/);
              const timeStr = cleanDate.match(/(\d{1,2}):(\d{2})/);
              
              if (dateStr && timeStr) {
                const day = dateStr[1];
                const month = dateStr[2];
                const year = dateStr[3];
                const hour = timeStr[1];
                const minute = timeStr[2];
                
                // Monatsnamen zu Zahlen
                const monthMap = {
                  'Januar': '01', 'Februar': '02', 'März': '03', 'April': '04',
                  'Mai': '05', 'Juni': '06', 'Juli': '07', 'August': '08',
                  'September': '09', 'Oktober': '10', 'November': '11', 'Dezember': '12'
                };
                
                const monthNum = monthMap[month];
                if (monthNum) {
                  return `${year}-${monthNum}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:00.000Z`;
                }
              }
            } catch (e) {
              console.log('Could not parse date:', cleanDate);
            }
          }
          
          // Fallback: Verwende das einfache Datum aus der Tabelle
          if (event.date) {
            // Format: DD.MM.YY -> YYYY-MM-DD
            const parts = event.date.split('.');
            if (parts.length === 3) {
              const day = parts[0];
              const month = parts[1];
              const year = '20' + parts[2]; // 25 -> 2025
              return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00.000Z`;
            }
          }
          
          return null;
        };

        // Konvertiere relative Bild-URL zu vollständiger URL
        const formatImageUrl = (imageUrl) => {
          if (!imageUrl) return '';
          if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) return imageUrl;
          if (imageUrl.startsWith('/')) return `https://www.hessen-szene.de${imageUrl}`;
          return `https://www.hessen-szene.de/${imageUrl}`;
        };

        // Bild: hochladen und für Webflow Image-Feld als { fileId, url, alt } setzen
        let imageFieldValue = '';
        if (event.imageUrl) {
          const fullImageUrl = formatImageUrl(event.imageUrl);
          const imageFilename = (event.title || event.eventName || 'event')
            .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
            + (event.imageUrl.match(/\.(jpg|jpeg|png|gif|webp)/i)?.[0] || '.jpg');
          try {
            const uploaded = await webflow.uploadImage(fullImageUrl, imageFilename);
            imageFieldValue = { fileId: uploaded.id, url: uploaded.url || fullImageUrl, alt: event.imageAlt || event.eventName || '' };
            console.log(`  Bild hochgeladen: ${eventName}`);
          } catch (imgErr) {
            console.warn(`  Bild-Upload übersprungen (${eventName}):`, imgErr.message);
            imageFieldValue = fullImageUrl;
          }
        }

        // Transform event data to Webflow format - Blog Header ist das name Field
        const webflowData = {
          name: event.title || event.eventName,                    // Blog Header = name Field
          slug: (event.title || event.eventName).toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')                         // Entferne Sonderzeichen
            .replace(/\s+/g, '-')                                 // Ersetze Leerzeichen mit -
            .replace(/-+/g, '-')                                  // Entferne mehrfache -
            .replace(/^-|-$/g, ''),                               // Entferne führende/trailing -
          'uhrzeit': event.time,                                  // Zeit
          'event-datum': formatDateForWebflow(event),             // Korrekt formatiertes Datum
          'preis': event.price || 'Eintritt frei',                // Preis
          'eintritt-frei': (event.price || '').toLowerCase().includes('frei'), // Switch
          'blog-rich-text': event.description || `${event.eventName}\n\nDatum: ${event.date}\nZeit: ${event.time}\nOrt: ${event.location}\nKategorie: ${event.category}`, // Beschreibung
          'imageurl': imageFieldValue,                            // Image-Objekt { fileId, url, alt } oder URL-String
          't-kategorie': event.category || '',                    // Kategorie aus Detailseite oder Tabelle
        };

        // Prüfe ob Event bereits existiert
        const existingItem = await webflow.findItemByName(
          process.env.WEBFLOW_COLLECTION_ID,
          eventName
        );

        let result;
        let action;

        if (existingItem) {
          // Event existiert bereits - aktualisiere es
          console.log(`Updating existing event: ${eventName}...`);
          result = await webflow.updateItem(
            process.env.WEBFLOW_COLLECTION_ID,
            existingItem.id,
            webflowData
          );
          action = 'updated';
          console.log(`✅ Updated: ${eventName}`);
        } else {
          // Event existiert nicht - erstelle es neu
          console.log(`Creating new event: ${eventName}...`);
          result = await webflow.createItem(
            process.env.WEBFLOW_COLLECTION_ID,
            webflowData
          );
          action = 'created';
          console.log(`✅ Created: ${eventName}`);
        }

        uploadedEvents.push({
          eventName: eventName,
          webflowId: result.id,
          action: action
        });

        // Publish the item (mit besserem Error Handling)
        try {
          console.log(`Publishing: ${eventName}...`);
          await webflow.publishItem(process.env.WEBFLOW_COLLECTION_ID, result.id);
          console.log(`✅ Published: ${eventName}`);
        } catch (publishError) {
          console.error(`❌ Failed to publish ${eventName}:`, publishError.message);
          console.log(`⚠️ Event ${eventName} ${action} but not published. You may need to publish manually.`);
        }

        
        // Delay zwischen Uploads um Rate Limits zu vermeiden
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`Error uploading event ${event?.eventName || event?.title || 'unknown'}:`, error.message);
      }
    }

    // Summary
    const createdCount = uploadedEvents.filter(e => e.action === 'created').length;
    const updatedCount = uploadedEvents.filter(e => e.action === 'updated').length;
    
    console.log(`\n✅ Successfully processed ${uploadedEvents.length} events:`);
    console.log(`   📝 Created: ${createdCount} new events`);
    console.log(`   ✏️  Updated: ${updatedCount} existing events`);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { main };

