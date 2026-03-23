require('dotenv').config();
const { scrapeContent } = require('./scraper');
const WebflowAPI = require('./webflow-api');
const { syncScrapedEventsToFirestore } = require('./firestore-sync');

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

    const collectionId = process.env.WEBFLOW_COLLECTION_ID;
    const schema = await webflow.getCollectionSchema(collectionId);
    const categoryField = (schema.fields || []).find(
      (f) => (f.slug || '').toLowerCase().includes('kategorie') || (f.name || '').toLowerCase().includes('kategorie')
    );
    const categorySlug = categoryField?.slug;
    if (categorySlug) console.log('Kategorie-Feld gefunden:', categorySlug);

    const uploadedEvents = [];
    
    for (const event of scrapedData.events) {
      try {
        const eventName = event.title || event.eventName;
        
        console.log(`Creating event: ${eventName}...`);
        
        // Datum für Webflow Date Field formatieren
        const formatDateForWebflow = (event) => {
          if (!event.date) return null;
          const parts = event.date.split('.');
          if (parts.length !== 3) return null;
          const day = parts[0];
          const month = parts[1];
          const year = '20' + parts[2];
          const timeMatch = (event.time || '').match(/(\d{1,2}):(\d{2})/);
          const hour = timeMatch ? timeMatch[1].padStart(2, '0') : '00';
          const minute = timeMatch ? timeMatch[2] : '00';
          return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour}:${minute}:00.000Z`;
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

        const eventDatum = formatDateForWebflow(event);
        const slugBase = (event.title || event.eventName).toLowerCase()
          .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        const slug = eventDatum ? `${slugBase}-${event.date?.replace(/\./g, '-')}` : slugBase;

        const webflowData = {
          name: event.title || event.eventName,
          slug: slug,
          'uhrzeit': event.time,
          'event-datum': eventDatum,
          'preis': event.price || 'Eintritt frei',
          'eintritt-frei': (event.price || '').toLowerCase().includes('frei'),
          'blog-rich-text': event.description || `${event.eventName}\n\nDatum: ${event.date}\nZeit: ${event.time}\nOrt: ${event.location}\nKategorie: ${event.category}`,
          'imageurl': imageFieldValue,
        };
        if (categorySlug) webflowData[categorySlug] = event.category || '';

        const existingItem = await webflow.findItemByNameAndDate(
          process.env.WEBFLOW_COLLECTION_ID,
          eventName,
          eventDatum
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
          date: event.date,
          slug: slug,
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

    const createdCount = uploadedEvents.filter(e => e.action === 'created').length;
    const updatedCount = uploadedEvents.filter(e => e.action === 'updated').length;

    const firestoreSummary = await syncScrapedEventsToFirestore(scrapedData.events, uploadedEvents);
    if (firestoreSummary.enabled) {
      console.log(`\n🔥 Firestore: ${firestoreSummary.written} Dokumente in "${firestoreSummary.collection}"`);
    } else {
      console.log(`\n🔥 Firestore: ${firestoreSummary.message}`);
    }

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

