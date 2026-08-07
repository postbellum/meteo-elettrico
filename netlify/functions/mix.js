// netlify/functions/mix.js
//
// FONTE UNICA: ENTSO-E Transparency Platform (regolamento UE 543/2013).
// Codici EIC e document type verificati contro la documentazione ufficiale.
//
// CORREZIONI RISPETTO ALLA VERSIONE PRECEDENTE
// 1. Fuso orario: gli orari nei consigli erano calcolati in UTC (fuso del
//    server) invece che Europe/Rome. In estate sbagliavano di 2 ore.
// 2. Somma eolico+solare: le serie di psrType diversi allo stesso orario
//    venivano sovrascritte invece che sommate → rinnovabili sottostimate.
// 3. Doppio conteggio: più TimeSeries per la stessa fonte (tipico a cavallo
//    di due giorni) venivano sommate invece di unite sull'asse temporale.
//
// LIMITI DICHIARATI (vanno detti a chi legge il sito)
// - La CO2 è calcolata sul mix PRODOTTO in Italia, senza tenere conto delle
//   importazioni (l'Italia importa una quota rilevante di energia, in buona
//   parte a bassa intensità carbonica): il valore reale sul consumo è
//   verosimilmente più basso di quello mostrato.
// - I fattori di emissione sono le mediane di ciclo di vita IPCC AR5: stime
//   di letteratura, non misure dei singoli impianti italiani.
// - Il prezzo è quello all'ingrosso del mercato day-ahead, non il prezzo
//   finale in bolletta (che include oneri, reti, imposte).
// - La media tra zone NON è il PUN, che è una media pesata sui volumi ed è
//   pubblicata dal GME.

const { XMLParser } = require('fast-xml-parser');

const IT_COUNTRY = '10YIT-GRTN-----B'; // Italy, IT CA / MBA — verificato

// Codici EIC verificati uno per uno contro la mappatura ufficiale
const ZONES = [
  { code: 'IT_NORD', eic: '10Y1001A1001A73I', nome: 'Nord' },
  { code: 'IT_CNOR', eic: '10Y1001A1001A70O', nome: 'Centro-Nord' },
  { code: 'IT_CSUD', eic: '10Y1001A1001A71M', nome: 'Centro-Sud' },
  { code: 'IT_SUD',  eic: '10Y1001A1001A788', nome: 'Sud' },
  { code: 'IT_CALA', eic: '10Y1001C--00096J', nome: 'Calabria' },
  { code: 'IT_SICI', eic: '10Y1001A1001A75E', nome: 'Sicilia' },
  { code: 'IT_SARD', eic: '10Y1001A1001A74G', nome: 'Sardegna' },
];

// Etichette psrType secondo la codifica ufficiale ENTSO-E
const PSR_LABELS = {
  A03: 'Misto', A04: 'Generazione', A05: 'Carico',
  B01: 'Biomasse', B02: 'Lignite', B03: 'Gas da carbone', B04: 'Gas',
  B05: 'Carbone', B06: 'Petrolio', B07: 'Scisto bituminoso', B08: 'Torba',
  B09: 'Geotermico', B10: 'Idro (pompaggio)', B11: 'Idro (fluente)',
  B12: 'Idro (bacino)', B13: 'Marino', B14: 'Nucleare', B15: 'Altro rinnovabile',
  B16: 'Solare', B17: 'Rifiuti', B18: 'Eolico offshore', B19: 'Eolico onshore',
  B20: 'Altro', B25: 'Accumulo',
};

// Mediane di ciclo di vita IPCC AR5 (gCO2eq/kWh). Stime di letteratura.
const CO2_FACTORS = {
  B01: 230, B02: 1050, B03: 700, B04: 490, B05: 820, B06: 650,
  B07: 900, B08: 900, B09: 38, B10: 24, B11: 24, B12: 24, B13: 17,
  B14: 12, B15: 100, B16: 45, B17: 700, B18: 12, B19: 11, B20: 500, B25: 24,
};

const PSR_EOLICO_SOLARE = ['B16', 'B18', 'B19'];

const SPREAD_MINIMO = 15;   // €/MWh sotto cui spostare un consumo non conviene
const TOLLERANZA = 0.15;    // entro il 15% dello spread dal minimo = "va bene adesso"
const DURATA_DEFAULT = 2;

