// netlify/functions/mix.js
//
// COSA È CAMBIATO RISPETTO ALLA VERSIONE PRECEDENTE
//
// 1. PREZZO BLOCCATO — bug grave. Prima prendevo il PRIMO punto della serie
//    dei prezzi, che è sempre la prima ora della giornata: per questo restava
//    identico a ogni ricarica. Ora si calcola quale punto corrisponde
//    all'ora corrente, leggendo l'orario di inizio e la risoluzione dichiarati
//    da ENTSO-E.
//
// 2. LENTEZZA + NUMERI TROPPO BASSI — generazione e domanda in Italia sono
//    pubblicate a livello di paese (10YIT-GRTN-----B), non zona per zona.
//    Sommare le sette zone dava totali monchi ED era 7 volte più lento.
//    Ora: 1 chiamata per la generazione, 1 per la domanda, 7 per i prezzi
//    zonali (quelli sì zonali per davvero), tutte in parallelo. 9 invece di 21.
//
// 3. POMPAGGIO CONTATO AL CONTRARIO — le serie di consumo (pompaggio che
//    assorbe energia) venivano sommate alla produzione. Ora vengono escluse.

const { XMLParser } = require('fast-xml-parser');

const IT_COUNTRY = '10YIT-GRTN-----B'; // Italia, area di controllo

const ZONES = [
  { code: 'IT_NORD', eic: '10Y1001A1001A73I', nome: 'Nord' },
  { code: 'IT_CNOR', eic: '10Y1001A1001A70O', nome: 'Centro-Nord' },
  { code: 'IT_CSUD', eic: '10Y1001A1001A71M', nome: 'Centro-Sud' },
  { code: 'IT_SUD', eic: '10Y1001A1001A788', nome: 'Sud' },
  { code: 'IT_CALA', eic: '10Y1001C--00096J', nome: 'Calabria' },
  { code: 'IT_SICI', eic: '10Y1001A1001A75E', nome: 'Sicilia' },
  { code: 'IT_SARD', eic: '10Y1001A1001A74G', nome: 'Sardegna' },
];

const PSR_LABELS = {
  B01: 'Biomasse', B02: 'Lignite', B03: 'Gas da carbone', B04: 'Gas',
  B05: 'Carbone', B06: 'Petrolio', B07: 'Scisto bituminoso', B08: 'Torba',
  B09: 'Geotermico', B10: 'Idro (pompaggio)', B11: 'Idro (fluente)',
  B12: 'Idro (bacino)', B13: 'Marino', B14: 'Nucleare', B15: 'Altro rinnovabile',
  B16: 'Solare', B17: 'Rifiuti', B18: 'Eolico offshore', B19: 'Eolico onshore', B20: 'Altro',
};

// gCO2eq/kWh — valori medi indicativi di riferimento (ordine di grandezza
// tipo IPCC). NON è un inventario certificato: è una stima, e come tale va
// presentata a chi legge il sito.
const CO2_FACTORS = {
  B01: 230, B02: 1050, B03: 700, B04: 490, B05: 820, B06: 650,
  B07: 900, B08: 900, B09: 38, B10: 24, B11: 24, B12: 24, B13: 17,
  B14: 12, B15: 100, B16: 45, B17: 700, B18: 12, B19: 11, B20: 500,
};

function fmt(d) {
  return d.toISOString().slice(0, 16).replace(/[-:T]/g, '');
}

function toArray(x) {
  return Array.isArray(x) ? x : x ? [x] : [];
}

// "PT60M" -> 60, "PT15M" -> 15, "PT30M" -> 30, "P1D" -> 1440
function resolutionMinutes(res) {
  if (!res || typeof res !== 'string') return 60;
  if (res === 'P1D') return 1440;
  const m = res.match(/PT(\d+)M/);
  if (m) return parseInt(m[1], 10);
  const h = res.match(/PT(\d+)H/);
  if (h) return parseInt(h[1], 10) * 60;
  return 60;
}

