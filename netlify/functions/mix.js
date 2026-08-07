// netlify/functions/mix.js
// Stessa logica semplice di prima (mix, domanda, prezzo, consiglio), ora
// estesa a tutte e sette le zone italiane. Le zone vengono interrogate una
// alla volta (non tutte insieme) apposta per non sparare troppe richieste
// simultanee a ENTSO-E — è quello che probabilmente ha fatto scattare
// "nessun dato disponibile" nella versione precedente.

const { XMLParser } = require('fast-xml-parser');

const PSR_LABELS = {
  B01: 'Biomasse', B02: 'Lignite', B03: 'Gas da carbone', B04: 'Gas',
  B05: 'Carbone', B06: 'Petrolio', B07: 'Scisto bituminoso', B08: 'Torba',
  B09: 'Geotermico', B10: 'Idro (pompaggio)', B11: 'Idro (fluente)',
  B12: 'Idro (bacino)', B13: 'Marino', B14: 'Nucleare', B15: 'Altro rinnovabile',
  B16: 'Solare', B17: 'Rifiuti', B18: 'Eolico offshore', B19: 'Eolico onshore', B20: 'Altro',
};

// gCO2eq/kWh — valori medi indicativi di riferimento, non un inventario certificato.
const CO2_FACTORS = {
  B01: 230, B02: 1050, B03: 700, B04: 490, B05: 820, B06: 650,
  B07: 900, B08: 900, B09: 38, B10: 24, B11: 24, B12: 24, B13: 17,
  B14: 12, B15: 100, B16: 45, B17: 700, B18: 12, B19: 11, B20: 500,
};

const ZONES = [
  { code: 'IT_NORD', eic: '10Y1001A1001A73I', nome: 'Nord' },
  { code: 'IT_CNOR', eic: '10Y1001A1001A70O', nome: 'Centro-Nord' },
  { code: 'IT_CSUD', eic: '10Y1001A1001A71M', nome: 'Centro-Sud' },
  { code: 'IT_SUD', eic: '10Y1001A1001A788', nome: 'Sud' },
  { code: 'IT_CALA', eic: '10Y1001C--00096J', nome: 'Calabria' },
  { code: 'IT_SICI', eic: '10Y1001A1001A75E', nome: 'Sicilia' },
  { code: 'IT_SARD', eic: '10Y1001A1001A74G', nome: 'Sardegna' },
];

function fmt(d) {
  return d.toISOString().slice(0, 16).replace(/[-:T]/g, '');
}

async function fetchXml(url) {
  const res = await fetch(url);
  const xml = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + xml.slice(0, 200));
  return xml;
}

function sommaPerTipo(xml, parser) {
  const data = parser.parse(xml);
  const series = data && data.GL_MarketDocument ? data.GL_MarketDocument.TimeSeries : null;
  const seriesArray = Array.isArray(series) ? series : series ? [series] : [];
  const perTipo = {};
  for (const ts of seriesArray) {
    const psrType = ts && ts.MktPSRType ? ts.MktPSRType.psrType : null;
    if (!psrType) continue;
    const points = ts && ts.Period ? ts.Period.Point : null;
    const pointsArray = Array.isArray(points) ? points : points ? [points] : [];
    if (!pointsArray.length) continue;
    const last = pointsArray[pointsArray.length - 1];
    const qty = parseFloat(last && last.quantity);
    if (isNaN(qty)) continue;
    perTipo[psrType] = (perTipo[psrType] || 0) + qty;
  }
  return perTipo;
}

function ultimoValore(xml, parser) {
  const data = parser.parse(xml);
  const series = data && data.GL_MarketDocument ? data.GL_MarketDocument.TimeSeries : null;
  const seriesArray = Array.isArray(series) ? series : series ? [series] : [];
  let val = null;
  for (const ts of seriesArray) {
    const points = ts && ts.Period ? ts.Period.Point : null;
    const pointsArray = Array.isArray(points) ? points : points ? [points] : [];
    if (pointsArray.length) {
      const last = pointsArray[pointsArray.length - 1];
      const qty = parseFloat(last && last.quantity);
      if (!isNaN(qty)) val = qty;
    }
  }
  return val;
}

