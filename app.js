/* ── UTILS: COLOUR ───────────────────────────────────────────────────── */
function h2r(h) {
  h = h.replace('#', '');
  return { r: parseInt(h.substr(0, 2), 16), g: parseInt(h.substr(2, 2), 16), b: parseInt(h.substr(4, 2), 16) };
}
function r2h(o) {
  const t = v => ('0' + Math.round(Math.max(0, Math.min(255, v))).toString(16)).slice(-2);
  return '#' + t(o.r) + t(o.g) + t(o.b);
}
function mix(hex, t, a) {
  const c = h2r(hex);
  return r2h({ r: c.r + (t.r - c.r) * a, g: c.g + (t.g - c.g) * a, b: c.b + (t.b - c.b) * a });
}
const W = { r: 255, g: 255, b: 255 }, K = { r: 0, g: 0, b: 0 };
const lighten = (h, a) => mix(h, W, a);
const darken  = (h, a) => mix(h, K, a);
const mixHex  = (a, b, t) => mix(a, h2r(b), t);

function heatGrad(hex) {
  // Single-hue ramp: light→hue→dark, perceptually smoother stops
  return { 0.1: mix(hex, W, .78), 0.32: mix(hex, W, .45), 0.55: mix(hex, W, .15), 0.78: hex, 1.0: darken(hex, .38) };
}

/* Perceptually-uniform scientific colormaps (matplotlib/CARTO standards).
   Low values stay light/transparent, high values dark & saturated —
   reads naturally on a light basemap and is colorblind-safe (viridis). */
const HEAT_RAMPS = {
  warm:    { 0.10: '#ffffb2', 0.32: '#fed976', 0.55: '#fd8d3c', 0.78: '#e31a1c', 1.0: '#800026' }, // YlOrRd — классика тепла
  cool:    { 0.10: '#e0f3f8', 0.32: '#abd9e9', 0.55: '#41b6c4', 0.78: '#2c7fb8', 1.0: '#253494' }, // Blues — холодная
  viridis: { 0.10: '#fde725', 0.32: '#5ec962', 0.55: '#21918c', 0.78: '#3b528b', 1.0: '#440154' },
  inferno: { 0.10: '#fcffa4', 0.32: '#f98e09', 0.55: '#bc3754', 0.78: '#57106e', 1.0: '#000004' },
  magma:   { 0.10: '#fcfdbf', 0.32: '#fc8961', 0.55: '#b73779', 0.78: '#51127c', 1.0: '#000004' },
  turbo:   { 0.10: '#28bbec', 0.32: '#a4fc3c', 0.55: '#fb7e21', 0.78: '#d23105', 1.0: '#7a0403' },
};
const RAMP_NAMES = {
  custom:  'Свой цвет',
  warm:    'Классика (жёлто-красная)',
  cool:    'Холодная (синяя)',
  viridis: 'Viridis (научная)',
  inferno: 'Inferno',
  magma:   'Magma',
  turbo:   'Turbo (контрастная)',
};
function gradOf(d) {
  return (d.ramp && d.ramp !== 'custom' && HEAT_RAMPS[d.ramp]) ? HEAT_RAMPS[d.ramp] : heatGrad(d.color);
}
function rampColor(t) {
  t = Math.max(0, Math.min(1, t));
  return t < 0.5 ? mixHex(incCol.low, incCol.mid, t / 0.5) : mixHex(incCol.mid, incCol.high, (t - 0.5) / 0.5);
}

/* ── UTILS: GEO ──────────────────────────────────────────────────────── */
function hav(a, b, c, d) {
  const R = 6371000, r = Math.PI / 180,
        dla = (c - a) * r, dlo = (d - b) * r,
        l1 = a * r, l2 = c * r,
        x = Math.sin(dla / 2) ** 2 + Math.cos(l1) * Math.cos(l2) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function fmtD(m) { return m >= 1000 ? (m / 1000).toFixed(1) + ' км' : Math.round(m) + ' м'; }

/* ── DATA SETUP ──────────────────────────────────────────────────────── */
let own = [], ownC = [];
let CITIES = [];
function cityOf(_lat, _lon) { return ''; }

/* ── LAYER STATE ─────────────────────────────────────────────────────── */
const DS = {};
let heatKeys = [];
let heatBoost = 1;
let heatBlend = 'multiply';   // multiply makes overlapping layers mix like ink on a light basemap
let heatRadius = 28;

// UI state
let city = '', covR = 600, topN = 12, recShow = true, recBasis = 'cig', recRefLayerId = '';

/* ── MAP INIT ────────────────────────────────────────────────────────── */
const map = L.map('map', { preferCanvas: true, zoomControl: true, minZoom: 5, zoomSnap: .5 })
              .setView([41, 67], 6);

L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 20,
}).addTo(map);

map.createPane('districts'); map.getPane('districts').style.zIndex = 460;
map.createPane('income');    map.getPane('income').style.zIndex = 445;
map.getPane('income').style.pointerEvents = 'none';

const distRenderer  = L.svg({ pane: 'districts' });
const districtGroup = L.layerGroup().addTo(map);
const coresGroup    = L.layerGroup().addTo(map);
const pointsGroup   = L.layerGroup().addTo(map);
const recLayer      = L.layerGroup().addTo(map);

/* ── INCOME / DISTRICTS ──────────────────────────────────────────────── */
const incCol = { high: '#C0392B', mid: '#F39C12', low: '#1F9E5A' };
let districtsOn = false, incomeHeatOn = false, coresOn = false;
let fieldOverlay = null;

const TIER_NAME = { high: 'High income', mid: 'Middle income', low: 'Lower / emerging' };
const CX = {
  high: 'Premium engagement · KPI: ARPU, retention · формат: flagship / lounge',
  mid:  'Value proposition · KPI: conversion / frequency · формат: retail + акции + bundle',
  low:  'Цена-чувствительный сегмент · KPI: охват / трафик · формат: эконом + промо',
};
const ZONES = [
  { n:  1, tier: 'high', name: 'CBD / Golden core',          lat: 41.3110, lon: 69.2810, pl: 'Сквер Амира Тимура – Ц1 – Ц2 – Broadway' },
  { n:  2, tier: 'high', name: 'Tashkent City cluster',      lat: 41.3165, lon: 69.2685, pl: 'Tashkent City + север Шайхантахура' },
  { n:  3, tier: 'high', name: 'Мирабад premium belt',       lat: 41.2960, lon: 69.2860, pl: 'Айбек – Госпитальный – Mirabad Avenue' },
  { n:  4, tier: 'high', name: 'Яккасарай luxury strip',     lat: 41.2905, lon: 69.2680, pl: 'Руставели – Космонавтов – центр' },
  { n:  5, tier: 'high', name: 'Юнусабад centrified',        lat: 41.3380, lon: 69.2880, pl: 'Шахристан – Minor – Алайский' },
  { n:  6, tier: 'high', name: 'Мирзо-Улугбек elite pockets',lat: 41.3250, lon: 69.3300, pl: 'Ц1 / Ц2 / Карасу-2' },
  { n:  7, tier: 'mid',  name: 'Чиланзар core',              lat: 41.2835, lon: 69.2050, pl: '1–9 кварталы / Новза' },
  { n:  8, tier: 'mid',  name: 'Юнусабад outer',             lat: 41.3640, lon: 69.2930, pl: '6–19 кварталы' },
  { n:  9, tier: 'mid',  name: 'Мирзо-Улугбек mass zone',    lat: 41.3120, lon: 69.3150, pl: 'Хамза / Феруза / Луначарского' },
  { n: 10, tier: 'mid',  name: 'Яшнабад active growth',      lat: 41.2880, lon: 69.3150, pl: 'Кадышева – Авиасозлар' },
  { n: 11, tier: 'mid',  name: 'Алмазар mixed',              lat: 41.3280, lon: 69.2250, pl: 'Сабир Рахимов – Кукча' },
  { n: 12, tier: 'low',  name: 'Сергели (new city)',         lat: 41.2250, lon: 69.2200, pl: 'Сергели 5–8 / Янги Сергели' },
  { n: 13, tier: 'low',  name: 'Янгихаёт (fast-growing)',    lat: 41.2400, lon: 69.2700, pl: 'Спутник / новые массивы' },
  { n: 14, tier: 'low',  name: 'Учтепа',                     lat: 41.2880, lon: 69.1850, pl: 'Фархадский массив' },
  { n: 15, tier: 'low',  name: 'Бектемир / промзона',        lat: 41.2000, lon: 69.3350, pl: 'industrial clusters' },
];

