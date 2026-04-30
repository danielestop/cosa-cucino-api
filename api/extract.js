import { load } from 'cheerio';

const ALLOWED_HOSTS = ['ricette.giallozafferano.it'];

function extractGialloZafferano($, url) {
  const title = $('h1.gz-title-recipe').first().text().trim() || null;

  const ingredients = [];
  $('dl.gz-list-ingredients dd.gz-ingredient').each((i, el) => {
    const $el = $(el);
    const name = $el.find('a').first().text().trim();
    let quantity_raw = $el.find('span').first().text().replace(/\s+/g, ' ').trim();
    if (name) {
      ingredients.push({ name, quantity_raw });
    }
  });

  const steps = [];
  $('div.gz-content-recipe div.gz-content-recipe-step').each((i, el) => {
    const $el = $(el);
    const $p = $el.find('p').first();
    if ($p.length === 0) return;
    $p.find('span.num-step').remove();
    let text = $p.text().replace(/\s+([.,;:!?])/g, '$1').replace(/\s+/g, ' ').trim();
    if (text) steps.push(text);
  });

  const info = {};
  $('div.gz-list-featured-data li').each((i, el) => {
    const fullText = $(el).find('span.gz-name-featured-data').text().replace(/\s+/g, ' ').trim();
    const parts = fullText.split(':');
    if (parts.length === 2) {
      info[parts[0].trim().toLowerCase()] = parts[1].trim();
    }
  });

  let calories = null;
  const caloriesText = $('div.gz-text-calories-total span').first().text().trim().replace(',', '.');
  if (caloriesText) {
    const parsed = parseFloat(caloriesText);
    if (!isNaN(parsed)) calories = Math.round(parsed);
  }

  let image_url = $('meta[property="og:image"]').attr('content') || null;
  if (!image_url) {
    image_url = $('picture.gz-featured-image img').attr('data-src') ||
                $('picture.gz-featured-image img').attr('src') ||
                $('div.gz-featured-image img').attr('src') || null;
  }

  return {
    source_url: url,
    source_site: 'Giallo Zafferano',
    title,
    image_url,
    info,
    calories_per_serving: calories,
    ingredients,
    steps,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { url } = req.query;
  if (!url) {
    res.status(400).json({ error: 'Missing url parameter' });
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    res.status(400).json({ error: 'Invalid URL' });
    return;
  }

  if (!ALLOWED_HOSTS.includes(parsedUrl.hostname)) {
    res.status(400).json({
      error: 'Sito non supportato',
      message: `Per ora supportiamo solo: ${ALLOWED_HOSTS.join(', ')}`,
    });
    return;
  }

  try {
    const fetchResponse = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      },
    });

    if (!fetchResponse.ok) {
      res.status(502).json({
        error: 'Pagina non raggiungibile',
        status: fetchResponse.status,
      });
      return;
    }

    const html = await fetchResponse.text();
    const $ = load(html);

    let recipe;
    if (parsedUrl.hostname === 'ricette.giallozafferano.it') {
      recipe = extractGialloZafferano($, url);
    } else {
      res.status(400).json({ error: 'Parser non implementato per questo sito' });
      return;
    }

    if (!recipe.title || recipe.ingredients.length === 0) {
      res.status(422).json({
        error: 'Ricetta non riconosciuta',
        message: 'Non sono riuscito a estrarre i dati dalla pagina. Forse la pagina è cambiata.',
      });
      return;
    }

    res.status(200).json(recipe);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore durante il fetch', message: err.message });
  }
}