function fmt(d) { return d.toISOString().slice(0, 16).replace(/[-:T]/g, ''); }
function toArray(x) { return Array.isArray(x) ? x : x ? [x] : []; }

// CORREZIONE 1: orari sempre in fuso italiano, mai in quello del server
function oraRoma(ms) {
  try {
    return new Intl.DateTimeFormat('it-IT', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Rome',
    }).format(new Date(ms));
  } catch (e) {
    return new Date(ms).toISOString().slice(11, 16) + ' UTC';
  }
}

function resolutionMinutes(res) {
  if (!res || typeof res !== 'string') return 60;
  if (res === 'P1D') return 1440;
  const m = res.match(/PT(\d+)M/); if (m) return parseInt(m[1], 10);
  const h = res.match(/PT(\d+)H/); if (h) return parseInt(h[1], 10) * 60;
  return 60;
}

function puntiTemporali(period, campo) {
  if (!period || !period.timeInterval || !period.timeInterval.start) return [];
  const startMs = new Date(period.timeInterval.start).getTime();
  if (isNaN(startMs)) return [];
  const resMin = resolutionMinutes(period.resolution);
  const out = [];
  for (const p of toArray(period.Point)) {
    const pos = parseInt(p && p.position, 10);
    const v = parseFloat(p && p[campo]);
    if (isNaN(pos) || isNaN(v)) continue;
    out.push({ t: startMs + (pos - 1) * resMin * 60000, v });
  }
  return out;
}

// Curva a gradino: valore valido a un istante = ultimo punto dichiarato
// prima o in quell'istante.
function valoreA(punti, tMs) {
  let best = null;
  for (const p of punti) { if (p.t <= tMs) best = p.v; else break; }
  return best;
}