function coreIcon(z) {
  const col = incCol[z.tier];
  return L.divIcon({
    className: '',
    html: `<div class="core-pin" style="background:radial-gradient(circle at 34% 30%,${lighten(col, .35)},${col} 60%,${darken(col, .18)})">${z.n}</div>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  });
}

function renderDistricts() {
  districtGroup.clearLayers();
  if (!districtsOn) return;
  if (typeof DATA === 'undefined' || !DATA.districts) return;
  const tn = { high: 'Высокий доход', mid: 'Средний доход', low: 'Ниже / растущий' };
  (DATA.districts || []).forEach(f => {
    const fill = incCol[f.tier];
    try {
      L.polygon(llswap(f.mp), { renderer: distRenderer, color: darken(fill, .2), weight: 2.2,
                                fillColor: fill, fillOpacity: .16, opacity: .9 })
       .bindTooltip(`<b style="font-weight:700">${f.ru}</b><br>${tn[f.tier]}`, { className: 'tt', sticky: true })
       .addTo(districtGroup);
    } catch (e) { console.warn('District render error:', e); }
  });
}
function llswap(mp) { return mp.map(poly => poly.map(ring => ring.map(c => [c[1], c[0]]))); }

function renderIncome() {
  if (fieldOverlay) { map.removeLayer(fieldOverlay); fieldOverlay = null; }
  coresGroup.clearLayers();
  const f = (typeof DATA !== 'undefined') ? DATA.field : null;
  if (incomeHeatOn && f) {
    const cv  = document.createElement('canvas');
    cv.width  = f.nx; cv.height = f.ny;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(f.nx, f.ny);
    let mn = 1e9, mx = -1e9;
    for (const v of f.grid) { if (v >= 0) { if (v < mn) mn = v; if (v > mx) mx = v; } }
    const rng = Math.max(mx - mn, 1);
    for (let i = 0; i < f.grid.length; i++) {
      const v = f.grid[i], o = i * 4;
      if (v < 0) { img.data[o + 3] = 0; continue; }
      const col = h2r(rampColor((v - mn) / rng));
      img.data[o] = col.r; img.data[o + 1] = col.g; img.data[o + 2] = col.b; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    fieldOverlay = L.imageOverlay(cv.toDataURL(), [[f.s, f.w], [f.n, f.e]],
                                  { opacity: 0.62, interactive: false, pane: 'income' }).addTo(map);
  }
  if (coresOn) {
    ZONES.forEach(z => {
      L.marker([z.lat, z.lon], { icon: coreIcon(z), zIndexOffset: 1800 })
       .bindTooltip(`<b style="font-weight:700">${z.n}. ${z.name}</b><br>${TIER_NAME[z.tier]}`,
                    { className: 'tt', direction: 'top', offset: [0, -12] })
       .bindPopup(`<div class="pp-title">${z.n}. ${z.name}</div>
                   <div class="pp-row"><span>Уровень</span><b>${TIER_NAME[z.tier]}</b></div>
                   <div class="pp-row"><span>Ориентиры</span><b style="font-family:Manrope;font-weight:500;text-align:right">${z.pl}</b></div>
                   <div class="pp-why">${CX[z.tier]}</div>`)
       .addTo(coresGroup);
    });
  }
}

/* ── POINT MARKERS ───────────────────────────────────────────────────── */
const SHAPES = [
  ['teardrop', 'Капля'], ['hex', 'Гексагон'], ['beacon', 'Маяк'], ['shield', 'Щит'],
  ['pin', 'Булавка'], ['circle', 'Круг'], ['square', 'Квадрат'],
  ['diamond', 'Ромб'], ['triangle', 'Треугольник'], ['star', 'Звезда'], ['ring', 'Кольцо'],
];

const pointLayers = [
  { id: 'br', name: 'IQOS — BR',             color: '#3FA9F5', shape: 'teardrop', visible: true, data: [] },
  { id: 'se', name: 'IQOS — IP with 2nd SE', color: '#13B074', shape: 'hex',      visible: true, data: [] },
];

function starPath(h, s) {
  let p = '';
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? s * 0.16 : s * 0.36, a = -Math.PI / 2 + i * Math.PI / 5;
    p += (i ? ' L' : 'M') + (h + r * Math.cos(a)).toFixed(1) + ' ' + (h + r * Math.sin(a)).toFixed(1);
  }
  return p + ' Z';
}

function shp(shape, color, s) {
  const h = s / 2, sw = Math.max(2, s * 0.085), gid = 'g' + color.replace('#', '') + shape;
  const defs = `<defs><radialGradient id="${gid}" cx="36%" cy="30%">
    <stop offset="0%"   stop-color="${lighten(color, .5)}"/>
    <stop offset="62%"  stop-color="${color}"/>
    <stop offset="100%" stop-color="${darken(color, .14)}"/>
  </radialGradient></defs>`;
  const st = `stroke="#fff" stroke-width="${sw}" stroke-linejoin="round"`;
  const f  = `fill="url(#${gid})"`;
  let body, anchor = [h, h];
  switch (shape) {
    case 'square':
      body = `<rect x="${s*.2}" y="${s*.2}" width="${s*.6}" height="${s*.6}" rx="${s*.15}" ${f} ${st}/>`;
      break;
    case 'diamond':
      body = `<rect x="${s*.24}" y="${s*.24}" width="${s*.52}" height="${s*.52}" rx="${s*.1}" transform="rotate(45 ${h} ${h})" ${f} ${st}/>`;
      break;
    case 'triangle':
      body = `<polygon points="${h},${s*.18} ${s*.84},${s*.8} ${s*.16},${s*.8}" ${f} ${st}/>`;
      break;
    case 'star':
      body = `<path d="${starPath(h, s)}" ${f} ${st}/>`;
      break;
    case 'ring':
      body = `<circle cx="${h}" cy="${h}" r="${s*.3}" fill="none" stroke="${color}" stroke-width="${s*.17}"/>
              <circle cx="${h}" cy="${h}" r="${s*.38}" fill="none" stroke="#fff" stroke-width="${s*.05}"/>`;
      break;
    case 'pin':
      body   = `<path d="M ${h} ${s*.94} C ${s*.16} ${s*.56},${s*.18} ${s*.14},${h} ${s*.14} C ${s*.82} ${s*.14},${s*.84} ${s*.56},${h} ${s*.94} Z" ${f} ${st}/><circle cx="${h}" cy="${s*.38}" r="${s*.12}" fill="#fff" opacity=".92"/>`;
      anchor = [h, s * .94];
      break;
    case 'teardrop':
      body   = `<path d="M ${h} ${s*.95} C ${s*.18} ${s*.6},${s*.2} ${s*.1},${h} ${s*.1} C ${s*.8} ${s*.1},${s*.82} ${s*.6},${h} ${s*.95} Z" ${f} ${st}/><circle cx="${h}" cy="${s*.39}" r="${s*.135}" fill="#fff"/>`;
      anchor = [h, s * .95];
      break;
    case 'hex': {
      const hp = [];
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 3;
        hp.push((h + s * .37 * Math.cos(a)).toFixed(1) + ',' + (h + s * .37 * Math.sin(a)).toFixed(1));
      }
      body = `<polygon points="${hp.join(' ')}" ${f} ${st}/><circle cx="${h}" cy="${h}" r="${s*.13}" fill="#fff" opacity=".92"/>`;
      break;
    }
    case 'shield':
      body   = `<path d="M ${h} ${s*.14} L ${s*.79} ${s*.27} L ${s*.79} ${s*.54} C ${s*.79} ${s*.75},${h} ${s*.88},${h} ${s*.88} C ${h} ${s*.88},${s*.21} ${s*.75},${s*.21} ${s*.54} L ${s*.21} ${s*.27} Z" ${f} ${st}/><circle cx="${h}" cy="${s*.46}" r="${s*.1}" fill="#fff" opacity=".9"/>`;
      anchor = [h, s * .88];
      break;
    case 'beacon':
      body = `<circle cx="${h}" cy="${h}" r="${s*.35}" ${f} ${st}/><circle cx="${h}" cy="${h}" r="${s*.145}" fill="#fff"/>`;
      break;
    default:
      body = `<circle cx="${h}" cy="${h}" r="${s*.32}" ${f} ${st}/><circle cx="${h*.82}" cy="${h*.78}" r="${s*.08}" fill="#fff" opacity=".5"/>`;
  }
  return { html: `<svg class="pt-pin" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">${defs}${body}</svg>`, anchor };
}

function renderPoints() {
  pointsGroup.clearLayers();
  pointLayers.forEach(L0 => {
    if (!L0.visible) return;
    const ic = shp(L0.shape, L0.color, 32);
    L0.data.filter(o => !city || o.cityRu === city).forEach(o => {
      L.marker([o.lat, o.lon], {
        icon: L.divIcon({ className: '', html: ic.html, iconSize: [32, 32], iconAnchor: ic.anchor }),
        zIndexOffset: 1500,
      })
      .bindTooltip(`<b style="font-weight:700">${o.name}</b><br>${L0.name}`,
                   { className: 'tt', direction: 'top', offset: [0, -ic.anchor[1] + 4] })
      .bindPopup(`<div class="pp-title">${o.name}</div>
                  <div class="pp-row"><span>Канал</span><b>${o.ch}</b></div>
                  <div class="pp-row"><span>Город</span><b>${o.cityRu}</b></div>
                  ${o.addr  ? `<div class="pp-row"><span>Адрес</span><b style="font-family:Manrope;font-weight:500;text-align:right">${o.addr}</b></div>` : ''}
                  ${o.hours ? `<div class="pp-row"><span>Часы</span><b>${o.hours}</b></div>` : ''}
                  <span class="pp-tag" style="background:rgba(136,169,209,.14);color:#bcd6ef;border:1px solid rgba(136,169,209,.35)">ТОЧКА IQOS</span>`)
      .addTo(pointsGroup);
    });
  });
}

/* ── HEAT LAYERS ─────────────────────────────────────────────────────── */
function applyHeatCanvas(d) {
  const canvas = d._leaf && d._leaf._canvas;
  if (!canvas) return;
  canvas.style.mixBlendMode = heatBlend === 'normal' ? '' : heatBlend;
  canvas.style.filter  = heatBoost === 1 ? '' : `brightness(${heatBoost}) saturate(${Math.max(heatBoost * .8 + .2, 0)})`;
  const op = (d.opacity == null ? 1 : d.opacity) * (heatBoost < 1 ? heatBoost : 1);
  canvas.style.opacity = op >= 1 ? '' : String(op);
}
function restyleHeatCanvases() {
  heatKeys.forEach(k => { const d = DS[k]; if (d) applyHeatCanvas(d); });
}

function renderHeat() {
  let total = 0;
  heatKeys.forEach(k => {
    const d = DS[k];
    if (!d) return;
    if (d._leaf) { map.removeLayer(d._leaf); d._leaf = null; }
    if (!d.visible) return;
    const recs  = d.recs.filter(r => !city || r.fil === city);
    const scale = Math.max(d.stats.p90, 0.01);
    const pts   = recs.map(r => [r.lat, r.lon, Math.min(r.vol / scale, 1)]);
    total += recs.length;
    d._leaf = L.heatLayer(pts, {
      radius: heatRadius, blur: Math.round(heatRadius * .8), minOpacity: .22,
      max: 1 / (d.intensity || 1),
      gradient: gradOf(d),
    }).addTo(map);
    // canvas may not exist until next frame
    requestAnimationFrame(() => applyHeatCanvas(d));
  });
  document.getElementById('b-count').textContent = total.toLocaleString('ru-RU');
}

/* ── RECOMMENDATIONS ─────────────────────────────────────────────────── */
const SUPPRESS = 1100;
const PREVIEW  = 3;
let lastRecs = [], lastBasisName = '';

function mkRecItem(s, idx) {
  const x = document.createElement('div');
  x.className = 'rec-item';
  x.innerHTML = `
    <div class="rec-rank">${idx}</div>
    <div class="rec-main">
      <b>${s.name}</b>
      <div class="meta"><span class="hi">спрос ${Math.round(s.ld)}</span> · ${s.lc} тч · ${s.fil} · ${fmtD(s.nd)}</div>
    </div>
    <div class="rec-demand">
      <div class="dv">${Math.round(s.ld)}</div>
      <div class="dl">ед/км²</div>
    </div>`;
  x.addEventListener('click', () => {
    map.flyTo([s.lat, s.lon], 15, { duration: .8 });
    setTimeout(() => openRec(s, idx), 700);
  });
  return x;
}

function openRec(s, rank) {
  const d = DS[recBasis];
  if (!d) return;
  L.popup({ maxWidth: 260 })
   .setLatLng([s.lat, s.lon])
   .setContent(`
     <div class="pp-title">Зона #${rank} — кандидат на ТТ BR</div>
     <div class="pp-row"><span>Основа</span><b>${d.name}</b></div>
     <div class="pp-row"><span>Город</span><b>${s.fil}</b></div>
     <div class="pp-row"><span>Спрос рядом</span><b>${Math.round(s.ld)} ед.</b></div>
     <div class="pp-row"><span>Точек рынка в зоне</span><b>${s.lc}</b></div>
     <div class="pp-row"><span>До ближайшей ТТ</span><b>${fmtD(s.nd)}</b></div>
     <div class="pp-why">Высокий спрос (${d.name.toLowerCase()}) в радиусе ~700 м без нашей ТТ ближе ${fmtD(covR)}. Ориентир — «${s.name}». Рекомендуется открытие BR.</div>
     <span class="pp-tag" style="background:#10362a;color:#7fe3b4;border:1px solid #1c5a44">РЕКОМЕНДАЦИЯ BR</span>`)
   .openOn(map);
}

function renderRecs() {
  recLayer.clearLayers();
  const d = DS[recBasis];
  if (!d) return;
  lastBasisName = d.name;

  // Recompute nd from reference layer on every call
  const refPts = getRefPts();
  if (refPts.length) {
    for (const s of d.recs) {
      let best = 1e18;
      for (const [a, b] of refPts) { const dd = hav(s.lat, s.lon, a, b); if (dd < best) best = dd; }
      s.nd = Math.round(best);
    }
  }

  // Compute candidates
  const cand = d.recs
    .filter(s => (!city || s.fil === city) && (!refPts.length || s.nd > covR))
    .sort((a, b) => b.ld - a.ld || b.vol - a.vol);

  // Greedy suppression O(n log n) via Set
  const recs = [], used = new Set();
  for (const s of cand) {
    if (used.has(s)) continue;
    recs.push(s);
    for (const o of cand) {
      if (!used.has(o) && hav(s.lat, s.lon, o.lat, o.lon) <= SUPPRESS) used.add(o);
    }
    if (recs.length >= topN) break;
  }
  lastRecs = recs;

  // Summary
  const uncSum    = cand.reduce((a, s) => a + s.vol, 0);
  const cityTotal = d.recs.filter(s => !city || s.fil === city).reduce((a, s) => a + s.vol, 0) || 1;
  document.getElementById('rec-count').textContent = recs.length;
  document.getElementById('rec-lbl').innerHTML =
    `зон для новой <b>BR</b> · основа: <b>${d.name.toLowerCase()}</b> · вне покрытия <b>${Math.round(uncSum).toLocaleString('ru-RU')}</b> ед. (<b>${Math.round(uncSum / cityTotal * 100)}%</b>)`;

  // Render list
  const el = document.getElementById('rec-list');
  el.innerHTML = '';

  const preview = document.createElement('div');
  preview.className = 'rec-preview';
  recs.slice(0, PREVIEW).forEach((s, i) => preview.appendChild(mkRecItem(s, i + 1)));
  el.appendChild(preview);

  const tog = document.getElementById('rec-toggle');
  if (recs.length > PREVIEW) {
    const wrap  = document.createElement('div');
    const inner = document.createElement('div');
    wrap.className  = 'rec-expand-wrap';
    inner.className = 'rec-expand-inner';
    recs.slice(PREVIEW).forEach((s, i) => inner.appendChild(mkRecItem(s, i + PREVIEW + 1)));
    wrap.appendChild(inner);
    el.appendChild(wrap);

    const rest = recs.length - PREVIEW;
    const plural = n => n === 1 ? 'зону' : n < 5 ? 'зоны' : 'зон';
    tog.style.display = '';
    tog.className = 'rec-toggle';
    tog.innerHTML = `<span>Показать ещё ${rest} ${plural(rest)}</span><span class="arrow">▼</span>`;
    tog.onclick = () => {
      const open = wrap.classList.toggle('open');
      tog.className = 'rec-toggle' + (open ? ' open' : '');
      tog.innerHTML  = open
        ? `<span>Скрыть</span><span class="arrow">▼</span>`
        : `<span>Показать ещё ${rest} ${plural(rest)}</span><span class="arrow">▼</span>`;
    };
  } else {
    tog.style.display = 'none';
  }

  // Map pins
  if (!recShow) return;
  recs.forEach((s, i) => {
    const m = L.marker([s.lat, s.lon], {
      icon: L.divIcon({
        className: '',
        html: `<div class="rec-pin"><div class="ring"></div><div class="core"></div><span>${i + 1}</span></div>`,
        iconSize: [30, 30], iconAnchor: [15, 15],
      }),
      zIndexOffset: 2000,
    });
    m.bindTooltip(
      `<b style="font-weight:700">Зона #${i + 1} · ${s.fil}</b><br>спрос ${Math.round(s.ld)} (${d.name.toLowerCase()})`,
      { className: 'tt', direction: 'top', offset: [0, -14] }
    );
    m.on('click', () => openRec(s, i + 1));
    recLayer.addLayer(m);
  });
}

/* ── UI BUILDERS ─────────────────────────────────────────────────────── */
function buildHeatUI() {
  const el = document.getElementById('heat-list');
  el.innerHTML = '';
  buildRecBasisUI();
  rebuildRefLayerSelect();
  heatKeys.forEach(k => {
    const d = DS[k];
    if (!d) return;
    const custom = k.startsWith('custom_');
    const card   = document.createElement('div');
    card.className = 'lyr';
    card.innerHTML = `
      <div class="lyr-top">
        <div class="cbx${d.visible ? ' on' : ''}"></div>
        <div class="nm">${d.name}
          <small>${d.stats.n.toLocaleString('ru-RU')} точек · объём ${Math.round(d.stats.sum).toLocaleString('ru-RU')}</small>
        </div>
        ${custom ? `<div class="lyr-del" title="Удалить слой" style="cursor:pointer;color:var(--dim);font-size:18px;line-height:1;padding:0 4px;transition:.15s">&times;</div>` : ''}
      </div>
      <div class="lyr-ctl">
        <div class="grp" style="flex:1">Палитра
          <select class="ramp-sel" style="flex:1">${Object.keys(RAMP_NAMES).map(r =>
            `<option value="${r}"${(d.ramp || 'custom') === r ? ' selected' : ''}>${RAMP_NAMES[r]}</option>`).join('')}</select>
          <input type="color" value="${d.color}" style="display:${(d.ramp || 'custom') === 'custom' ? '' : 'none'}">
        </div>
      </div>
      <div class="ramp-preview"></div>
      <div class="lyr-ctl">
        <div class="grp" style="flex:1">Интенс. <input type="range" class="r-int" min="0.4" max="3" step="0.1" value="${d.intensity}" style="flex:1"></div>
        <div class="grp" style="flex:1">Прозр. <input type="range" class="r-op" min="0.15" max="1" step="0.05" value="${d.opacity == null ? 1 : d.opacity}" style="flex:1"></div>
      </div>`;

    const colorInp = card.querySelector('input[type=color]');
    const rampSel  = card.querySelector('.ramp-sel');
    const preview  = card.querySelector('.ramp-preview');
    const drawPreview = () => {
      const g = gradOf(d);
      const stops = Object.keys(g).map(Number).sort((a, b) => a - b)
        .map(s => `${g[s]} ${Math.round(s * 100)}%`).join(', ');
      preview.style.background = `linear-gradient(90deg, transparent 0%, ${stops})`;
    };
    drawPreview();

    card.querySelector('.cbx').addEventListener('click', e => {
      d.visible = !d.visible; e.target.classList.toggle('on', d.visible); renderHeat();
    });
    rampSel.addEventListener('change', e => {
      d.ramp = e.target.value;
      colorInp.style.display = d.ramp === 'custom' ? '' : 'none';
      drawPreview(); renderHeat();
    });
    colorInp.addEventListener('input', e => { d.color = e.target.value; drawPreview(); renderHeat(); });
    card.querySelector('.r-int').addEventListener('input', e => { d.intensity = +e.target.value; renderHeat(); });
    card.querySelector('.r-op').addEventListener('input', e => {
      d.opacity = +e.target.value; applyHeatCanvas(d); // fast path, no re-render
    });

    if (custom) {
      const del = card.querySelector('.lyr-del');
      del.addEventListener('mouseenter', () => del.style.color = '#e05454');
      del.addEventListener('mouseleave', () => del.style.color = 'var(--dim)');
      del.addEventListener('click', () => {
        if (d._leaf) { map.removeLayer(d._leaf); d._leaf = null; }
        delete DS[k];
        heatKeys = heatKeys.filter(x => x !== k);
        buildHeatUI(); rebuildUpTarget(); renderHeat(); renderRecs(); checkEmptyState();
      });
    }
    el.appendChild(card);
  });
}

function buildPtUI() {
  const el = document.getElementById('pt-list');
  el.innerHTML = '';
  pointLayers.forEach(L0 => {
    const card = document.createElement('div');
    card.className = 'lyr';
    const opts = SHAPES.map(s => `<option value="${s[0]}"${s[0] === L0.shape ? ' selected' : ''}>${s[1]}</option>`).join('');
    card.innerHTML = `
      <div class="lyr-top">
        <div class="cbx${L0.visible ? ' on' : ''}"></div>
        <div class="nm">${L0.name}</div>
      </div>
      <div class="lyr-ctl">
        <div class="grp">Цвет <input type="color" value="${L0.color}"></div>
        <div class="grp">Иконка <select>${opts}</select></div>
      </div>`;
    card.querySelector('.cbx').addEventListener('click', e => { L0.visible = !L0.visible; e.target.classList.toggle('on', L0.visible); renderPoints(); });
    card.querySelector('input[type=color]').addEventListener('input', e => { L0.color = e.target.value; renderPoints(); });
    card.querySelector('select').addEventListener('change', e => { L0.shape = e.target.value; renderPoints(); });
    el.appendChild(card);
  });
}

function buildCityUI() {
  const el = document.getElementById('seg-city');
  el.innerHTML = '';
  const secEl = el.closest('.sec') || el.previousElementSibling;

  // Collect cities from all heat layer recs
  const cities = [...new Set(
    heatKeys.flatMap(k => (DS[k] && DS[k].recs || []).map(r => r.fil).filter(Boolean))
  )].sort();
  CITIES.length = 0; cities.forEach(c => CITIES.push(c));

  // Hide city section if no data
  const citySection = document.querySelector('.sec[data-sec="city"]');
  if (citySection) citySection.style.display = cities.length ? '' : 'none';
  if (!cities.length) return;

  const mk = (val, lab, on) => {
    const b = document.createElement('button');
    b.dataset.city = val; b.textContent = lab;
    if (on) b.classList.add('on');
    b.addEventListener('click', () => {
      el.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      city = val;
      renderHeat(); renderPoints(); renderRecs();
      const pts = heatKeys.flatMap(k => (DS[k] && DS[k].recs || []).filter(s => !city || s.fil === city).map(s => [s.lat, s.lon]));
      if (pts.length) map.flyToBounds(L.latLngBounds(pts).pad(.12), { duration: .7 });
    });
    el.appendChild(b);
  };
  mk('', 'Все', !city);
  cities.forEach(c => mk(c, c, city === c));
}

function buildRecBasisUI() {
  const el = document.getElementById('rec-basis');
  if (!el) return;
  el.innerHTML = '';
  heatKeys.forEach(k => {
    const d = DS[k]; if (!d) return;
    const b = document.createElement('button');
    b.dataset.b = k; b.textContent = d.name;
    if (recBasis === k) b.classList.add('on');
    b.addEventListener('click', () => {
      el.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on'); recBasis = k; renderRecs();
    });
    el.appendChild(b);
  });
  // Set recBasis to first key if current is invalid
  if (!heatKeys.includes(recBasis) && heatKeys.length) recBasis = heatKeys[0];
}

function rebuildRefLayerSelect() {
  const sel = document.getElementById('rec-ref-layer');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— без ориентира —</option>';
  heatKeys.forEach(k => {
    const d = DS[k]; if (!d) return;
    const o = document.createElement('option');
    o.value = k; o.textContent = d.name;
    if (k === recRefLayerId) o.selected = true;
    sel.appendChild(o);
  });
  if (!sel.value) sel.value = cur && heatKeys.includes(cur) ? cur : '';
}

function rebuildUpTarget() {
  const sel = document.getElementById('up-target');
  const cur = sel.value;
  sel.innerHTML = heatKeys.map(k => `<option value="${k}">${DS[k] ? DS[k].name : k}</option>`).join('');
  if (heatKeys.includes(cur)) sel.value = cur;
}

/* ── TOAST NOTIFICATIONS ─────────────────────────────────────────────── */
function toast(msg, type = 'info', ms = 2800) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    t.addEventListener('animationend', () => t.remove(), { once: true });
  }, ms);
}

