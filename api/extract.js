import { load } from 'cheerio';

const ALLOWED_HOSTS = [
  'ricette.giallozafferano.it',
  'www.uppa.it',
  'www.bimbisaniebelli.it',
];

// Mappa host → metadata (categoria default e tipo ricetta)
const HOST_METADATA = {
  'ricette.giallozafferano.it': { source_site: 'Giallo Zafferano', recipe_type: 'adult', suggested_category: null },
  'www.uppa.it': { source_site: 'Uppa', recipe_type: 'weaning', suggested_category: 'svezzamento' },
  'www.bimbisaniebelli.it': { source_site: 'Bimbi Sani e Belli', recipe_type: 'weaning', suggested_category: 'svezzamento' },
};

function tryJsonLd($) {
  const candidates = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const text = $(el).html();
      if (!text) return;
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
      for (const item of items) {
        if (item && (item['@type'] === 'Recipe' || (Array.isArray(item['@type']) && item['@type'].includes('Recipe')))) {
          candidates.push(item);
        }
      }
    } catch (e) {}
  });
  return candidates[0] || null;
}

function normalizeText(s) {
  if (!s) return '';
  return String(s).replace(/\s+/g, ' ').trim();
}

function parseDuration(iso) {
  if (!iso) return '';
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!match) return '';
  const h = parseInt(match[1] || 0);
  const m = parseInt(match[2] || 0);
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  if (m) return `${m} min`;
  return '';
}

function extractFromJsonLd(jsonLd, url) {
  const title = normalizeText(jsonLd.name);
  const description = normalizeText(jsonLd.description);

  let image_url = null;
  if (jsonLd.image) {
    if (typeof jsonLd.image === 'string') image_url = jsonLd.image;
    else if (Array.isArray(jsonLd.image)) image_url = typeof jsonLd.image[0] === 'string' ? jsonLd.image[0] : jsonLd.image[0]?.url;
    else if (jsonLd.image.url) image_url = jsonLd.image.url;
  }

  const ingredients = [];
  const rawIngredients = jsonLd.recipeIngredient || [];
  for (const item of rawIngredients) {
    const text = normalizeText(item);
    if (text) {
      ingredients.push({ name: text, quantity_raw: '' });
    }
  }

  const steps = [];
  const rawSteps = jsonLd.recipeInstructions || [];
  if (typeof rawSteps === 'string') {
    const text = normalizeText(rawSteps);
    if (text) steps.push(text);
  } else if (Array.isArray(rawSteps)) {
    for (const item of rawSteps) {
      let text = '';
      if (typeof item === 'string') {
        text = normalizeText(item);
      } else if (item && (item['@type'] === 'HowToStep' || item.text)) {
        text = normalizeText(item.text);
      } else if (item && item['@type'] === 'HowToSection' && item.itemListElement) {
        const sectionSteps = item.itemListElement.map((s) => normalizeText(s.text || s)).filter(Boolean);
        if (sectionSteps.length) steps.push(sectionSteps.join(' '));
        continue;
      }
      if (text) steps.push(text);
    }
  }

  const info = {};
  const prepIso = jsonLd.prepTime;
  const cookIso = jsonLd.cookTime;
  const totalIso = jsonLd.totalTime;
  const prep = parseDuration(prepIso);
  const cook = parseDuration(cookIso);
  if (prep) info.preparazione = prep;
  if (cook) info.cottura = cook;
  if (!prep && !cook && totalIso) {
    const total = parseDuration(totalIso);
    if (total) info.preparazione = total;
  }

  const yield_ = jsonLd.recipeYield;
  if (yield_) {
    const y = Array.isArray(yield_) ? yield_[0] : yield_;
    if (y) info['dosi per'] = String(y);
  }

  const difficulty = jsonLd.recipeDifficulty || jsonLd.difficulty;
  if (difficulty) info['difficoltà'] = String(difficulty);

  return {
    source_url: url,
    title,
    image_url,
    description,
    info,
    ingredients,
    steps,
  };
}