// CORREZIONE 3: unisce più serie sullo stesso asse temporale (l'ultimo
// valore dichiarato per un dato istante vince) invece di sommarle.
function unisciSerie(liste) {
  const perIstante = new Map();
  for (const lista of liste) for (const p of lista) perIstante.set(p.t, p.v);
  return [...perIstante.entries()].map(([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
}

async function fetchXml(url) {
  const res = await fetch(url);
  const xml = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + xml.slice(0, 160));
  return xml;
}

// Raggruppa le TimeSeries per psrType, unendo (non sommando) le serie
// dello stesso tipo. Chi non ha psrType finisce sotto '_'.
function seriePerTipo(xml, parser, radice, campo, opt) {
  opt = opt || {};
  const data = parser.parse(xml);
  const doc = data && data[radice];
  const gruppi = {};

  for (const ts of toArray(doc && doc.TimeSeries)) {
    // Nelle serie di generazione, outBiddingZone_Domain indica CONSUMO
    // (es. pompaggio che assorbe): va escluso dalla produzione.
    if (opt.escludiConsumo && ts && ts['outBiddingZone_Domain.mRID']) continue;

    const psr = (ts && ts.MktPSRType && ts.MktPSRType.psrType) || '_';
    if (opt.soloPsr && !opt.soloPsr.includes(psr)) continue;

    (gruppi[psr] = gruppi[psr] || []).push(puntiTemporali(ts && ts.Period, campo));
  }

  const out = {};
  for (const [psr, liste] of Object.entries(gruppi)) out[psr] = unisciSerie(liste);
  return out;
}

function oreFuture(now, orizzonteMax) {
  const ore = [];
  const primo = Math.floor(now.getTime() / 3600000) * 3600000;
  for (let i = 0; i < 36; i++) {
    const t = primo + i * 3600000;
    if (t > orizzonteMax) break;
    ore.push(t);
  }
  return ore;
}

// --- criterio del consiglio sul prezzo ---
function consigliaPrezzo(ore, valori, durataOre, now) {
  const validi = valori.map((v, i) => ({ t: ore[i], v })).filter((x) => x.v !== null);
  if (validi.length < durataOre + 1) {
    return { tipo: 'indisponibile', testo: 'Prezzi delle prossime ore non ancora pubblicati.' };
  }

  const prezzi = validi.map((x) => x.v);
  const min = Math.min(...prezzi), max = Math.max(...prezzi), spread = max - min;

  const medie = [];
  for (let i = 0; i + durataOre <= validi.length; i++) {
    const f = validi.slice(i, i + durataOre);
    medie.push({ inizio: f[0].t, media: f.reduce((s, x) => s + x.v, 0) / durataOre });
  }
  if (!medie.length) return { tipo: 'indisponibile', testo: 'Orizzonte troppo corto.' };

  const migliore = medie.reduce((a, b) => (b.media < a.media ? b : a));
  const adesso = medie[0];

  const base = {
    spread: Math.round(spread * 100) / 100,
    minOrizzonte: Math.round(min * 100) / 100,
    maxOrizzonte: Math.round(max * 100) / 100,
    finestraOttimaleInizio: new Date(migliore.inizio).toISOString(),
    finestraOttimalePrezzo: Math.round(migliore.media * 100) / 100,
    prezzoAdesso: Math.round(adesso.media * 100) / 100,
    durataOre,
    oreConsiderate: validi.length,
  };

  if (spread < SPREAD_MINIMO) {
    return Object.assign(base, {
      tipo: 'piatto',
      titolo: 'Il prezzo non fa differenza',
      testo: `Nelle prossime ${validi.length} ore il prezzo varia di appena ${spread.toFixed(1)} €/MWh. Spostare un consumo non cambia nulla di rilevante: scegli in base al segnale ambientale.`,
    });
  }

  if (adesso.media <= min + spread * TOLLERANZA) {
    return Object.assign(base, {
      tipo: 'adesso',
      titolo: 'Buon momento, procedi',
      testo: `Le prossime ${durataOre} ore sono tra le più economiche dell'orizzonte pubblicato: ${adesso.media.toFixed(1)} €/MWh, contro un massimo di ${max.toFixed(1)}.`,
    });
  }

  const risparmio = ((adesso.media - migliore.media) / adesso.media) * 100;
  const traOre = Math.round((migliore.inizio - now.getTime()) / 3600000);

  return Object.assign(base, {
    tipo: 'aspetta',
    titolo: `Conviene aspettare le ${oraRoma(migliore.inizio)}`,
    testo: `Adesso ${adesso.media.toFixed(1)} €/MWh; tra ${traOre} ${traOre === 1 ? 'ora' : 'ore'} scende a ${migliore.media.toFixed(1)}, circa ${risparmio.toFixed(0)}% in meno sulla sola quota energia.`,
    risparmioPct: Math.round(risparmio),
  });
}

function consigliaVerde(ore, quote) {
  const validi = quote.map((v, i) => ({ t: ore[i], v })).filter((x) => x.v !== null);
  if (validi.length < 2) return null;

  const valori = validi.map((x) => x.v);
  const max = Math.max(...valori);
  const adesso = validi[0].v;
  const migliore = validi.reduce((a, b) => (b.v > a.v ? b : a));

  const curva = validi.map((x) => ({ t: new Date(x.t).toISOString(), v: Math.round(x.v) }));

  if (adesso >= max - 5) {
    return {
      tipo: 'adesso',
      testo: `Eolico e solare coprono ora circa il ${adesso.toFixed(0)}% della domanda prevista: è tra i valori più alti delle prossime ore.`,
      quotaAdesso: Math.round(adesso), quotaMigliore: Math.round(max), curva,
    };
  }
  return {
    tipo: 'aspetta',
    testo: `Eolico e solare coprono ora circa il ${adesso.toFixed(0)}% della domanda prevista; salgono al ${max.toFixed(0)}% verso le ${oraRoma(migliore.t)}.`,
    quotaAdesso: Math.round(adesso), quotaMigliore: Math.round(max),
    oraMigliore: new Date(migliore.t).toISOString(), curva,
  };
}

exports.handler = async function (event) {
  const token = process.env.ENTSOE_TOKEN;
  if (!token) return { statusCode: 500, body: JSON.stringify({ error: 'ENTSOE_TOKEN mancante nelle variabili ambiente' }) };

  const parser = new XMLParser();
  const now = new Date();
  const qs = event.queryStringParameters || {};
  const durata = Math.max(1, Math.min(6, parseInt(qs.durata, 10) || DURATA_DEFAULT));

  const start3h = new Date(now.getTime() - 3 * 3600000);
  const startG = new Date(now.getTime() - 14 * 3600000);
  const endG = new Date(now.getTime() + 30 * 3600000);

  const B = 'https://web-api.tp.entsoe.eu/api';
  const urlGen    = `${B}?documentType=A75&processType=A16&in_Domain=${IT_COUNTRY}&periodStart=${fmt(start3h)}&periodEnd=${fmt(now)}&securityToken=${token}`;
  const urlLoad   = `${B}?documentType=A65&processType=A16&outBiddingZone_Domain=${IT_COUNTRY}&periodStart=${fmt(start3h)}&periodEnd=${fmt(now)}&securityToken=${token}`;
  const urlLoadFc = `${B}?documentType=A65&processType=A01&outBiddingZone_Domain=${IT_COUNTRY}&periodStart=${fmt(startG)}&periodEnd=${fmt(endG)}&securityToken=${token}`;
  const urlRinnFc = `${B}?documentType=A69&processType=A01&in_Domain=${IT_COUNTRY}&periodStart=${fmt(startG)}&periodEnd=${fmt(endG)}&securityToken=${token}`;
  const urlPrezzo = (eic) => `${B}?documentType=A44&processType=A01&in_Domain=${eic}&out_Domain=${eic}&periodStart=${fmt(startG)}&periodEnd=${fmt(endG)}&securityToken=${token}`;

  if (qs.debug) {
    const z = ZONES.find((x) => x.code === qs.zone);
    const urls = { gen: urlGen, load: urlLoad, loadfc: urlLoadFc, rinnfc: urlRinnFc, price: urlPrezzo(z ? z.eic : ZONES[0].eic) };
    if (!urls[qs.debug]) return { statusCode: 400, body: 'debug: gen | load | loadfc | rinnfc | price (&zone=IT_SICI)' };
    try { return { statusCode: 200, headers: { 'Content-Type': 'text/xml' }, body: await fetchXml(urls[qs.debug]) }; }
    catch (err) { return { statusCode: 502, body: String(err) }; }
  }

  const [genR, loadR, loadFcR, rinnFcR, ...prezziR] = await Promise.allSettled([
    fetchXml(urlGen), fetchXml(urlLoad), fetchXml(urlLoadFc), fetchXml(urlRinnFc),
    ...ZONES.map((z) => fetchXml(urlPrezzo(z.eic))),
  ]);

  const problemi = [];

  // --- generazione per fonte, adesso ---
  const perTipo = {};
  if (genR.status === 'fulfilled') {
    try {
      const serie = seriePerTipo(genR.value, parser, 'GL_MarketDocument', 'quantity', { escludiConsumo: true });
      for (const [psr, punti] of Object.entries(serie)) {
        const v = valoreA(punti, now.getTime());
        if (v !== null && v > 0) perTipo[psr] = v;
      }
    } catch (e) { problemi.push('generazione: parsing fallito'); }
    if (!Object.keys(perTipo).length) problemi.push('generazione: nessun dato per l\'ora corrente');
  } else problemi.push('generazione non disponibile');

  const totalMw = Object.values(perTipo).reduce((a, b) => a + b, 0);
  const mix = Object.entries(perTipo)
    .map(([type, mw]) => ({ type, label: PSR_LABELS[type] || type, mw: Math.round(mw), pct: totalMw > 0 ? +((mw / totalMw) * 100).toFixed(1) : 0 }))
    .sort((a, b) => b.mw - a.mw);

  const co2 = totalMw > 0
    ? Math.round(Object.entries(perTipo).reduce((s, [t, mw]) => s + mw * (CO2_FACTORS[t] || 500), 0) / totalMw) : null;
  const indexLabel = co2 === null ? null : co2 > 450 ? 'rosso' : co2 > 250 ? 'giallo' : 'verde';

  // --- domanda adesso ---
  let loadMw = null;
  if (loadR.status === 'fulfilled') {
    try {
      const serie = seriePerTipo(loadR.value, parser, 'GL_MarketDocument', 'quantity');
      const tutte = unisciSerie(Object.values(serie));
      loadMw = valoreA(tutte, now.getTime());
    } catch (e) { problemi.push('domanda: parsing fallito'); }
    if (loadMw === null) problemi.push('domanda: nessun dato per l\'ora corrente');
  } else problemi.push('domanda non disponibile');

  const avvisoDomanda = (loadMw !== null && (loadMw < 15000 || loadMw > 60000))
    ? 'Fuori dal range storico atteso (15–60 GW): dato probabilmente parziale.' : null;

  // --- prezzi zonali + consiglio per zona ---
  const zone = [];
  prezziR.forEach((r, i) => {
    const z = ZONES[i];
    if (r.status !== 'fulfilled') { problemi.push('prezzo ' + z.nome + ': non disponibile'); return; }
    let punti = [];
    try {
      const serie = seriePerTipo(r.value, parser, 'Publication_MarketDocument', 'price.amount');
      punti = unisciSerie(Object.values(serie));
    } catch (e) { problemi.push('prezzo ' + z.nome + ': parsing fallito'); return; }
    if (!punti.length) { problemi.push('prezzo ' + z.nome + ': serie vuota'); return; }

    const fine = punti[punti.length - 1].t + 3600000;
    const ore = oreFuture(now, Math.min(fine, now.getTime() + 30 * 3600000));
    const valori = ore.map((t) => valoreA(punti, t));

    zone.push({
      code: z.code, name: z.nome,
      prezzoAdesso: valoreA(punti, now.getTime()),
      curva: ore.map((t, k) => ({ t: new Date(t).toISOString(), v: valori[k] })).filter((x) => x.v !== null),
      consiglio: consigliaPrezzo(ore, valori, durata, now),
    });
  });

  // --- CORREZIONE 2: quota eolico+solare, sommando davvero i psrType ---
  let verde = null;
  if (rinnFcR.status === 'fulfilled' && loadFcR.status === 'fulfilled') {
    try {
      const serieRinn = seriePerTipo(rinnFcR.value, parser, 'GL_MarketDocument', 'quantity', { soloPsr: PSR_EOLICO_SOLARE });
      const serieLoad = unisciSerie(Object.values(seriePerTipo(loadFcR.value, parser, 'GL_MarketDocument', 'quantity')));
      const listeRinn = Object.values(serieRinn);

      if (listeRinn.length && serieLoad.length) {
        const fine = Math.min(
          Math.max(...listeRinn.map((s) => s[s.length - 1].t)),
          serieLoad[serieLoad.length - 1].t
        ) + 3600000;
        const ore = oreFuture(now, Math.min(fine, now.getTime() + 30 * 3600000));

        const quote = ore.map((t) => {
          // somma di solare + eolico onshore + offshore allo stesso istante
          let rinn = 0, ok = false;
          for (const s of listeRinn) { const v = valoreA(s, t); if (v !== null) { rinn += v; ok = true; } }
          const dom = valoreA(serieLoad, t);
          return ok && dom ? (rinn / dom) * 100 : null;
        });
        verde = consigliaVerde(ore, quote);
      } else problemi.push('previsione eolico+solare: serie incomplete');
    } catch (e) { problemi.push('previsione eolico+solare: parsing fallito'); }
  } else problemi.push('previsione eolico+solare non disponibile');

  const prezzoMedio = zone.length && zone.every((z) => z.prezzoAdesso !== null)
    ? Math.round((zone.reduce((s, z) => s + z.prezzoAdesso, 0) / zone.length) * 100) / 100 : null;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Netlify-CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900',
    },
    body: JSON.stringify({
      updated: now.toISOString(),
      fonte: 'ENTSO-E Transparency Platform',
      durataConsiderata: durata,

      totalGenerationMw: totalMw > 0 ? Math.round(totalMw) : null,
      loadMw: loadMw !== null ? Math.round(loadMw) : null,
      avvisoDomanda,

      co2Intensity: co2,
      indexLabel,
      dominant: mix[0] ? mix[0].label : null,
      mix,

      prezzoMedio,
      zone,
      verde,

      note: {
        co2: 'Stima su mediane di ciclo di vita IPCC AR5, calcolata sul mix prodotto in Italia. Non tiene conto delle importazioni: il valore reale sul consumo è verosimilmente più basso.',
        prezzo: 'Prezzo all\'ingrosso del mercato del giorno prima, non il prezzo finale in bolletta.',
        media: 'La media tra zone non è il PUN: quello è una media pesata sui volumi, pubblicata dal GME.',
        mix: 'Percentuali sulla generazione nazionale, non sul consumo (esclude il saldo import/export).',
      },
      problemi,
    }),
  };
};