/* ── CREATE LAYER MODAL ──────────────────────────────────────────────── */
const LAYER_PALETTE = ['#9B59B6', '#E67E22', '#1ABC9C', '#E84393', '#F1C40F', '#16A085'];

function openLayerModal() {
  const overlay = document.getElementById('layer-modal-overlay');
  const input   = document.getElementById('layer-modal-input');
  input.value = '';
  overlay.classList.add('open');
  setTimeout(() => input.focus(), 150);
}
function closeLayerModal() {
  document.getElementById('layer-modal-overlay').classList.remove('open');
}
function confirmLayerModal() {
  const name = document.getElementById('layer-modal-input').value.trim();
  closeLayerModal();
  if (!name) return;
  const key   = 'custom_' + Date.now();
  const color = LAYER_PALETTE[(heatKeys.length - 2) % LAYER_PALETTE.length];
  DS[key] = { key, name, color, ramp: 'custom', opacity: 1, intensity: 1, visible: true, recs: [], stats: { n: 0, sum: 0, max: 0, p50: 0, p90: 0.01 } };
  heatKeys.push(key);
  buildHeatUI(); rebuildUpTarget(); renderHeat(); checkEmptyState();
  document.getElementById('up-target').value = key;
  // Highlight upload area
  const fb = document.getElementById('filebox');
  fb.style.borderColor = 'var(--acc)';
  setTimeout(() => fb.style.borderColor = '', 1400);
  toast(`Слой «${name}» создан — загрузите данные ниже`, 'ok');
}

