const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Scrapes events from hessen-szene.de
 * @param {string} url - URL to scrape
 * @returns {Promise<Array>} Array of event objects
 */
async function scrapeEvents(url) {
  try {
    console.log(`Scraping events from: ${url}`);
    
    // Validate URL
    if (!url || typeof url !== 'string') {
      throw new Error('Invalid URL provided');
    }
    
    // Check if URL is valid
    try {
      new URL(url);
    } catch (e) {
      throw new Error(`Invalid URL format: ${url}`);
    }
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 30000 // 30 second timeout
    });
    
    const $ = cheerio.load(response.data);
    
    const events = [];
    
    // Finde die Event-Tabelle
    const eventTable = $('table.table tbody tr');
    
    eventTable.each((i, row) => {
      try {
        const $row = $(row);
        const $cell0 = $row.find('td').eq(0);

        // Datum: sichtbares DD.MM.YY hat Priorität (stimmt), datetime-Attribut ist oft falsch
        const dateText = $cell0.text();
        const dateMatch = dateText.match(/(\d{2}\.\d{2}\.\d{2})/);
        let date = dateMatch ? dateMatch[1] : '';
        if (!date) {
          const timeEl = $cell0.find('time');
          const datetimeAttr = timeEl.attr('datetime');
          if (datetimeAttr) {
            const m = datetimeAttr.match(/^(\d{4})-(\d{2})-(\d{2})/);
            date = m ? `${m[3]}.${m[2]}.${m[1].slice(2)}` : '';
          }
        }
        const dayOfWeek = ($cell0.find('span').first().text().trim() || $cell0.find('br').next().text().trim()).replace(/,\s*$/, '');

        // Beginn extrahieren
        const time = $row.find('td').eq(1).text().trim();

        // Veranstaltung: Name + Link (z.B. /details/widersetzen-soli-party)
        const $eventLink = $row.find('td').eq(2).find('a');
        const eventName = $eventLink.text().trim();
        const eventLink = $eventLink.attr('href');
        const eventId = eventLink ? (eventLink.match(/eventDate%5D=(\d+)/)?.[1] || eventLink.replace(/^\/details\//, '').replace(/\/$/, '')) : '';
        const detailUrl = eventLink ? new URL(eventLink, 'https://www.hessen-szene.de').href : '';

        // Ort extrahieren (mehrfache Leerzeichen normalisieren)
        const location = $row.find('td').eq(3).text().trim().replace(/\s+/g, ' ');

        // Kategorie extrahieren
        const category = $row.find('td').eq(4).text().trim();
        
        if (eventName && date) {
          events.push({
            date: date,
            dayOfWeek: dayOfWeek,
            time: time,
            eventName: eventName,
            eventLink: detailUrl,
            eventId: eventId,
            location: location,
            category: category,
            venue: 'trauma im g-werk',
            scrapedAt: new Date().toISOString()
          });
        }
      } catch (err) {
        console.error(`Error parsing row ${i}:`, err.message);
      }
    });
    
    console.log(`Found ${events.length} events`);
    
    // Detailseiten für zusätzliche Informationen laden
    console.log('Loading event details...');
    for (let i = 0; i < events.length; i++) {
      if (events[i].eventLink) {
        try {
          const details = await scrapeEventDetails(events[i].eventLink);
          events[i] = { ...events[i], ...details };
          console.log(`Loaded details for: ${events[i].eventName}`);
          
          // Delay zwischen Requests um Rate Limits zu vermeiden
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`Failed to load details for ${events[i].eventName}:`, error.message);
        }
      }
    }
    
    return events;
    
  } catch (error) {
    console.error(`Error scraping ${url}:`, error.message);
    throw error;
  }
}

/**
 * Legacy function for general scraping (kept for backwards compatibility)
 * @param {string} url - URL to scrape
 * @returns {Promise<Object>} Scraped data
 */
async function scrapeContent(url) {
  const events = await scrapeEvents(url);
  return {
    url: url,
    title: 'Events from hessen-szene.de',
    events: events,
    eventCount: events.length,
    scrapedAt: new Date().toISOString()
  };
}

/**
 * Scrapes additional details from event detail page
 * @param {string} detailUrl - URL of the event detail page
 * @returns {Promise<Object>} Additional event details
 */