function extractGialloZafferano($, url) {
  const title = $('h1.gz-title-recipe').first().text().trim() || null;
  const ingredients = [];
  $('dl.gz-list-ingredients dd.gz-ingredient').each((i, el) => {
    const $el = $(el);
    const name = $el.find('a').first().text().trim();
    let quantity_raw = $el.find('span').first().text().replace(/\s+/g, ' ').trim();
    if (name) ingredients.push({ name, quantity_raw });
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
    if (parts.length === 2) info[parts[0].trim().toLowerCase()] = parts[1].trim();
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
                $('picture.gz-featured-image img').attr('src') || null;
  }
  return {
    source_url: url,
    title,
    image_url,
    info,
    calories_per_serving: calories,
    ingredients,
    steps,
  };
}

function extractUppa($, url) {
  const title = $('h1').first().text().trim() || null;
  const description = $('h3').first().text().trim() || $('h2').first().text().trim() || '';
  let image_url = $('meta[property="og:image"]').attr('content') || null;
  if (!image_url) {
    image_url = $('article img').not('[src*="autore"]').not('[src*="Vignuda"]').first().attr('src') || null;
  }
  const info = {};
  const articleText = $('article, main, .content, .entry-content').first();
  const bodyText = articleText.length > 0 ? articleText : $('body');
  const allText = bodyText.text();
  const diffMatch = allText.match(/Difficolt[aà]:\s*([^\n\r]{1,30})/i);
  if (diffMatch) info['difficoltà'] = diffMatch[1].trim().replace(/\s+/g, ' ');
  const prepMatch = allText.match(/Tempo di preparazione:\s*([^\n\r]{1,30})/i);
  if (prepMatch) info.preparazione = prepMatch[1].trim();
  const cookMatch = allText.match(/Cottura:\s*([^\n\r]{1,30})/i);
  if (cookMatch) info.cottura = cookMatch[1].trim();

  const ingredients = [];
  bodyText.find('p, h2, h3, h4, strong, b').each((i, el) => {
    const text = $(el).text().trim();
    if (/^\s*Ingredienti\s*:?\s*$/i.test(text)) {
      let $next = $(el).next();
      while ($next.length && !$next.is('h2, h3, h4')) {
        if ($next.is('ul, ol')) {
          $next.find('li').each((j, li) => {
            const ingText = $(li).text().trim();
            if (ingText) ingredients.push({ name: ingText, quantity_raw: '' });
          });
          break;
        }
        $next = $next.next();
      }
      return false;
    }
  });

  const steps = [];
  let stopCollecting = false;
  bodyText.find('p, h2, h3, h4').each((i, el) => {
    if (stopCollecting) return;
    const tag = el.name;
    const text = $(el).text().trim();
    if (tag === 'h2' || tag === 'h3' || tag === 'h4') {
      if (steps.length > 0) stopCollecting = true;
      return;
    }
    if (text.length > 80 && !/^Difficolt|^Tempo|^Cottura|^Ingredienti|^Bibliografia|^Articolo pubblicato/i.test(text)) {
      steps.push(text);
    }
  });
  const procedimento = steps.length > 0 ? [steps.join(' ')] : [];

  // Età svezzamento (Uppa di solito non la specifica esplicitamente, default null)
  let weaning_min_age_months = null;
  const ageMatch = allText.match(/[Dd]a\s+(\d+)\s+mes[ie]/);
  if (ageMatch) weaning_min_age_months = parseInt(ageMatch[1]);

  return {
    source_url: url,
    title,
    image_url,
    description,
    info,
    calories_per_serving: null,
    ingredients,
    steps: procedimento,
    weaning_min_age_months,
  };
}

function extractBimbiSaniEBelli($, url) {
  // Titolo: <h1> dentro article, ma escludere h1 della homepage del sito
  let title = null;
  $('article h1, main h1, .entry-content h1, h1.entry-title').each((i, el) => {
    const t = $(el).text().trim();
    if (t && !title) title = t;
  });
  if (!title) title = $('h1').first().text().trim() || null;

  // Immagine
  let image_url = $('meta[property="og:image"]').attr('content') || null;
  if (!image_url) {
    image_url = $('article img, .entry-content img').first().attr('src') || null;
  }

  const info = {};
  let weaning_min_age_months = null;

  // Cerco età e difficoltà nel body principale
  const articleText = $('article, main, .entry-content').first();
  const bodyText = articleText.length > 0 ? articleText : $('body');
  const text = bodyText.text();

  const ageMatch = text.match(/Et[aà]:\s*da\s+(\d+)\s+mes[ie]/i);
  if (ageMatch) weaning_min_age_months = parseInt(ageMatch[1]);

  const diffMatch = text.match(/Difficolt[aà]:\s*([^\n\r]{1,30})/i);
  if (diffMatch) info['difficoltà'] = diffMatch[1].trim().replace(/\s+/g, ' ').replace(/[^a-zà-ù\s]/gi, '').trim();

  // Ingredienti: lista <ul> dopo l'h2 "Ingredienti"
  const ingredients = [];
  bodyText.find('h2, h3, strong, b').each((i, el) => {
    const headerText = $(el).text().trim();
    if (/^\s*Ingredienti\s*:?\s*$/i.test(headerText)) {
      let $next = $(el).next();
      while ($next.length && !$next.is('h2, h3')) {
        if ($next.is('ul, ol')) {
          $next.find('li').each((j, li) => {
            const ingText = $(li).text().trim();
            if (ingText) ingredients.push({ name: ingText, quantity_raw: '' });
          });
          break;
        }
        $next = $next.next();
      }
      return false;
    }
  });

  // Passi: lista <ol> dopo l'h2 "Preparazione"
  const steps = [];
  bodyText.find('h2, h3, strong, b').each((i, el) => {
    const headerText = $(el).text().trim();
    if (/^\s*Preparazione\s*:?\s*$/i.test(headerText)) {
      let $next = $(el).next();
      while ($next.length && !$next.is('h2, h3')) {
        if ($next.is('ol')) {
          $next.find('li').each((j, li) => {
            const stepText = $(li).text().trim();
            if (stepText) steps.push(stepText);
          });
          break;
        } else if ($next.is('ul')) {
          $next.find('li').each((j, li) => {
            const stepText = $(li).text().trim();
            if (stepText) steps.push(stepText);
          });
          break;
        }
        $next = $next.next();
      }
      return false;
    }
  });

  return {
    source_url: url,
    title,
    image_url,
    description: '',
    info,
    calories_per_serving: null,
    ingredients,
    steps,
    weaning_min_age_months,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { url } = req.query;
  if (!url) { res.status(400).json({ error: 'Missing url parameter' }); return; }

  let parsedUrl;
  try { parsedUrl = new URL(url); }
  catch { res.status(400).json({ error: 'Invalid URL' }); return; }

  if (!ALLOWED_HOSTS.includes(parsedUrl.hostname)) {
    res.status(400).json({
      error: 'Sito non supportato',
      message: `Per ora supportiamo solo: ${ALLOWED_HOSTS.join(', ')}`,
    });
    return;
  }

  try {
    const fetchResponse = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' },
    });
    if (!fetchResponse.ok) {
      res.status(502).json({ error: 'Pagina non raggiungibile', status: fetchResponse.status });
      return;
    }
    const html = await fetchResponse.text();
    const $ = load(html);

    let recipe = null;
    let extractor_used = '';
    const meta = HOST_METADATA[parsedUrl.hostname];

    // Strategia 1: JSON-LD universale
    const jsonLd = tryJsonLd($);
    if (jsonLd && jsonLd.name && (jsonLd.recipeIngredient || []).length > 0) {
      recipe = extractFromJsonLd(jsonLd, url);
      extractor_used = 'json-ld';
    }

    // Strategia 2: parser dedicato fallback
    if (!recipe || recipe.ingredients.length === 0 || !recipe.title) {
      if (parsedUrl.hostname === 'ricette.giallozafferano.it') {
        recipe = extractGialloZafferano($, url);
        extractor_used = 'giallozafferano-dedicated';
      } else if (parsedUrl.hostname === 'www.uppa.it') {
        recipe = extractUppa($, url);
        extractor_used = 'uppa-dedicated';
      } else if (parsedUrl.hostname === 'www.bimbisaniebelli.it') {
        recipe = extractBimbiSaniEBelli($, url);
        extractor_used = 'bimbisaniebelli-dedicated';
      }
    }

    if (!recipe || !recipe.title || recipe.ingredients.length === 0) {
      res.status(422).json({
        error: 'Ricetta non riconosciuta',
        message: 'Non sono riuscito a estrarre i dati dalla pagina.',
        debug: { extractor_used, hasTitle: !!recipe?.title, ingredientsCount: recipe?.ingredients?.length || 0 },
      });
      return;
    }

    // Aggiungo metadata sito
    recipe.source_site = meta.source_site;
    recipe.recipe_type = meta.recipe_type;
    recipe.suggested_category = meta.suggested_category;
    recipe.extractor_used = extractor_used;

    // Per ricette weaning, se il parser dedicato ha trovato weaning_min_age_months, propaga
    if (meta.recipe_type === 'weaning' && !recipe.weaning_min_age_months) {
      // tenta estrazione anche da JSON-LD title/description come fallback
      const fullText = (recipe.title || '') + ' ' + (recipe.description || '');
      const ageMatch = fullText.match(/(\d+)\s*[-+]?\s*mes[ie]/i);
      if (ageMatch) recipe.weaning_min_age_months = parseInt(ageMatch[1]);
    }

    res.status(200).json(recipe);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore durante il fetch', message: err.message });
  }
}