/* ── DATA UPLOAD ─────────────────────────────────────────────────────── */
function pick(o, keys) {
  for (const k in o) {
    const lk = ('' + k).toLowerCase().trim();
    for (const w of keys) if (lk === w || lk.includes(w)) return o[k];
  }
  return undefined;
}

function toRecs(rows) {
  const out = [];
  for (const r of rows) {
    const la = parseFloat(('' + pick(r, ['lat', 'широт'])).replace(',', '.'));
    const lo = parseFloat(('' + pick(r, ['lon', 'lng', 'долгот'])).replace(',', '.'));
    let v = pick(r, ['value', 'объ', 'vol', 'amount', 'итог']);
    v = parseFloat(('' + (v == null ? 1 : v)).replace(',', '.'));
    if (!isFinite(v) || v <= 0) v = 1;
    const nm = pick(r, ['name', 'назв', 'точк']) || '';
    const filVal = pick(r, ['fil', 'city', 'город', 'регион']) || cityOf(la, lo);
    if (isFinite(la) && isFinite(lo)) out.push({ name: '' + nm, fil: '' + (filVal || ''), lat: la, lon: lo, vol: v });
  }
  return out;
}

function getRefPts() {
  if (!recRefLayerId || !DS[recRefLayerId]) return [];
  return (DS[recRefLayerId].recs || []).map(r => [r.lat, r.lon]);
}