async function scrapeEventDetails(detailUrl) {
  try {
    console.log(`Scraping details from: ${detailUrl}`);
    
    const response = await axios.get(detailUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    
    // Extrahiere Details aus der Detailseite
    const details = {
      // Event-Titel (für Blog Header)
      title: $('h1.pb-2').text().trim(),
      
      // Vollständiges Datum und Zeit (für Event Datum)
      fullDateTime: $('.event-single-view-datetime strong').text().trim(),
      
      // Veranstaltungsbeginn
      startTime: $('.event-single-view-time p').text().trim(),
      
      // Kategorie (Detailseite: meist im <dd>, Fallback auf bisherigen Bereich)
      category: $('dt:contains("Kategorie")').next('dd').first().text().replace(/\s+/g, ' ').trim()
        || $('.event-single-view-category').text().replace('Kategorie:', '').replace(/\s+/g, ' ').trim()
        || $('dd').filter((_, el) => $(el).text().toLowerCase().includes('kino') || $(el).text().toLowerCase().includes('konzert') || $(el).text().toLowerCase().includes('party')).first().text().replace(/\s+/g, ' ').trim(),
      
      // Ort mit vollständiger Adresse
      fullLocation: $('.event-single-view-contact .col:last-child p').html(),
      
      // Event-Bild: <img class="figure-img img-fluid" itemprop="image" src="/fileadmin/..." alt="">
      imageUrl: $('img[itemprop="image"]').attr('src')
        || $('.event-detail-images img').attr('src')
        || $('.single-event-image img').attr('src'),
      imageAlt: $('img[itemprop="image"]').attr('alt')
        || $('.event-detail-images img').attr('alt')
        || $('.single-event-image img').attr('alt'),
      
      // Beschreibung (Paragraph auf Detailseite)
      description: $('div[itemprop="description"] p').text().replace(/\s+/g, ' ').trim()
        || $('div[itemprop="description"]').text().replace(/\s+/g, ' ').trim()
        || $('.event-single-view-desc').text().replace(/\s+/g, ' ').trim(),
      
      // Eintrittspreis
      price: $('.event-single-view-fee p').text().trim(),
      
      // Hotline (falls vorhanden)
      hotline: $('.event-single-view-contact p').text().match(/Hotline: (\d+)/)?.[1] || '',
    };
    
    return details;
    
  } catch (error) {
    console.error(`Error scraping details from ${detailUrl}:`, error.message);
    return {};
  }
}

/**
 * Main function to scrape content from hessen-szene.de
 * @returns {Promise<Object>} Scraped data with events
 */
async function scrapeContent() {
  try {
    // Homepage hessen-szene.de – Veranstaltungen (Center 8 = trauma im g-werk)
    const url = 'https://www.hessen-szene.de/?tx_laks_calendar%5B__referrer%5D%5B%40extension%5D=Laks&tx_laks_calendar%5B__referrer%5D%5B%40controller%5D=EventDate&tx_laks_calendar%5B__referrer%5D%5B%40action%5D=list&tx_laks_calendar%5B__referrer%5D%5Barguments%5D=YTowOnt9594061197d8315d8b9ffe68a0945ddd6cd835c50&tx_laks_calendar%5B__referrer%5D%5B%40request%5D=%7B%22%40extension%22%3A%22Laks%22%2C%22%40controller%22%3A%22EventDate%22%2C%22%40action%22%3A%22list%22%7D61a2206ff6f4bfc645019a2691b89e0f194538f7&tx_laks_calendar%5B__trustedProperties%5D=%7B%22eventFilter%22%3A%7B%22searchString%22%3A1%2C%22searchStringTitle%22%3A1%2C%22center%22%3A1%2C%22region%22%3A1%2C%22category%22%3A1%2C%22startDate%22%3A1%2C%22endDate%22%3A1%7D%2C%22showEventButton%22%3A1%7D3397c9ad06eb4637d9899c06cfaa1524f9df8b90&tx_laks_calendar%5BeventFilter%5D%5BsearchString%5D=&tx_laks_calendar%5BeventFilter%5D%5BsearchStringTitle%5D=&tx_laks_calendar%5BeventFilter%5D%5Bcenter%5D=8&tx_laks_calendar%5BeventFilter%5D%5Bregion%5D=&tx_laks_calendar%5BeventFilter%5D%5Bcategory%5D=&tx_laks_calendar%5BeventFilter%5D%5BstartDate%5D=&tx_laks_calendar%5BeventFilter%5D%5BendDate%5D=&tx_laks_calendar%5BshowEventButton%5D=';
    
    console.log('Starting scrape process...');
    console.log('URL:', url);
    
    // Validate URL before using it
    if (!url || url === 'undefined') {
      throw new Error('URL is undefined or invalid');
    }
    
    const events = await scrapeEvents(url);
    console.log(`Scraped ${events.length} events from main page`);
    
        // Scrape details for each event
        const eventsWithDetails = [];
        for (let i = 0; i < events.length; i++) {
          const event = events[i];
          console.log(`Scraping details for event ${i + 1}/${events.length}: ${event.eventName}`);
          
          try {
            // Prüfe ob detailUrl existiert (kann auch eventLink heißen)
            const detailUrl = event.detailUrl || event.eventLink;
            if (!detailUrl) {
              console.log(`⚠️ No detailUrl for ${event.eventName}, skipping details`);
              eventsWithDetails.push(event);
              continue;
            }
            
            const details = await scrapeEventDetails(detailUrl);
            eventsWithDetails.push({
              ...event,
              ...details,
              date: event.date,
              time: event.time || details.startTime
            });
            
            // Delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 1000));
          } catch (error) {
            console.error(`Failed to scrape details for ${event.eventName}:`, error.message);
            eventsWithDetails.push(event); // Add event without details
          }
        }
    
    return {
      events: eventsWithDetails,
      scrapedAt: new Date().toISOString(),
      totalEvents: eventsWithDetails.length
    };
    
  } catch (error) {
    console.error('Error in scrapeContent:', error.message);
    throw error;
  }
}

module.exports = { scrapeContent, scrapeEvents, scrapeEventDetails };

