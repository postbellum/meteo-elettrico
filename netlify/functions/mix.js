// netlify/functions/mix.js
// Un'unica chiamata che restituisce: mix di generazione, domanda attuale,
// prezzo zonale e un consiglio pratico su quando conviene consumare.
//
// Fonte: ENTSO-E Transparency Platform (unica fonte ufficiale europea gratuita
// e stabile per questo tipo di dato, verificato). Zona pilota: IT_NORD.

const { XMLParser } = require('fast-xml-parser');

const PSR_LABELS = {
  B01: 'Biomasse', B02: 'Lignite', B03: 'Gas da carbone', B04: 'Gas',
  B05: 'Carbone', B06: 'Petrolio', B07: 'Scisto bituminoso', B08: 'Torba',
  B09: 'Geotermico', B10: 'Idro (pompaggio)', B11: 'Idro (fluente)',
  B12: 'Idro (bacino)', B13: 'Marino', B14: 'Nucleare', B15: 'Altro rinnovabile',
  B16: 'Solare', B17: 'Rifiuti', B18: 'Eolico offshore', B19: 'Eolico onshore', B20: 'Altro',
};

// gCO2eq/kWh — valori medi indicativi di riferimento, NON un inventario certificato.
const CO2_FACTORS = {
  B01: 230, B02: 1050, B03: 700, B04: 490, B05: 820, B06: 650,
  B07: 900, B08: 900, B09: 38, B10: 24, B11: 24, B12: 24, B13: 17,
  B14: 12, B15: 100, B16: 45, B17: 700, B18: 12, B19: 11, B20: 500,
};

const ZONE_EIC = '10Y1001A1001A73I'; // IT_NORD
const ZONE_LABEL = 'IT_NORD';

function fmt(d) {
  return d.toISOString().slice(0, 16).replace(/[-:T]/g, '');
}

async function fetchXml(url) {
  const res = await fetch(url);
  const xml = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + xml.slice(0, 300));
  return xml;
}

function parseMix(xml, parser) {
  const data = parser.parse(xml);
  const series = data && data.GL_MarketDocument ? data.GL_MarketDocument.TimeSeries : null;
  const seriesArray = Array.isArray(series) ? series : series ? [series] : [];
  const latest = {};
  for (const ts of seriesArray) {
    const psrType = ts && ts.MktPSRType ? ts.MktPSRType.psrType : null;
    if (!psrType) continue;
    const points = ts && ts.Period ? ts.Period.Point : null;
    const pointsArray = Array.isArray(points) ? points : points ? [points] : [];
    if (!pointsArray.length) continue;
    const lastPoint = pointsArray[pointsArray.length - 1];
    const qty = parseFloat(lastPoint && lastPoint.quantity);
    if (isNaN(qty)) continue;
    latest[psrType] = (latest[psrType] || 0) + qty;
  }
  const totalMw = Object.values(latest).reduce((a, b) => a + b, 0);
  const mix = Object.entries(latest)
    .map(([type, mw]) => ({
      type, label: PSR_LABELS[type] || type, mw: Math.round(mw),
      pct: totalMw > 0 ? +((mw / totalMw) * 100).toFixed(1) : 0,
    }))
    .sort((a, b) => b.mw - a.mw);
  const co2Intensity = totalMw > 0
    ? Math.round(Object.entries(latest).reduce((s, [t, mw]) => s + mw * (CO2_FACTORS[t] || 500), 0) / totalMw)
    : null;
  let indexLabel = 'verde';
  if (co2Intensity !== null && co2Intensity > 250) indexLabel = 'giallo';
  if (co2Intensity !== null && co2Intensity > 450) indexLabel = 'rosso';
  return { mix, totalGenerationMw: Math.round(totalMw), co2Intensity, indexLabel, dominant: mix[0] ? mix[0].label : null };
}

function parseLoad(xml, parser) {
  const data = parser.parse(xml);
  const series = data && data.GL_MarketDocument ? data.GL_MarketDocument.TimeSeries : null;
  const seriesArray = Array.isArray(series) ? series : series ? [series] : [];
  let lastQty = null;
  for (const ts of seriesArray) {
    const points = ts && ts.Period ? ts.Period.Point : null;
    const pointsArray = Array.isArray(points) ? points : points ? [points] : [];
    if (pointsArray.length) {
      const lp = pointsArray[pointsArray.length - 1];
      const qty = parseFloat(lp && lp.quantity);
      if (!isNaN(qty)) lastQty = qty;
    }
  }
  return { loadMw: lastQty !== null ? Math.round(lastQty) : null };
}