function enrich(recs) {
  const refPts = getRefPts();
  for (const s of recs) {
    if (!refPts.length) { s.nd = 1e9; continue; }
    let best = 1e18;
    for (const [a, b] of refPts) { const d = hav(s.lat, s.lon, a, b); if (d < best) best = d; }
    s.nd = Math.round(best);
  }
  const grid = {};
  recs.forEach((s, i) => {
    const k = Math.round(s.lat * 100) + '_' + Math.round(s.lon * 100);
    (grid[k] = grid[k] || []).push(i);
  });
  for (const s of recs) {
    let ld = 0, lc = 0;
    const kla = Math.round(s.lat * 100), klo = Math.round(s.lon * 100);
    for (let dla = -1; dla <= 1; dla++) {
      for (let dlo = -1; dlo <= 1; dlo++) {
        const arr = grid[(kla + dla) + '_' + (klo + dlo)];
        if (!arr) continue;
        for (const j of arr) {
          const t = recs[j];
          if (hav(s.lat, s.lon, t.lat, t.lon) <= 700) { ld += t.vol; lc++; }
        }
      }
    }
    s.ld = Math.round(ld * 100) / 100;
    s.lc = lc;
  }
  return recs;
}

function statsOf(recs) {
  const v = recs.map(r => r.vol).sort((a, b) => a - b), n = v.length;
  return { n, sum: Math.round(v.reduce((a, b) => a + b, 0) * 10) / 10, max: v[n - 1] || 0, p50: v[Math.floor(n * 0.5)] || 0, p90: v[Math.floor(n * 0.9)] || 0.01 };
}

/* ── SHARE STATE (export / import JSON) ──────────────────────────────── */
function buildStateSnapshot() {
  const layers = {};
  heatKeys.forEach(k => {
    const d = DS[k]; if (!d) return;
    const o = { name: d.name, color: d.color, ramp: d.ramp, opacity: d.opacity, intensity: d.intensity, visible: d.visible };
    o.recs = d.recs || []; o.stats = d.stats || { n: 0, sum: 0, max: 0, p50: 0, p90: 0.01 }; o._userData = true;
    layers[k] = o;
  });
  const pts = {};
  pointLayers.forEach(p => pts[p.id] = { color: p.color, shape: p.shape, visible: p.visible });
  return {
    _v: 1, _app: 'hm-br', _date: new Date().toISOString().slice(0, 10),
    heatKeys, layers, pts, incCol: { ...incCol },
    city, covR, topN, recBasis, recShow, recRefLayerId, heatBoost, heatBlend, heatRadius, districtsOn, incomeHeatOn, coresOn,
  };
}