// Dato un <Period>, restituisce il valore valido all'istante "now".
// ENTSO-E usa curve a gradino: se una posizione manca, vale l'ultima
// dichiarata prima di essa. Quindi si prende il punto con posizione più
// alta che sia <= alla posizione corrispondente a "now".
function valoreAllOra(period, now, campo) {
  if (!period) return null;
  const start = period.timeInterval && period.timeInterval.start;
  if (!start) return null;

  const startMs = new Date(start).getTime();
  if (isNaN(startMs)) return null;

  const resMin = resolutionMinutes(period.resolution);
  const posizioneOra = Math.floor((now.getTime() - startMs) / (resMin * 60 * 1000)) + 1;
  if (posizioneOra < 1) return null;

  const punti = toArray(period.Point);
  let migliore = null;
  let migliorePos = -1;

  for (const p of punti) {
    const pos = parseInt(p && p.position, 10);
    const val = parseFloat(p && p[campo]);
    if (isNaN(pos) || isNaN(val)) continue;
    if (pos <= posizioneOra && pos > migliorePos) {
      migliorePos = pos;
      migliore = val;
    }
  }
  return migliore;
}

async function fetchXml(url) {
  const res = await fetch(url);
  const xml = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + xml.slice(0, 200));
  return xml;
}

// --- generazione per fonte (livello nazionale) ---
function parseGenerazione(xml, parser, now) {
  const data = parser.parse(xml);
  const doc = data && data.GL_MarketDocument;
  const serie = toArray(doc && doc.TimeSeries);
  const perTipo = {};

  for (const ts of serie) {
    // Le serie con outBiddingZone_Domain sono CONSUMO (es. pompaggio che
    // assorbe), non produzione. Vanno escluse o falsano il totale.
    if (ts && ts['outBiddingZone_Domain.mRID']) continue;

    const psrType = ts && ts.MktPSRType ? ts.MktPSRType.psrType : null;
    if (!psrType) continue;

    const val = valoreAllOra(ts.Period, now, 'quantity');
    if (val === null) continue;

    perTipo[psrType] = (perTipo[psrType] || 0) + val;
  }
  return perTipo;
}

// --- domanda totale (livello nazionale) ---
function parseDomanda(xml, parser, now) {
  const data = parser.parse(xml);
  const doc = data && data.GL_MarketDocument;
  const serie = toArray(doc && doc.TimeSeries);
  let val = null;
  for (const ts of serie) {
    const v = valoreAllOra(ts && ts.Period, now, 'quantity');
    if (v !== null) val = v;
  }
  return val;
}

// --- prezzo day-ahead all'ora corrente (per zona) ---
function parsePrezzo(xml, parser, now) {
  const data = parser.parse(xml);
  const doc = data && data.Publication_MarketDocument;
  const serie = toArray(doc && doc.TimeSeries);

  for (const ts of serie) {
    const v = valoreAllOra(ts && ts.Period, now, 'price.amount');
    if (v !== null) return Math.round(v * 100) / 100;
  }
  return null;
}

function costruisciConsiglio(co2, indexLabel, prezzo, prezzoMinGiorno, prezzoMaxGiorno) {
  if (co2 === null || prezzo === null || prezzoMinGiorno === null || prezzoMaxGiorno === null) {
    return 'Dati insufficienti per un consiglio in questo momento.';
  }
  const range = prezzoMaxGiorno - prezzoMinGiorno || 1;
  const posizione = (prezzo - prezzoMinGiorno) / range;
  const prezzoBasso = posizione < 0.33;
  const prezzoAlto = posizione > 0.66;
  const mixSporco = indexLabel === 'rosso';
  const mixPulito = indexLabel === 'verde';

  if (prezzoBasso && !mixSporco) return 'Buon momento per consumi energivori — lavatrice, lavastoviglie, ricarica auto elettrica.';
  if (prezzoAlto && mixSporco) return 'Se puoi, rimanda i consumi pesanti: prezzo alto e mix poco pulito.';
  if (mixPulito && !prezzoAlto) return 'Mix di generazione pulito in questo momento — buona finestra dal punto di vista ambientale.';
  if (prezzoAlto) return 'Prezzo tra i più alti della giornata. Se il consumo può aspettare, meglio spostarlo.';
  return "Momento nella media — né un'occasione né un motivo per rimandare.";
}