function prezzoCorrente(xml, parser) {
  const data = parser.parse(xml);
  const series = data && data.Publication_MarketDocument ? data.Publication_MarketDocument.TimeSeries : null;
  const seriesArray = Array.isArray(series) ? series : series ? [series] : [];
  for (const ts of seriesArray) {
    const points = ts && ts.Period ? ts.Period.Point : null;
    const pointsArray = Array.isArray(points) ? points : points ? [points] : [];
    for (const p of pointsArray) {
      const amount = parseFloat(p && p['price.amount']);
      if (!isNaN(amount)) return Math.round(amount * 10) / 10;
    }
  }
  return null;
}

function costruisciConsiglio(co2, indexLabel, prezzoMedio, prezzoMin, prezzoMax) {
  if (co2 === null || prezzoMedio === null || prezzoMin === null || prezzoMax === null) {
    return 'Dati insufficienti per un consiglio in questo momento.';
  }
  const range = prezzoMax - prezzoMin || 1;
  const posizione = (prezzoMedio - prezzoMin) / range;
  const prezzoBasso = posizione < 0.33;
  const prezzoAlto = posizione > 0.66;
  const mixSporco = indexLabel === 'rosso';
  const mixPulito = indexLabel === 'verde';

  if (prezzoBasso && !mixSporco) return 'Buon momento per consumi energivori — lavatrice, lavastoviglie, ricarica auto elettrica.';
  if (prezzoAlto && mixSporco) return 'Se puoi, rimanda i consumi pesanti. Prezzo alto e mix poco pulito in questo momento.';
  if (mixPulito && !prezzoAlto) return 'Mix di generazione pulito in questo momento — buona finestra dal punto di vista ambientale.';
  if (prezzoAlto) return 'Prezzo tra i più alti tra le zone in questo momento. Se puoi, meglio aspettare.';
  return "Momento nella media — né un'occasione né un motivo per rimandare.";
}