function exportState() {
  const snap = buildStateSnapshot();
  const json = JSON.stringify(snap, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = 'heatmap_settings_' + snap._date + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Настройки сохранены в файл', 'ok');
}

function importState(file) {
  const rd = new FileReader();
  rd.onload = e => {
    let st;
    try { st = JSON.parse(e.target.result); } catch (_) { toast('Файл повреждён или неверный формат', 'err'); return; }
    if (st._app !== 'hm-br') { toast('Это не файл настроек Heat Map', 'err'); return; }
    // Apply — reuse loadState logic
    applySnapshot(st);
    buildCityUI(); buildHeatUI(); buildPtUI(); rebuildUpTarget(); syncControls();
    renderHeat(); renderPoints(); renderRecs(); renderDistricts(); renderIncome();
    doSave(); // persist locally too
    toast('Настройки загружены', 'ok');
  };
  rd.readAsText(file);
}

function applySnapshot(st) {
  if (Array.isArray(st.heatKeys)) heatKeys = st.heatKeys.slice();
  if (st.layers) {
    for (const k of heatKeys) {
      const sv = st.layers[k]; if (!sv) continue;
      if (!DS[k]) DS[k] = { key: k };
      Object.assign(DS[k], { name: sv.name, color: sv.color, intensity: sv.intensity, visible: sv.visible });
      if (typeof sv.ramp    === 'string') DS[k].ramp    = sv.ramp;
      if (typeof sv.opacity === 'number') DS[k].opacity = sv.opacity;
      if (sv.recs) { DS[k].recs = sv.recs; DS[k].stats = sv.stats || statsOf(sv.recs); DS[k]._userData = true; }
      else if (!DS[k].recs) { DS[k].recs = []; DS[k].stats = { n: 0, sum: 0, max: 0, p50: 0, p90: 0.01 }; }
    }
  }
  if (st.pts)              pointLayers.forEach(p => { const sv = st.pts[p.id]; if (sv) Object.assign(p, sv); });
  if (st.incCol)           Object.assign(incCol, st.incCol);
  if (typeof st.city       === 'string')  city         = st.city;
  if (typeof st.covR       === 'number')  covR         = st.covR;
  if (typeof st.topN       === 'number')  topN         = st.topN;
  if (typeof st.recBasis   === 'string' && DS[st.recBasis]) recBasis = st.recBasis;
  if (typeof st.recRefLayerId === 'string') recRefLayerId = st.recRefLayerId;
  if (typeof st.recShow    === 'boolean') recShow      = st.recShow;
  if (typeof st.heatBoost  === 'number')  heatBoost    = st.heatBoost;
  if (typeof st.heatBlend  === 'string')  heatBlend    = st.heatBlend;
  if (typeof st.heatRadius === 'number')  heatRadius   = st.heatRadius;
  if (typeof st.districtsOn  === 'boolean') districtsOn  = st.districtsOn;
  if (typeof st.incomeHeatOn === 'boolean') incomeHeatOn = st.incomeHeatOn;
  if (typeof st.coresOn      === 'boolean') coresOn      = st.coresOn;
}

/* ── EXPORT RECS ─────────────────────────────────────────────────────── */
function exportRecs() {
  if (!lastRecs.length) { toast('Нет рекомендаций для экспорта', 'err'); return; }
  const header = ['Ранг', 'Название зоны', 'Город', 'Широта', 'Долгота', 'Спрос (ед/км²)', 'Точек рядом', 'Объём', 'До ближайшей ТТ, м'];
  const rows   = [header];
  lastRecs.forEach((s, i) => rows.push([
    i + 1, s.name || ('Зона ' + (i + 1)), s.fil || '',
    +s.lat.toFixed(6), +s.lon.toFixed(6),
    Math.round(s.ld), s.lc, Math.round(s.vol * 100) / 100, s.nd,
  ]));
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 6 }, { wch: 30 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 15 }, { wch: 12 }, { wch: 10 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Рекомендации BR');
  XLSX.writeFile(wb, 'rekomendacii_BR_' + lastBasisName.toLowerCase() + '_' + new Date().toISOString().slice(0, 10) + '.xlsx');
  toast('Файл скачан', 'ok');
}

/* ── RETRAFFIC FILTERED EXPORT ───────────────────────────────────────── */
function exportRetraffic() {
  // Find Re-traffic layer (any key whose name matches)
  const rtKey = heatKeys.find(k => {
    const n = (DS[k] && DS[k].name) || '';
    return /re.?traffic/i.test(n) || /ретрафик/i.test(n);
  });

  const rtRecs = (rtKey && DS[rtKey] && DS[rtKey].recs) ? DS[rtKey].recs : [];

  // Build combined vol per point (cig + sticks), keyed by code
  const byCode = {};
  const addLayer = (key, field) => {
    const d = DS[key];
    if (!d || !d.recs) return;
    d.recs.forEach(r => {
      const c = r.code || (r.lat + '|' + r.lon);
      if (!byCode[c]) byCode[c] = { ...r, vol_cig: 0, vol_sticks: 0 };
      byCode[c][field] = (byCode[c][field] || 0) + (r.vol || 0);
    });
  };
  addLayer('cig',    'vol_cig');
  addLayer('sticks', 'vol_sticks');

  // Filter by city if active
  let points = Object.values(byCode);
  if (city) points = points.filter(p => p.fil === city);

  // Compute combined volume
  points.forEach(p => { p.vol_total = (p.vol_cig || 0) + (p.vol_sticks || 0); });

  // Average volume threshold
  const avg = points.reduce((s, p) => s + p.vol_total, 0) / (points.length || 1);

  // Filter: volume >= average
  points = points.filter(p => p.vol_total >= avg);

  // Filter: within 1 km of any BR/IQOS own point
  const ownFiltered = city ? own.filter(o => o.cityRu === city) : own;
  points = points.filter(p =>
    ownFiltered.some(o => hav(p.lat, p.lon, o.lat, o.lon) <= 1000)
  );

  if (!points.length) { toast('Нет точек по заданным критериям', 'err'); return; }

  // Exclude points present in Re-traffic layer (proximity < 150 m or code match)
  const isRetraffic = (p) => {
    if (!rtRecs.length) return false;
    return rtRecs.some(r => {
      if (r.code && p.code && r.code === p.code) return true;
      return hav(p.lat, p.lon, r.lat, r.lon) < 150;
    });
  };
  const excluded = points.filter(isRetraffic).length;
  points = points.filter(p => !isRetraffic(p));

  if (!points.length) { toast('После исключения Re-traffic точек не осталось', 'err'); return; }

  // Sort by combined volume descending
  points.sort((a, b) => b.vol_total - a.vol_total);

  // Find nearest own point distance for each
  points.forEach(p => {
    let minD = Infinity;
    ownFiltered.forEach(o => { const d = hav(p.lat, p.lon, o.lat, o.lon); if (d < minD) minD = d; });
    p._distOwn = Math.round(minD);
  });

  // Build Excel
  const header = [
    '№', 'Название точки', 'Город', 'Адрес',
    'Широта', 'Долгота',
    'Объём сигареты', 'Объём стики', 'Объём итого',
    'До ближ. BR/IQOS, м', 'Код'
  ];
  const rows = [header];
  points.forEach((p, i) => rows.push([
    i + 1,
    p.name || '',
    p.fil  || '',
    p.addr || '',
    +p.lat.toFixed(6),
    +p.lon.toFixed(6),
    Math.round((p.vol_cig    || 0) * 100) / 100,
    Math.round((p.vol_sticks || 0) * 100) / 100,
    Math.round(p.vol_total   * 100) / 100,
    p._distOwn,
    p.code || '',
  ]));

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [
    { wch: 4 }, { wch: 38 }, { wch: 12 }, { wch: 36 },
    { wch: 12 }, { wch: 12 },
    { wch: 16 }, { wch: 14 }, { wch: 14 },
    { wch: 20 }, { wch: 10 },
  ];

  // Info sheet
  const infoData = [
    ['Параметры фильтра'],
    ['Радиус от BR/IQOS', '≤ 1000 м'],
    ['Объём', `≥ среднего (${avg.toFixed(2)} ед.)`],
    ['Re-traffic', rtRecs.length ? `исключено ${excluded} точек (слой «${DS[rtKey].name}»)` : 'слой не загружен — фильтр не применялся'],
    ['Город', city || 'все'],
    ['Дата выгрузки', new Date().toLocaleDateString('ru')],
    [],
    ['Итого точек в файле', points.length],
  ];
  const wsInfo = XLSX.utils.aoa_to_sheet(infoData);
  wsInfo['!cols'] = [{ wch: 28 }, { wch: 42 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Адреса без Re-traffic');
  XLSX.utils.book_append_sheet(wb, wsInfo, 'Параметры');

  const fname = 'BR_bez_retraffic_' + new Date().toISOString().slice(0, 10) + '.xlsx';
  XLSX.writeFile(wb, fname);
  toast(`Скачано ${points.length} точек (исключено Re-traffic: ${excluded})`, 'ok');
}

/* ── PERSISTENCE ─────────────────────────────────────────────────────── */
let currentProjectId = null;
let currentUserInfo  = null;
let currentVersion   = 0;

const getStoreKey = () => currentProjectId ? 'hm_state_' + currentProjectId : 'hm_state_local';

let stateReady = false, _saveTimer = null;

function setSyncBadge(state, label) {
  const badge = document.getElementById('sync-badge');
  const lbl   = document.getElementById('sync-label');
  if (!badge) return;
  badge.style.display = '';
  badge.className = 'sync-badge ' + state;
  lbl.textContent = label;
}

async function pushToServer(snapshot) {
  if (!currentProjectId) return;
  snapshot._version = currentVersion;
  setSyncBadge('syncing', 'Сохранение…');
  try {
    const res = await fetch(`/api/projects/${currentProjectId}/state`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
    });
    if (res.status === 409) {
      setSyncBadge('err', 'Конфликт — карта изменилась');
      toast('Карта обновилась на сервере — перезагрузите проект', 'err', 5000);
    } else if (!res.ok) {
      setSyncBadge('err', 'Ошибка сохранения');
    } else {
      const data = await res.json();
      currentVersion = data.version || currentVersion;
      const now = new Date().toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
      setSyncBadge('ok', 'Сохранено ' + now);
    }
  } catch (e) {
    setSyncBadge('err', 'Сервер недоступен');
  }
}

async function fetchFromServer() {
  if (!currentProjectId) return null;
  setSyncBadge('syncing', 'Загрузка…');
  try {
    const res = await fetch(`/api/projects/${currentProjectId}/state`, { credentials: 'include' });
    if (!res.ok) { setSyncBadge('err', 'Ошибка загрузки'); return null; }
    const data = await res.json();
    if (!data || data._app !== 'hm-br') { setSyncBadge('ok', ''); return null; }
    currentVersion = data._version || 0;
    return data;
  } catch (e) {
    setSyncBadge('err', 'Сервер недоступен');
    return null;
  }
}

function doSave() {
  const snapshot = buildStateSnapshot();
  try { localStorage.setItem(getStoreKey(), JSON.stringify(snapshot)); } catch (e) {}
  pushToServer(snapshot);
}

function saveState() {
  if (!stateReady) return;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(doSave, 400);
}

function loadState() {
  let st;
  try { const raw = localStorage.getItem(getStoreKey()); if (!raw) return; st = JSON.parse(raw); } catch (e) { return; }
  applySnapshot(st);
}

function syncControls() {
  const $ = id => document.getElementById(id);
  $('s-cov').value         = covR;  $('v-cov').textContent  = fmtD(covR);
  $('s-top').value         = topN;  $('v-top').textContent  = topN;
  $('s-heat-boost').value  = heatBoost; $('v-heat-boost').textContent = Math.round(heatBoost * 100) + '%';
  $('s-heat-radius').value = heatRadius; $('v-heat-radius').textContent = heatRadius + ' px';
  $('heat-blend').value    = heatBlend;
  $('rec-show').classList.toggle('on', recShow);
  if ($('rec-ref-layer')) $('rec-ref-layer').value = recRefLayerId;
  $('dist-cbx').classList.toggle('on', districtsOn);
  $('inc-heat-cbx').classList.toggle('on', incomeHeatOn);
  $('inc-core-cbx').classList.toggle('on', coresOn);
  ['high', 'mid', 'low'].forEach(t => { const el = $('d-' + t); if (el) el.value = incCol[t]; });
}

/* ── EVENT WIRING ────────────────────────────────────────────────────── */
let _eventsWired = false;
function wireEvents() {
  if (_eventsWired) return;
  _eventsWired = true;
  const $ = id => document.getElementById(id);

  // Rec basis buttons are built dynamically in buildRecBasisUI()

  $('rec-show').addEventListener('click', e => { recShow = !recShow; e.target.classList.toggle('on', recShow); renderRecs(); });
  $('s-cov').addEventListener('input', e => { covR = +e.target.value; $('v-cov').textContent = fmtD(covR); renderRecs(); });
  $('s-top').addEventListener('input', e => { topN = +e.target.value; $('v-top').textContent = topN; renderRecs(); });
  if ($('rec-ref-layer')) $('rec-ref-layer').addEventListener('change', e => { recRefLayerId = e.target.value; renderRecs(); });

  // Heat brightness (fast path — no full re-render)
  $('s-heat-boost').addEventListener('input', e => {
    heatBoost = +e.target.value;
    $('v-heat-boost').textContent = Math.round(heatBoost * 100) + '%';
    restyleHeatCanvases();
  });

  // Heat spot radius
  $('s-heat-radius').addEventListener('input', e => {
    heatRadius = +e.target.value;
    $('v-heat-radius').textContent = heatRadius + ' px';
    renderHeat();
  });

  // Blend mode (fast path)
  $('heat-blend').addEventListener('change', e => {
    heatBlend = e.target.value;
    restyleHeatCanvases();
  });

  // Create layer
  $('add-layer-btn').addEventListener('click', openLayerModal);
  $('layer-modal-cancel').addEventListener('click', closeLayerModal);
  $('layer-modal-confirm').addEventListener('click', confirmLayerModal);
  $('layer-modal-input').addEventListener('keydown', e => { if (e.key === 'Enter') confirmLayerModal(); if (e.key === 'Escape') closeLayerModal(); });
  $('layer-modal-overlay').addEventListener('click', e => { if (e.target === $('layer-modal-overlay')) closeLayerModal(); });

  // Template download
  $('dl-tpl').addEventListener('click', () => {
    const rows = [['name', 'lat', 'lon', 'value'], ['Пример ТТ', 41.311100, 69.279700, 12.5], ['Пример ТТ 2', 41.299000, 69.240000, 8]];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 10 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Данные');
    XLSX.writeFile(wb, 'shablon_dannye.xlsx');
  });

  // File upload (click + drag&drop)
  const fileInp = $('file'), fileBox = $('filebox');
  fileBox.addEventListener('click', () => fileInp.click());
  ['dragenter', 'dragover'].forEach(ev =>
    fileBox.addEventListener(ev, e => { e.preventDefault(); fileBox.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev =>
    fileBox.addEventListener(ev, e => { e.preventDefault(); fileBox.classList.remove('drag'); }));
  fileBox.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0];
    if (f) handleDataFile(f);
  });
  fileInp.addEventListener('change', () => {
    const f = fileInp.files[0]; if (!f) return;
    handleDataFile(f);
  });
  function handleDataFile(f) {
    const ext = f.name.split('.').pop().toLowerCase();
    const done = recs => {
      if (!recs.length) { toast('Не найдено строк с lat/lon', 'err'); return; }
      pendingUpload = recs;
      const fn = $('fname'); fn.style.display = 'block';
      fn.textContent = '✓ ' + f.name + ' — ' + recs.length + ' точек';
      $('btn-update').disabled = false;
      toast(`Загружено ${recs.length} точек`, 'ok');
    };
    if (ext === 'csv') {
      Papa.parse(f, { header: true, skipEmptyLines: true, complete: r => done(toRecs(r.data)) });
    } else {
      const rd = new FileReader();
      rd.onload = e => { const wb = XLSX.read(e.target.result, { type: 'array' }); done(toRecs(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]))); };
      rd.readAsArrayBuffer(f);
    }
  }

  $('btn-update').addEventListener('click', () => {
    if (!pendingUpload) return;
    const tk = $('up-target').value;
    const d  = DS[tk]; if (!d) return;
    d.recs = enrich(pendingUpload); d.stats = statsOf(d.recs); d.visible = true; d._userData = true;
    pendingUpload = null;
    $('btn-update').disabled = true;
    $('fname').style.display = 'none';
    fileInp.value = '';
    buildHeatUI(); renderHeat(); renderRecs();
    toast(`Слой «${d.name}» обновлён (${d.stats.n} точек)`, 'ok');
  });

  // Income + districts
  $('dist-cbx').addEventListener('click',     e => { districtsOn  = !districtsOn;  e.target.classList.toggle('on', districtsOn);  renderDistricts(); });
  $('inc-heat-cbx').addEventListener('click', e => { incomeHeatOn = !incomeHeatOn; e.target.classList.toggle('on', incomeHeatOn); renderIncome(); });
  $('inc-core-cbx').addEventListener('click', e => { coresOn      = !coresOn;      e.target.classList.toggle('on', coresOn);      renderIncome(); });
  ['high', 'mid', 'low'].forEach(t => {
    $('d-' + t).addEventListener('input', e => { incCol[t] = e.target.value; renderIncome(); renderDistricts(); });
  });

  // Export recs
  $('rec-export').addEventListener('click', exportRecs);
  $('btn-retraffic-export').addEventListener('click', exportRetraffic);

  // Share / import state
  $('btn-export-state').addEventListener('click', exportState);
  const stateFileInp = $('state-file');
  $('btn-import-state').addEventListener('click', () => stateFileInp.click());
  stateFileInp.addEventListener('change', () => {
    const f = stateFileInp.files[0];
    if (!f) return;
    importState(f);
    stateFileInp.value = '';
  });

  // Mobile burger + backdrop
  const sideEl = $('side'), backdrop = $('side-backdrop');
  const setSide = open => {
    sideEl.classList.toggle('open', open);
    backdrop.classList.toggle('show', open);
  };
  $('burger').addEventListener('click', () => setSide(!sideEl.classList.contains('open')));
  backdrop.addEventListener('click', () => setSide(false));

  // Autosave — delegated on sidebar, captures all interactions
  document.getElementById('side').addEventListener('input',  saveState);
  document.getElementById('side').addEventListener('change', saveState);
  document.getElementById('side').addEventListener('click',  saveState);
}