function parsePrice(xml, parser) {
  const data = parser.parse(xml);
  const series = data && data.Publication_MarketDocument ? data.Publication_MarketDocument.TimeSeries : null;
  const seriesArray = Array.isArray(series) ? series : series ? [series] : [];
  const prices = [];
  for (const ts of seriesArray) {
    const points = ts && ts.Period ? ts.Period.Point : null;
    const pointsArray = Array.isArray(points) ? points : points ? [points] : [];
    for (const p of pointsArray) {
      const amount = parseFloat(p && p['price.amount']);
      if (!isNaN(amount)) prices.push(amount);
    }
  }
  if (!prices.length) return { priceNow: null, priceMin: null, priceMax: null };
  return {
    priceNow: Math.round(prices[0] * 10) / 10,
    priceMin: Math.round(Math.min(...prices) * 10) / 10,
    priceMax: Math.round(Math.max(...prices) * 10) / 10,
  };
}

function costruisciConsiglio(co2, indexLabel, priceNow, priceMin, priceMax) {
  if (co2 === null || priceNow === null || priceMin === null || priceMax === null) {
    return 'Dati insufficienti per un consiglio in questo momento.';
  }
  const range = priceMax - priceMin || 1;
  const posizionePrezzo = (priceNow - priceMin) / range; // 0 = più economico, 1 = più caro

  const prezzoBasso = posizionePrezzo < 0.33;
  const prezzoAlto = posizionePrezzo > 0.66;
  const mixPulito = indexLabel === 'verde';
  const mixSporco = indexLabel === 'rosso';

  if (prezzoBasso && !mixSporco) {
    return 'Buon momento per consumi energivori — lavatrice, lavastoviglie, ricarica auto elettrica. Prezzo basso e mix ragionevolmente pulito.';
  }
  if (prezzoAlto && mixSporco) {
    return 'Se puoi, rimanda i consumi pesanti. Prezzo alto e mix di generazione poco pulito in questo momento.';
  }
  if (mixPulito && !prezzoAlto) {
    return 'Mix di generazione pulito in questo momento — buona finestra dal punto di vista ambientale, anche se il prezzo non è ai minimi.';
  }
  if (prezzoAlto) {
    return 'Prezzo tra i più alti delle prossime ore. Se il consumo può aspettare, meglio spostarlo.';
  }
  return 'Momento nella media — né un\'occasione né un motivo per rimandare.';
}

exports.handler = async function (event) {
  const token = process.env.ENTSOE_TOKEN;
  if (!token) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ENTSOE_TOKEN mancante nelle variabili ambiente' }) };
  }

  const debug = event.queryStringParameters && event.queryStringParameters.debug;

  const now = new Date();
  const start3h = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const startPrice = new Date(now.getTime() - 1 * 60 * 60 * 1000);
  const endPrice = new Date(now.getTime() + 23 * 60 * 60 * 1000);

  const urlMix = 'https://web-api.tp.entsoe.eu/api' +
    `?documentType=A75&processType=A16&in_Domain=${ZONE_EIC}` +
    `&periodStart=${fmt(start3h)}&periodEnd=${fmt(now)}&securityToken=${token}`;

  const urlLoad = 'https://web-api.tp.entsoe.eu/api' +
    `?documentType=A65&processType=A16&outBiddingZone_Domain=${ZONE_EIC}` +
    `&periodStart=${fmt(start3h)}&periodEnd=${fmt(now)}&securityToken=${token}`;

  const urlPrice = 'https://web-api.tp.entsoe.eu/api' +
    `?documentType=A44&processType=A01&in_Domain=${ZONE_EIC}&out_Domain=${ZONE_EIC}` +
    `&periodStart=${fmt(startPrice)}&periodEnd=${fmt(endPrice)}&securityToken=${token}`;

  // Modalità debug: vedi l'XML grezzo di una singola query — utile se qualcosa si rompe
  if (debug === 'mix' || debug === 'load' || debug === 'price') {
    const urls = { mix: urlMix, load: urlLoad, price: urlPrice };
    try {
      const xml = await fetchXml(urls[debug]);
      return { statusCode: 200, headers: { 'Content-Type': 'text/xml' }, body: xml };
    } catch (err) {
      return { statusCode: 502, body: String(err) };
    }
  }

  const parser = new XMLParser();
  const result = { zone: ZONE_LABEL, updated: now.toISOString() };

  try {
    const xml = await fetchXml(urlMix);
    Object.assign(result, parseMix(xml, parser));
  } catch (err) {
    result.mixError = String(err);
  }

  try {
    const xml = await fetchXml(urlLoad);
    Object.assign(result, parseLoad(xml, parser));
  } catch (err) {
    result.loadError = String(err);
  }

  try {
    const xml = await fetchXml(urlPrice);
    Object.assign(result, parsePrice(xml, parser));
  } catch (err) {
    result.priceError = String(err);
  }

  result.consiglio = costruisciConsiglio(
    result.co2Intensity ?? null,
    result.indexLabel ?? null,
    result.priceNow ?? null,
    result.priceMin ?? null,
    result.priceMax ?? null
  );

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
    body: JSON.stringify(result),
  };
};