exports.handler = async function (event) {
  const token = process.env.ENTSOE_TOKEN;
  if (!token) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ENTSOE_TOKEN mancante nelle variabili ambiente' }) };
  }

  const parser = new XMLParser();
  const now = new Date();
  const start3h = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const startPrice = new Date(now.getTime() - 1 * 60 * 60 * 1000);
  const endPrice = new Date(now.getTime() + 23 * 60 * 60 * 1000);

  const qs = event.queryStringParameters || {};
  if (qs.debug) {
    const zona = ZONES.find((z) => z.code === (qs.zone || 'IT_NORD')) || ZONES[0];
    const urls = {
      mix: `https://web-api.tp.entsoe.eu/api?documentType=A75&processType=A16&in_Domain=${zona.eic}&periodStart=${fmt(start3h)}&periodEnd=${fmt(now)}&securityToken=${token}`,
      load: `https://web-api.tp.entsoe.eu/api?documentType=A65&processType=A16&outBiddingZone_Domain=${zona.eic}&periodStart=${fmt(start3h)}&periodEnd=${fmt(now)}&securityToken=${token}`,
      price: `https://web-api.tp.entsoe.eu/api?documentType=A44&processType=A01&in_Domain=${zona.eic}&out_Domain=${zona.eic}&periodStart=${fmt(startPrice)}&periodEnd=${fmt(endPrice)}&securityToken=${token}`,
    };
    const url = urls[qs.debug];
    if (!url) return { statusCode: 400, body: 'debug deve essere mix, load o price' };
    try {
      const xml = await fetchXml(url);
      return { statusCode: 200, headers: { 'Content-Type': 'text/xml' }, body: xml };
    } catch (err) {
      return { statusCode: 502, body: String(err) };
    }
  }

  // Una zona alla volta, non tutte insieme — deliberatamente più lento ma
  // molto meno probabile che faccia scattare un limite di frequenza.
  const perTipoNazionale = {};
  let demandaTotale = 0;
  let demandaConta = 0;
  const zonePrezzi = [];
  const zoneStatus = [];

  for (const zona of ZONES) {
    const stato = { code: zona.code, mix: false, load: false, price: false };
    const urlMix = `https://web-api.tp.entsoe.eu/api?documentType=A75&processType=A16&in_Domain=${zona.eic}&periodStart=${fmt(start3h)}&periodEnd=${fmt(now)}&securityToken=${token}`;
    const urlLoad = `https://web-api.tp.entsoe.eu/api?documentType=A65&processType=A16&outBiddingZone_Domain=${zona.eic}&periodStart=${fmt(start3h)}&periodEnd=${fmt(now)}&securityToken=${token}`;
    const urlPrice = `https://web-api.tp.entsoe.eu/api?documentType=A44&processType=A01&in_Domain=${zona.eic}&out_Domain=${zona.eic}&periodStart=${fmt(startPrice)}&periodEnd=${fmt(endPrice)}&securityToken=${token}`;

    try {
      const mixXml = await fetchXml(urlMix);
      const perTipo = sommaPerTipo(mixXml, parser);
      if (Object.keys(perTipo).length > 0) stato.mix = true;
      for (const [tipo, mw] of Object.entries(perTipo)) {
        perTipoNazionale[tipo] = (perTipoNazionale[tipo] || 0) + mw;
      }
    } catch (err) { stato.mixErrore = String(err).slice(0, 150); }

    try {
      const loadXml = await fetchXml(urlLoad);
      const val = ultimoValore(loadXml, parser);
      if (val !== null) { demandaTotale += val; demandaConta++; stato.load = true; }
    } catch (err) { stato.loadErrore = String(err).slice(0, 150); }

    try {
      const priceXml = await fetchXml(urlPrice);
      const prezzo = prezzoCorrente(priceXml, parser);
      if (prezzo !== null) { zonePrezzi.push({ name: zona.nome, price: prezzo }); stato.price = true; }
    } catch (err) { stato.priceErrore = String(err).slice(0, 150); }

    zoneStatus.push(stato);
  }

  const totalMw = Object.values(perTipoNazionale).reduce((a, b) => a + b, 0);

  const mix = Object.entries(perTipoNazionale)
    .map(([type, mw]) => ({
      type, label: PSR_LABELS[type] || type, mw: Math.round(mw),
      pct: totalMw > 0 ? +((mw / totalMw) * 100).toFixed(1) : 0,
    }))
    .sort((a, b) => b.mw - a.mw);

  const co2Intensity = totalMw > 0
    ? Math.round(Object.entries(perTipoNazionale).reduce((s, [t, mw]) => s + mw * (CO2_FACTORS[t] || 500), 0) / totalMw)
    : null;

  let indexLabel = 'verde';
  if (co2Intensity !== null && co2Intensity > 250) indexLabel = 'giallo';
  if (co2Intensity !== null && co2Intensity > 450) indexLabel = 'rosso';

  const prezzoMedio = zonePrezzi.length ? Math.round((zonePrezzi.reduce((s, z) => s + z.price, 0) / zonePrezzi.length) * 10) / 10 : null;
  const prezzoMin = zonePrezzi.length ? Math.min(...zonePrezzi.map((z) => z.price)) : null;
  const prezzoMax = zonePrezzi.length ? Math.max(...zonePrezzi.map((z) => z.price)) : null;

  const result = {
    zone: 'Italia (7 zone)',
    updated: now.toISOString(),
    totalGenerationMw: Math.round(totalMw),
    loadMw: demandaConta > 0 ? Math.round(demandaTotale) : null,
    co2Intensity,
    indexLabel,
    dominant: mix[0] ? mix[0].label : null,
    mix,
    priceNow: prezzoMedio,
    priceMin: prezzoMin,
    priceMax: prezzoMax,
    zonePrices: zonePrezzi,
    zoneStatus: zoneStatus,
    consiglio: costruisciConsiglio(co2Intensity, indexLabel, prezzoMedio, prezzoMin, prezzoMax),
  };

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' },
    body: JSON.stringify(result),
  };
};