/* ── PENDING UPLOAD ──────────────────────────────────────────────────── */
let pendingUpload = null;

/* ── AUTH + PROJECT FLOW ─────────────────────────────────────────────── */
let _sseSource = null;

function showScreen(id) {
  ['auth-screen', 'project-screen', 'app'].forEach(s => {
    const el = document.getElementById(s);
    if (!el) return;
    if (s === id) {
      el.style.display = '';
      el.classList.remove('hidden');
    } else {
      if (s === 'app') el.classList.add('hidden');
      else el.style.display = 'none';
    }
  });
}

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (!res.ok) return null;
    const { user } = await res.json();
    return user;
  } catch (_) { return null; }
}

function formatBytes(b) {
  if (!b) return '';
  if (b < 1024) return b + ' Б';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' КБ';
  return (b / 1024 / 1024).toFixed(1) + ' МБ';
}

async function showProjectPicker(user) {
  currentUserInfo = user;
  showScreen('project-screen');
  const nameEl = document.getElementById('proj-username');
  if (nameEl) nameEl.textContent = user.username + (user.is_admin ? ' · admin' : '');

  const res = await fetch('/api/projects', { credentials: 'include' });
  const projects = res.ok ? await res.json() : [];
  const listEl = document.getElementById('proj-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (!projects.length) {
    listEl.innerHTML = '<p style="color:var(--dim);font-size:12px;text-align:center;padding:16px 0">Нет проектов. Создайте первый.</p>';
    return;
  }
  projects.forEach(p => {
    const item = document.createElement('div');
    item.className = 'proj-item';
    const roleLabel = { owner: 'владелец', editor: 'редактор', viewer: 'зритель' }[p.role] || p.role;
    const sizeLabel = p.size_bytes > 1024 ? ' · ' + formatBytes(p.size_bytes) : '';
    const warn = p.size_bytes > 20 * 1024 * 1024 ? ' 🔴' : p.size_bytes > 10 * 1024 * 1024 ? ' 🟡' : '';
    item.innerHTML = `
      <div class="proj-item-info">
        <div class="proj-item-name">${p.name}</div>
        <div class="proj-item-meta">${roleLabel}${sizeLabel}${warn}</div>
      </div>
      <div class="proj-item-actions">
        <button class="proj-open" title="Открыть">▶</button>
        <button class="proj-dup" title="Дублировать">⧉</button>
        ${p.role === 'owner' ? `<button class="proj-del" title="Удалить">🗑</button>` : ''}
      </div>`;
    item.querySelector('.proj-open').addEventListener('click', () => openProject(p.id, p.name, p.role));
    item.querySelector('.proj-dup').addEventListener('click', async () => {
      const r = await fetch(`/api/projects/${p.id}/duplicate`, { method: 'POST', credentials: 'include' });
      if (r.ok) { toast('Проект продублирован', 'ok'); showProjectPicker(user); }
    });
    const delBtn = item.querySelector('.proj-del');
    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Удалить проект «${p.name}»? Это действие нельзя отменить.`)) return;
        await fetch(`/api/projects/${p.id}`, { method: 'DELETE', credentials: 'include' });
        showProjectPicker(user);
      });
    }
    listEl.appendChild(item);
  });
}

async function openProject(id, name, role) {
  currentProjectId = id;
  currentVersion   = 0;
  showScreen('app');

  // Map was initialised while #app was hidden (0×0) — fix its size now
  setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 60);

  // Update project name in header
  const brandP = document.querySelector('.brand-text p');
  if (brandP) brandP.textContent = name + (role === 'viewer' ? ' · только просмотр' : '');
  const roleBadge = document.getElementById('mode-badge');
  if (roleBadge) {
    if (role === 'viewer') { roleBadge.style.display = ''; roleBadge.textContent = '👁 Только просмотр'; roleBadge.className = 'mode-badge mode-view'; }
    else roleBadge.style.display = 'none';
  }

  // Show sync badge
  const syncBadge = document.getElementById('sync-badge');
  if (syncBadge) syncBadge.style.display = '';

  wireEvents();
  stateReady = false;

  // Load from localStorage first for instant UI
  loadState();
  buildCityUI(); buildHeatUI(); buildPtUI(); rebuildUpTarget(); syncControls();
  renderHeat(); renderPoints(); renderRecs(); renderDistricts(); renderIncome();

  // Then load from server
  const serverState = await fetchFromServer();
  if (serverState) {
    applySnapshot(serverState);
    try { localStorage.setItem(getStoreKey(), JSON.stringify(serverState)); } catch (_) {}
    buildCityUI(); buildHeatUI(); buildPtUI(); rebuildUpTarget(); syncControls();
    renderHeat(); renderPoints(); renderRecs(); renderDistricts(); renderIncome();
    setSyncBadge('ok', 'Загружено');
  }

  stateReady = true;
  checkEmptyState();
  setupSSE(id);
}

function checkEmptyState() {
  const es = document.getElementById('empty-state');
  if (!es) return;
  es.style.display = (!heatKeys.length) ? 'flex' : 'none';
}

function setupSSE(projectId) {
  if (_sseSource) { _sseSource.close(); _sseSource = null; }
  try {
    _sseSource = new EventSource(`/api/projects/${projectId}/events`);
    _sseSource.onmessage = e => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'state_updated' && data.version > currentVersion) {
          toast(`${data.by} обновил карту — нажмите для перезагрузки`, 'info', 6000);
        }
      } catch (_) {}
    };
  } catch (_) {}
}

/* ── INIT ────────────────────────────────────────────────────────────── */
(async function init() {
  // Wire auth-screen events
  const authTabs = document.querySelectorAll('.auth-tab');
  const authForm = document.getElementById('auth-form');
  const regForm  = document.getElementById('reg-form');

  authTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      authTabs.forEach(t => t.classList.remove('on'));
      tab.classList.add('on');
      const isLogin = tab.id === 'tab-login';
      authForm.style.display = isLogin ? '' : 'none';
      regForm.style.display  = isLogin ? 'none' : '';
      document.getElementById('auth-err').textContent = '';
      document.getElementById('reg-err').textContent  = '';
    });
  });

  // Login
  authForm && authForm.addEventListener('submit', async e => {
    e.preventDefault();
    const btn  = document.getElementById('auth-submit');
    const errEl = document.getElementById('auth-err');
    btn.disabled = true; btn.textContent = 'Входим…';
    errEl.textContent = '';
    const res = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: document.getElementById('auth-user').value.trim(), password: document.getElementById('auth-pass').value }),
    });
    const data = await res.json();
    if (res.ok) {
      await showProjectPicker(data.user);
    } else {
      errEl.textContent = data.error || 'Неверный логин или пароль';
    }
    btn.disabled = false; btn.textContent = 'Войти';
  });

  // Register
  regForm && regForm.addEventListener('submit', async e => {
    e.preventDefault();
    const btn   = document.getElementById('reg-submit');
    const errEl = document.getElementById('reg-err');
    btn.disabled = true; btn.textContent = 'Создаём…';
    errEl.textContent = '';
    const res = await fetch('/api/auth/signup', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('reg-email').value.trim(),
        username: document.getElementById('reg-user').value.trim(),
        password: document.getElementById('reg-pass').value,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      await showProjectPicker(data.user);
    } else {
      errEl.textContent = data.error || 'Ошибка регистрации';
    }
    btn.disabled = false; btn.textContent = 'Создать аккаунт';
  });

  // Project picker events
  const projNewBtn    = document.getElementById('proj-new-btn');
  const projLogoutBtn = document.getElementById('proj-logout-btn');

  projNewBtn && projNewBtn.addEventListener('click', async () => {
    const name = prompt('Название проекта:');
    if (!name || !name.trim()) return;
    const res = await fetch('/api/projects', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (res.ok) {
      const p = await res.json();
      openProject(p.id, p.name, p.role);
    }
  });

  projLogoutBtn && projLogoutBtn.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    currentProjectId = null; currentUserInfo = null;
    showScreen('auth-screen');
  });

  // Logout from map
  const logoutBtn = document.getElementById('logout-btn');
  logoutBtn && logoutBtn.addEventListener('click', async () => {
    if (_sseSource) { _sseSource.close(); _sseSource = null; }
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    stateReady = false; currentProjectId = null; currentUserInfo = null;
    showScreen('auth-screen');
  });

  // Members modal
  const membersModalOverlay = document.getElementById('members-modal-overlay');
  const membersCloseBtn     = document.getElementById('members-modal-close');
  const memberAddBtn        = document.getElementById('member-add-btn');

  document.getElementById('btn-members') && document.getElementById('btn-members').addEventListener('click', openMembersModal);
  membersCloseBtn && membersCloseBtn.addEventListener('click', () => { if (membersModalOverlay) membersModalOverlay.style.display = 'none'; });
  memberAddBtn && memberAddBtn.addEventListener('click', async () => {
    const username = document.getElementById('member-username').value.trim();
    const role     = document.getElementById('member-role').value;
    if (!username) return;
    const r = await fetch(`/api/projects/${currentProjectId}/members`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, role }),
    });
    const d = await r.json();
    if (r.ok) { document.getElementById('member-username').value = ''; openMembersModal(); }
    else toast(d.error || 'Ошибка', 'err');
  });

  // History modal
  const historyModalOverlay = document.getElementById('history-modal-overlay');
  const historyCloseBtn     = document.getElementById('history-modal-close');
  document.getElementById('btn-history') && document.getElementById('btn-history').addEventListener('click', openHistoryModal);
  historyCloseBtn && historyCloseBtn.addEventListener('click', () => { if (historyModalOverlay) historyModalOverlay.style.display = 'none'; });

  // Empty state
  const emptyAddLayer = document.getElementById('empty-add-layer');
  emptyAddLayer && emptyAddLayer.addEventListener('click', () => {
    document.getElementById('empty-state').style.display = 'none';
    openLayerModal();
  });

  // Check if already logged in
  const user = await checkAuth();
  if (user) {
    await showProjectPicker(user);
  } else {
    showScreen('auth-screen');
  }
})();

async function openMembersModal() {
  const overlay = document.getElementById('members-modal-overlay');
  if (!overlay || !currentProjectId) return;
  overlay.style.display = 'flex';
  const listEl = document.getElementById('members-list');
  listEl.innerHTML = '<p style="color:var(--dim);font-size:12px">Загрузка…</p>';
  const res = await fetch(`/api/projects/${currentProjectId}/members`, { credentials: 'include' });
  if (!res.ok) { listEl.innerHTML = ''; return; }
  const members = await res.json();
  listEl.innerHTML = '';
  members.forEach(m => {
    const row = document.createElement('div');
    row.className = 'member-row';
    const roleLabel = { owner: 'владелец', editor: 'редактор', viewer: 'зритель' }[m.role] || m.role;
    row.innerHTML = `<span class="member-name">${m.username}</span><span class="member-role">${roleLabel}</span>`;
    if (m.role !== 'owner' && currentUserInfo && currentProjectId) {
      const del = document.createElement('button');
      del.textContent = '✕'; del.className = 'member-del';
      del.addEventListener('click', async () => {
        await fetch(`/api/projects/${currentProjectId}/members/${m.id}`, { method: 'DELETE', credentials: 'include' });
        openMembersModal();
      });
      row.appendChild(del);
    }
    listEl.appendChild(row);
  });
}

async function openHistoryModal() {
  const overlay = document.getElementById('history-modal-overlay');
  if (!overlay || !currentProjectId) return;
  overlay.style.display = 'flex';
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '<p style="color:var(--dim);font-size:12px">Загрузка…</p>';
  const res = await fetch(`/api/projects/${currentProjectId}/history`, { credentials: 'include' });
  if (!res.ok) { listEl.innerHTML = ''; return; }
  const history = await res.json();
  listEl.innerHTML = '';
  if (!history.length) { listEl.innerHTML = '<p style="color:var(--dim);font-size:12px;padding:8px 0">История пуста</p>'; return; }
  history.forEach(h => {
    const row = document.createElement('div');
    row.className = 'history-row';
    const dt = new Date(h.saved_at).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    row.innerHTML = `<span class="history-date">${dt}</span><span class="history-by">${h.username || '—'}</span>`;
    const restoreBtn = document.createElement('button');
    restoreBtn.textContent = 'Откатить'; restoreBtn.className = 'modal-btn secondary';
    restoreBtn.style.cssText = 'font-size:11px;padding:4px 10px';
    restoreBtn.addEventListener('click', async () => {
      if (!confirm('Откатить к этой версии?')) return;
      const r = await fetch(`/api/projects/${currentProjectId}/history/${h.id}/restore`, { method: 'POST', credentials: 'include' });
      if (r.ok) {
        overlay.style.display = 'none';
        const st = await fetchFromServer();
        if (st) {
          applySnapshot(st);
          buildCityUI(); buildHeatUI(); buildPtUI(); rebuildUpTarget(); syncControls();
          renderHeat(); renderPoints(); renderRecs(); renderDistricts(); renderIncome();
          toast('Версия восстановлена', 'ok');
        }
      } else toast('Ошибка отката', 'err');
    });
    row.appendChild(restoreBtn);
    listEl.appendChild(row);
  });
}
