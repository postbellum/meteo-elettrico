const { XMLParser } = require('fast-xml-parser');

const FONTI = {
  B01: 'Biomasse', B02: 'Lignite', B03: 'Gas da carbone', B04: 'Gas',
  B05: 'Carbone', B06: 'Petrolio', B09: 'Geotermico', B10: 'Idro pompaggio',
  B11: 'Idro fluente', B12: 'Idro bacino', B14: 'Nucleare', B15: 'Altro rinnovabile',
  B16: 'Solare', B17: 'Rifiuti', B18: 'Eolico offshore', B19: 'Eolico onshore',
  B20: 'Altro', B25: 'Accumulo',
};

exports.handler = async () => {
  const token = process.env.ENTSOE_TOKEN;
  if (!token) return { statusCode: 500, body: JSON.stringify({ error: 'Token mancante' }) };

  const now = new Date();
  const da = new Date(now - 3 * 3600000);
  const f = (d) => d.toISOString().slice(0, 16).replace(/[-:T]/g, '');

  const url = 'https://web-api.tp.entsoe.eu/api?documentType=A75&processType=A16'
    + '&in_Domain=10YIT-GRTN-----B'
    + `&periodStart=${f(da)}&periodEnd=${f(now)}&securityToken=${token}`;

  try {
    const res = await fetch(url);
    const xml = await res.text();
    if (!res.ok) return { statusCode: 502, body: JSON.stringify({ error: 'ENTSO-E: ' + xml.slice(0, 200) }) };

    const doc = new XMLParser().parse(xml).GL_MarketDocument;
    const serie = Array.isArray(doc?.TimeSeries) ? doc.TimeSeries : [doc?.TimeSeries].filter(Boolean);

    const mw = {};
    for (const ts of serie) {
      if (ts['outBiddingZone_Domain.mRID']) continue;        // è consumo, non produzione
      const tipo = ts.MktPSRType?.psrType;
      const punti = Array.isArray(ts.Period?.Point) ? ts.Period.Point : [ts.Period?.Point].filter(Boolean);
      if (!tipo || !punti.length) continue;
      const v = parseFloat(punti[punti.length - 1].quantity);
      if (!isNaN(v) && v > 0) mw[tipo] = Math.max(mw[tipo] || 0, v);
    }

    const totale = Object.values(mw).reduce((a, b) => a + b, 0);
    if (!totale) return { statusCode: 200, body: JSON.stringify({ error: 'Nessun dato disponibile ora' }) };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Netlify-CDN-Cache-Control': 'public, s-maxage=300' },
      body: JSON.stringify({
        aggiornato: now.toISOString(),
        totaleMw: Math.round(totale),
        fonti: Object.entries(mw)
          .map(([t, v]) => ({ nome: FONTI[t] || t, mw: Math.round(v), pct: +(v / totale * 100).toFixed(1) }))
          .sort((a, b) => b.mw - a.mw),
      }),
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: String(e) }) };
  }
};