// Estrae min e max dei prezzi dell'intera giornata (serve al consiglio:
// "alto" o "basso" ha senso solo rispetto alle altre ore, non in assoluto)
function minMaxGiornata(xml, parser) {
  const data = parser.parse(xml);
  const doc = data && data.Publication_MarketDocument;
  const serie = toArray(doc && doc.TimeSeries);
  const valori = [];
  for (const ts of serie) {
    for (const p of toArray(ts && ts.Period && ts.Period.Point)) {
      const v = parseFloat(p && p['price.amount']);
      if (!isNaN(v)) valori.push(v);
    }
  }
  if (!valori.length) return { min: null, max: null };
  return { min: Math.min(...valori), max: Math.max(...valori) };
}

exports.handler = async function (event) {
  const token = process.env.ENTSOE_TOKEN;
  if (!token) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ENTSOE_TOKEN mancante nelle variabili ambiente' }) };
  }

  const parser = new XMLParser();
  const now = new Date();

  // Finestra stretta per generazione/domanda: dati pubblicati ogni 15 min,
  // 2 ore bastano e tengono l'XML piccolo (quindi veloce da scaricare).
  const start2h = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  // I prezzi sono day-ahead: serve la giornata intera per sapere se l'ora
  // corrente è cara o economica rispetto alle altre.
  const startGiorno = new Date(now.getTime() - 14 * 60 * 60 * 1000);
  const endGiorno = new Date(now.getTime() + 14 * 60 * 60 * 1000);

  const B = 'https://web-api.tp.entsoe.eu/api';
  const urlGen = `${B}?documentType=A75&processType=A16&in_Domain=${IT_COUNTRY}&periodStart=${fmt(start2h)}&periodEnd=${fmt(now)}&securityToken=${token}`;
  const urlLoad = `${B}?documentType=A65&processType=A16&outBiddingZone_Domain=${IT_COUNTRY}&periodStart=${fmt(start2h)}&periodEnd=${fmt(now)}&securityToken=${token}`;
  const urlPrezzo = (eic) =>
    `${B}?documentType=A44&processType=A01&in_Domain=${eic}&out_Domain=${eic}&periodStart=${fmt(startGiorno)}&periodEnd=${fmt(endGiorno)}&securityToken=${token}`;

  const qs = event.queryStringParameters || {};
  if (qs.debug) {
    const zona = ZONES.find((z) => z.code === qs.zone);
    const urls = { gen: urlGen, load: urlLoad, price: urlPrezzo(zona ? zona.eic : ZONES[0].eic) };
    const url = urls[qs.debug];
    if (!url) return { statusCode: 400, body: 'debug deve essere gen, load o price' };
    try {
      return { statusCode: 200, headers: { 'Content-Type': 'text/xml' }, body: await fetchXml(url) };
    } catch (err) {
      return { statusCode: 502, body: String(err) };
    }
  }

  // TUTTE le chiamate in parallelo: 9 in tutto, non 21 in fila.
  const [genRes, loadRes, ...prezziRes] = await Promise.allSettled([
    fetchXml(urlGen),
    fetchXml(urlLoad),
    ...ZONES.map((z) => fetchXml(urlPrezzo(z.eic))),
  ]);

  const problemi = [];

  // --- generazione ---
  let perTipo = {};
  if (genRes.status === 'fulfilled') {
    try { perTipo = parseGenerazione(genRes.value, parser, now); }
    catch (err) { problemi.push('generazione: parsing fallito'); }
    if (Object.keys(perTipo).length === 0) problemi.push('generazione: nessun dato per l\'ora corrente');
  } else {
    problemi.push('generazione: ' + String(genRes.reason).slice(0, 120));
  }

  const totalMw = Object.values(perTipo).reduce((a, b) => a + b, 0);

  const mix = Object.entries(perTipo)
    .map(([type, mw]) => ({
      type,
      label: PSR_LABELS[type] || type,
      mw: Math.round(mw),
      pct: totalMw > 0 ? +((mw / totalMw) * 100).toFixed(1) : 0,
    }))
    .filter((v) => v.mw > 0)
    .sort((a, b) => b.mw - a.mw);

  const co2Intensity = totalMw > 0
    ? Math.round(Object.entries(perTipo).reduce((s, [t, mw]) => s + mw * (CO2_FACTORS[t] || 500), 0) / totalMw)
    : null;

  let indexLabel = null;
  if (co2Intensity !== null) {
    indexLabel = 'verde';
    if (co2Intensity > 250) indexLabel = 'giallo';
    if (co2Intensity > 450) indexLabel = 'rosso';
  }

  // --- domanda ---
  let loadMw = null;
  if (loadRes.status === 'fulfilled') {
    try { loadMw = parseDomanda(loadRes.value, parser, now); }
    catch (err) { problemi.push('domanda: parsing fallito'); }
    if (loadMw === null) problemi.push('domanda: nessun dato per l\'ora corrente');
  } else {
    problemi.push('domanda: ' + String(loadRes.reason).slice(0, 120));
  }

  // Controllo di plausibilità: la domanda italiana sta praticamente sempre
  // tra 15 e 60 GW. Fuori da lì è quasi certo un problema di dati, non un
  // evento reale — meglio dirlo che pubblicare un numero assurdo.
  let avvisoDomanda = null;
  if (loadMw !== null && (loadMw < 15000 || loadMw > 60000)) {
    avvisoDomanda = 'Valore fuori dal range atteso — dato probabilmente parziale.';
  }

  // --- prezzi zonali ---
  const zonePrices = [];
  let minGiorno = null;
  let maxGiorno = null;

  prezziRes.forEach((r, i) => {
    const zona = ZONES[i];
    if (r.status !== 'fulfilled') {
      problemi.push('prezzo ' + zona.code + ': non disponibile');
      return;
    }
    try {
      const prezzo = parsePrezzo(r.value, parser, now);
      if (prezzo !== null) {
        zonePrices.push({ code: zona.code, name: zona.nome, price: prezzo });
      } else {
        problemi.push('prezzo ' + zona.code + ': nessun dato per l\'ora corrente');
      }
      const mm = minMaxGiornata(r.value, parser);
      if (mm.min !== null) {
        minGiorno = minGiorno === null ? mm.min : Math.min(minGiorno, mm.min);
        maxGiorno = maxGiorno === null ? mm.max : Math.max(maxGiorno, mm.max);
      }
    } catch (err) {
      problemi.push('prezzo ' + zona.code + ': parsing fallito');
    }
  });

  // Media semplice delle zone disponibili. NON è il PUN ufficiale, che è una
  // media PESATA sui volumi scambiati e lo pubblica il GME. Etichettato come
  // tale, per non spacciare una stima per un dato ufficiale.
  const prezzoMedio = zonePrices.length
    ? Math.round((zonePrices.reduce((s, z) => s + z.price, 0) / zonePrices.length) * 100) / 100
    : null;

  const result = {
    updated: now.toISOString(),
    fonte: 'ENTSO-E Transparency Platform',

    totalGenerationMw: totalMw > 0 ? Math.round(totalMw) : null,
    loadMw: loadMw !== null ? Math.round(loadMw) : null,
    avvisoDomanda,

    co2Intensity,
    co2Nota: 'stima da fattori di emissione medi, non un dato certificato',
    indexLabel,
    dominant: mix[0] ? mix[0].label : null,
    mix,

    prezzoMedio,
    prezzoMedioNota: 'media semplice delle zone disponibili, non il PUN ufficiale GME',
    prezzoMinGiorno: minGiorno !== null ? Math.round(minGiorno * 100) / 100 : null,
    prezzoMaxGiorno: maxGiorno !== null ? Math.round(maxGiorno * 100) / 100 : null,
    zonePrices,

    consiglio: costruisciConsiglio(co2Intensity, indexLabel, prezzoMedio, minGiorno, maxGiorno),
    problemi,
  };

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      // Cache breve al bordo: i dati ENTSO-E si aggiornano ogni 15 minuti,
      // quindi ricalcolare più spesso non aggiunge informazione. Il primo
      // visitatore aspetta, gli altri sono istantanei.
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
    },
    body: JSON.stringify(result),
  };
};