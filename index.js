/* ============================================================
   REMO — Index.js
   Conexión a Supabase + lógica de la app (login, Train, Sesiones, Home)
   Alcance: atleta individual (sin panel de entrenador, Excel ni apodos).
   ============================================================ */

const SUPABASE_URL = 'https://bpclsyvvwsdybicddmee.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1tWdx70gALNUqj38Hh75UQ_s2I4fgf1';

// Clave única de Google Gemini para el reconocimiento por foto en Train.
// La sacás gratis (sin tarjeta) en https://aistudio.google.com/apikey y la pegás acá una sola vez.
// Vale para los ~12 usuarios de la app; no hace falta que cada uno tenga la suya.
const GEMINI_API_KEY = 'AQ.Ab8RN6Jdr8rwWrFeAPDcWsfkltuwM0KyLXwNubzFl3OEVGVlpg';

let sb = null;
let currentUser = null;
let entrenamientosCache = [];
let editingSessionId = null;
let pendingDeleteId = null;
let tableFilterValue = '';
let trabajoFilterValue = ''; // filtro de Sesiones por tipo de trabajo (20 min, 3000 m, 6x8:00…)
let chartFilterValue = 'all'; // qué trabajos muestra el gráfico de líneas de Sesiones
let regatasCache = [];      // regatas del usuario (tabla `regatas` en Supabase)
let inicioBloque = null;    // inicio del bloque de carga (tabla `configuracion`)
let zonaManual = false;     // true = el usuario eligió la zona a mano; false = automática
let configDBLista = true;
// Umbrales para reconocer la zona automáticamente por SPM (ajustalos al plan del entrenador).
// hasta z1Max → Z1 · hasta z2Max → Z2 · hasta wattsMax → Watts · más → Sprint
const ZONA_SPM = { z1Max: 19, z2Max: 23, wattsMax: 30 };
const DOMINIO_INTERNO = 'remo.local';
const N_PARCIALES_MAX = 10;

// Zonas: el orden es el que recorre el círculo al tocarlo en Train.
const CATEGORIAS = ['z1', 'z2', 'watts', 'sprint', 'test'];
const CAT_LABEL = { z1: 'Z1', z2: 'Z2', watts: 'W', sprint: 'SP', test: 'TS' };
const CAT_NOMBRE = { z1: 'Zona 1', z2: 'Zona 2', watts: 'Watts', sprint: 'Sprint', test: 'Test' };
const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

const $ = (id) => document.getElementById(id);

/* ---------------- Utilidades ---------------- */

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), 2600);
}

// Fechas siempre en hora LOCAL (toISOString() devuelve UTC y en Argentina
// después de las 21 h daba el día siguiente).
function isoDeFecha(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hoyISO() { return isoDeFecha(new Date()); }
function fechaDesdeISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function diasEntre(aISO, bISO) {
  return Math.round((fechaDesdeISO(bISO) - fechaDesdeISO(aISO)) / 86400000);
}
function fechaLegible(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function fechaCorta(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}
function nombreDia(iso) {
  return DIAS[fechaDesdeISO(iso).getDay()];
}

// "mm:ss", "mm:ss.s", "mm:ss,s" o "hh:mm:ss(.s)" -> segundos (float). Acepta coma decimal.
function parseTiempoASegundos(str) {
  if (!str) return null;
  const partes = String(str).trim().replace(',', '.').split(':').map((p) => parseFloat(p));
  if (partes.some((n) => isNaN(n))) return null;
  if (partes.length === 2) return partes[0] * 60 + partes[1];
  if (partes.length === 3) return partes[0] * 3600 + partes[1] * 60 + partes[2];
  return null;
}

function segundosATiempo(seg) {
  if (seg === null || seg === undefined || isNaN(seg)) return '';
  const s = Math.round(seg * 10) / 10;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const restStr = rest < 10 ? '0' + rest.toFixed(1) : rest.toFixed(1);
  return m + ':' + restStr;
}

// "123.4" -> "123,4" (para mostrar como en el diseño)
function conComa(str) {
  return str == null ? '' : String(str).replace('.', ',');
}

function normTiempo(str) {
  const t = String(str ?? '').trim().replace(',', '.');
  return t || null;
}

function descargar(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------- Supabase / Auth ---------------- */

function initSupabase() {
  if (!window.supabase) {
    console.error('No se pudo cargar la librería de Supabase.');
    toast('No se pudo conectar con Supabase. Revisá tu conexión.');
    return;
  }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

async function checkSession() {
  if (!sb) return;
  const { data } = await sb.auth.getSession();
  if (data.session) onLoggedIn(data.session.user);
}

function showRegisterMode() {
  $('login-mode').style.display = 'none';
  $('register-mode').style.display = '';
  $('register-err').textContent = '';
}

function showLoginMode() {
  $('register-mode').style.display = 'none';
  $('login-mode').style.display = '';
  $('login-err').textContent = '';
}

async function doLogin() {
  const usuario = $('login-user').value.trim().toLowerCase();
  const pass = $('login-pass').value;
  $('login-err').textContent = '';
  if (!usuario || !pass) {
    $('login-err').textContent = 'Completá usuario y contraseña.';
    return;
  }
  const email = usuario.includes('@') ? usuario : `${usuario}@${DOMINIO_INTERNO}`;
  const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
  if (error) {
    $('login-err').textContent = 'Usuario o contraseña incorrectos.';
    return;
  }
  onLoggedIn(data.user);
}

async function doRegister() {
  const usuario = $('reg-user').value.trim().toLowerCase();
  const pass = $('reg-pass').value;
  const pass2 = $('reg-pass2').value;
  $('register-err').textContent = '';

  if (!usuario || !pass) {
    $('register-err').textContent = 'Completá usuario y contraseña.';
    return;
  }
  if (!/^[a-z0-9._-]+$/.test(usuario)) {
    $('register-err').textContent = 'El usuario solo puede tener letras, números, punto, guion o guion bajo.';
    return;
  }
  if (pass.length < 4) {
    $('register-err').textContent = 'La contraseña tiene que tener al menos 4 caracteres.';
    return;
  }
  if (pass !== pass2) {
    $('register-err').textContent = 'Las contraseñas no coinciden.';
    return;
  }

  const email = `${usuario}@${DOMINIO_INTERNO}`;
  const { data, error } = await sb.auth.signUp({ email, password: pass });
  if (error) {
    $('register-err').textContent = error.message.toLowerCase().includes('already registered')
      ? 'Ese usuario ya existe, probá con otro o iniciá sesión.'
      : 'Error: ' + error.message;
    return;
  }
  if (data.session) {
    onLoggedIn(data.user);
  } else {
    toast('Cuenta creada. Iniciá sesión.');
    showLoginMode();
  }
}

async function logout() {
  if (sb) await sb.auth.signOut();
  currentUser = null;
  entrenamientosCache = [];
  regatasCache = [];
  inicioBloque = null;
  editingSessionId = null;
  $('login-overlay').style.display = '';
  showLoginMode();
  $('login-user').value = '';
  $('login-pass').value = '';
  navigateTo('home', 'resumen', $('nav-home'));
}

function onLoggedIn(user) {
  currentUser = user;
  $('login-overlay').style.display = 'none';
  setAvatarInitials(user.email);
  const usuario = (user.email || '').split('@')[0];
  if ($('settings-user')) $('settings-user').textContent = `Sesión iniciada como ${usuario}`;
  if (!$('f-date').value) $('f-date').value = hoyISO();
  cargarConfigDB();
  cargarEntrenamientos();
}

/* ---------------- Navegación ---------------- */

function navigateTo(pageId, label, btnEl) {
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  const page = $(pageId);
  if (page) page.classList.add('active');
  document.querySelectorAll('.glass-btn').forEach((b) => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  if (pageId === 'historial') renderHistorial();
  if (page) page.scrollTop = 0;
}

/* ---------------- Train: medio / zona / parciales ---------------- */

function toggleWaterOptions() {
  const esAgua = $('f-medium').value === 'agua';
  $('water-options').style.display = esAgua ? '' : 'none';
  const card = document.querySelector('.train-summary-card');
  if (card) card.classList.toggle('is-agua', esAgua);
}

// Marca la sesión como "no completada" (borde rojo).
// (a prueba de que falte el interruptor en el HTML: nunca rompe el guardado ni la IA)
function esIncompleto() {
  const c = $('f-incomplete');
  return !!(c && c.checked);
}

function toggleIncomplete() {
  const on = esIncompleto();
  const t = $('incomplete-toggle');
  if (t) t.classList.toggle('on', on);
  const card = document.querySelector('.train-summary-card');
  if (card) card.classList.toggle('is-incompleto', on);
}

function setIncompleto(valor) {
  const c = $('f-incomplete');
  if (c) c.checked = !!valor;
  toggleIncomplete();
}

// Porcentaje del agua: acepta décimas con punto o coma (88.2 / 88,2).
function leerPorcentaje() {
  const v = String($('f-percentage').value).trim().replace(',', '.');
  if (!v) return null;
  const n = Number(v);
  return isNaN(n) ? null : Math.round(n * 10) / 10;
}

function setCategoria(cat) {
  const c = CATEGORIAS.includes(cat) ? cat : 'z1';
  $('f-cat').value = c;
  const btn = $('f-cat-btn');
  btn.textContent = CAT_LABEL[c];
  btn.className = 'cat-circle z-' + c;
  btn.title = CAT_NOMBRE[c] + (zonaManual ? '' : ' (automática)');
  $('zone-wrap').classList.toggle('auto', !zonaManual);
  const activo = zonaManual ? c : 'auto';
  document.querySelectorAll('#zone-menu .zoneItem').forEach((b) => b.classList.toggle('active', b.dataset.zona === activo));
}

// Lista desplegable de zonas (primera opción: automática).
function construirMenuZona() {
  const m = $('zone-menu');
  m.innerHTML =
    `<button type="button" class="zoneItem" data-zona="auto"><span class="zdot auto"></span><span>Automática</span></button>` +
    CATEGORIAS.map((c) =>
      `<button type="button" class="zoneItem" data-zona="${c}"><span class="zdot z-${c}"></span><span>${CAT_NOMBRE[c]}</span></button>`).join('');
  m.querySelectorAll('.zoneItem').forEach((b) =>
    b.addEventListener('click', () => { elegirZona(b.dataset.zona); cerrarMenuZona(); }));
}

function toggleMenuZona(ev) {
  if (ev) ev.stopPropagation();
  $('zone-menu').classList.toggle('show');
}

function cerrarMenuZona() {
  $('zone-menu').classList.remove('show');
}

function elegirZona(z) {
  if (z === 'auto') {
    zonaManual = false;
    autoZona();
  } else {
    zonaManual = true;
    setCategoria(z);
  }
}

// Reconoce la zona a partir de nombre del trabajo, SPM y parciales (sirve para el formulario y para la carga por IA).
function zonaDeDatos({ tipo, spm, metros, n }) {
  const t = String(tipo || '').trim().toLowerCase();
  if (/\btest\b/.test(t) || /^(2000\s*m?|2\s*k(m)?)$/.test(t)) return 'test';
  if (n <= 1 && metros === 2000) return 'test';
  if (/sprint/.test(t)) return 'sprint';
  if (/watt/.test(t)) return 'watts';
  if (!spm) return null;
  if (spm <= ZONA_SPM.z1Max) return 'z1';
  if (spm <= ZONA_SPM.z2Max) return 'z2';
  if (spm <= ZONA_SPM.wattsMax) return 'watts';
  return 'sprint';
}

// Reconoce la zona con lo que hay cargado en el formulario.
function detectarZona() {
  const tot = calcularTotales();
  return zonaDeDatos({
    tipo: $('f-type').value,
    spm: Number($('f-spm').value) || tot.spm,
    metros: tot.metros || Number($('f-meters').value) || 0,
    n: tot.n,
  });
}

function autoZona() {
  if (zonaManual) return;
  setCategoria(detectarZona() || $('f-cat').value);
}

function addParcialRow(data) {
  const cont = $('parciales-container');
  if (cont.children.length >= N_PARCIALES_MAX) {
    toast(`Máximo ${N_PARCIALES_MAX} parciales.`);
    return;
  }
  const idx = cont.children.length + 1;
  const row = document.createElement('div');
  row.className = 'adv-table-row parcial-row';
  row.innerHTML = `
    <div>${idx}</div>
    <div><input type="text" class="p-tiempo" placeholder="8:00" inputmode="decimal" value="${esc(data?.tiempo)}"></div>
    <div><input type="number" class="p-metros" placeholder="2381" inputmode="numeric" value="${esc(data?.metros)}"></div>
    <div><input type="text" class="p-pace" placeholder="1:59.3" inputmode="decimal" value="${esc(data?.pace)}"></div>
    <div><input type="number" class="p-spm" placeholder="18" inputmode="numeric" value="${esc(data?.spm)}"></div>
    <div><button type="button" class="removeParcialBtn" aria-label="Quitar parcial" onclick="this.closest('.parcial-row').remove(); renumerarParciales();">✕</button></div>
  `;
  cont.appendChild(row);
}

function renumerarParciales() {
  [...$('parciales-container').children].forEach((row, i) => {
    row.firstElementChild.textContent = i + 1;
  });
  autoTotalesForm();
}

/* ---------- Cálculo automático (en el agua solo se ve el tiempo total) ---------- */

// Un campo es "libre" si está vacío o si lo llenó la app sola (no lo escribió el usuario).
function esLibre(input) {
  return !input.value.trim() || input.dataset.auto === '1';
}

// Dentro de un parcial: con tiempo + metros calcula el /500m; con tiempo + /500m calcula los metros.
function recalcularFila(row) {
  const iT = row.querySelector('.p-tiempo');
  const iM = row.querySelector('.p-metros');
  const iP = row.querySelector('.p-pace');
  const t = parseTiempoASegundos(iT.value);
  const m = Number(iM.value);
  const p = parseTiempoASegundos(iP.value);
  if (t && m > 0 && esLibre(iP)) {
    iP.value = segundosATiempo((t / m) * 500);
    iP.dataset.auto = '1';
  } else if (t && p && esLibre(iM)) {
    iM.value = Math.round((t / p) * 500);
    iM.dataset.auto = '1';
  }
}

// Totales del formulario: suma de parciales y /500m promedio, mientras el usuario no los escriba a mano.
// Si no hay parciales, con tiempo total + metros calcula igual el /500m.
function autoTotalesForm() {
  const tot = calcularTotales();
  const iT = $('f-totaltime');
  const iM = $('f-meters');
  const iS = $('f-split');
  if (esLibre(iT)) {
    if (tot.segundos) { iT.value = segundosATiempo(tot.segundos); iT.dataset.auto = '1'; }
    else { iT.value = ''; delete iT.dataset.auto; }
  }
  if (esLibre(iM)) {
    if (tot.metros) { iM.value = tot.metros; iM.dataset.auto = '1'; }
    else { iM.value = ''; delete iM.dataset.auto; }
  }
  const seg = parseTiempoASegundos(iT.value);
  const m = Number(iM.value);
  if (esLibre(iS)) {
    if (seg && m > 0) { iS.value = segundosATiempo((seg / m) * 500); iS.dataset.auto = '1'; }
    else { iS.value = ''; delete iS.dataset.auto; }
  }
}

function limpiarAutoTotales() {
  ['f-meters', 'f-totaltime', 'f-split'].forEach((id) => delete $(id).dataset.auto);
}

/* ---------- Campos de tiempo: el teclado numérico del celular no tiene ":" ----------
   Se escriben solo los números y la app pone ":" y "." sola, como un cronómetro:
   7123 → 7:12.3 · 2042 → 2:04.2 · 8000 → 8:00.0 · 35000 → 35:00.0
   Si alguien escribe ":" o "." a mano (teclado completo), se respeta lo que escribió. */

function esCampoTiempo(el) {
  return !!el && (el.classList.contains('p-tiempo') || el.classList.contains('p-pace') ||
    el.id === 'f-totaltime' || el.id === 'f-split');
}

function formatearDigitosATiempo(digitos) {
  const d = String(digitos).replace(/^0+/, '').slice(0, 7);
  if (!d) return '';
  const s = d.padStart(3, '0');
  return `${s.slice(0, -3) || '0'}:${s.slice(-3, -1)}.${s.slice(-1)}`;
}

function autoFormatoTiempo(input, ev) {
  // Escribió un separador a mano: modo manual hasta que vacíe el campo.
  if (ev && /^[:.,]$/.test(ev.data || '')) input.dataset.manual = '1';
  if (!input.value.trim()) { delete input.dataset.manual; return; }
  if (input.dataset.manual === '1') return;
  const formateado = formatearDigitosATiempo(input.value.replace(/\D/g, ''));
  if (formateado !== input.value) input.value = formateado;
}

/* ---------- Guardado en Supabase con respaldo si la base todavía no está actualizada ---------- */

function sinCampo(r, campo) {
  const f = (o) => { const c = { ...o }; delete c[campo]; return c; };
  return Array.isArray(r) ? r.map(f) : f(r);
}

function redondearEnteros(r) {
  const f = (o) => {
    const c = { ...o };
    ['tiempo_segundos', 'porcentaje', 'distancia_metros', 'spm_general'].forEach((k) => {
      if (c[k] != null) c[k] = Math.round(Number(c[k]));
    });
    return c;
  };
  return Array.isArray(r) ? r.map(f) : f(r);
}

// op(registro) -> { error }. Devuelve { error, aviso }.
async function guardarConRespaldo(op, registro) {
  let res = await op(registro);
  let aviso = '';
  if (res.error && /completado/i.test(res.error.message || '')) {
    registro = sinCampo(registro, 'completado');
    res = await op(registro);
    aviso = ' Falta ejecutar supabase_cambios.sql para guardar "no completado".';
  }
  if (res.error && /integer/i.test(res.error.message || '')) {
    registro = redondearEnteros(registro);
    res = await op(registro);
    aviso = ' Se guardó redondeado: ejecutá supabase_cambios.sql en Supabase para guardar décimas.';
  }
  if (res.error && /check constraint/i.test(res.error.message || '')) {
    res.error = { ...res.error, message: 'la base no admite esta zona. Ejecutá supabase_cambios.sql en Supabase (SQL Editor).' };
  }
  return { error: res.error, aviso };
}

function limpiarParciales() {
  $('parciales-container').innerHTML = '';
}

// Junta los parciales en {tramo_1..tramo_10} (jsonb) para guardar en Supabase.
function collectParciales() {
  const filas = [...$('parciales-container').children];
  const out = {};
  for (let i = 1; i <= N_PARCIALES_MAX; i++) out[`tramo_${i}`] = null;
  filas.forEach((row, i) => {
    if (i >= N_PARCIALES_MAX) return;
    const tiempo = normTiempo(row.querySelector('.p-tiempo').value);
    const metros = row.querySelector('.p-metros').value.trim();
    let pace = normTiempo(row.querySelector('.p-pace').value);
    const spm = row.querySelector('.p-spm').value.trim();
    if (!tiempo && !metros && !pace && !spm) return;
    // Si falta el /500m pero hay tiempo y metros, se calcula.
    const seg = parseTiempoASegundos(tiempo);
    if (!pace && seg && Number(metros) > 0) pace = segundosATiempo((seg / Number(metros)) * 500);
    out[`tramo_${i + 1}`] = {
      tiempo,
      metros: metros ? Number(metros) : null,
      pace,
      spm: spm ? Number(spm) : null,
    };
  });
  return out;
}

function parcialesDesdeEntreno(entreno) {
  const arr = [];
  for (let i = 1; i <= N_PARCIALES_MAX; i++) {
    const t = entreno[`tramo_${i}`];
    if (t) arr.push(t);
  }
  return arr;
}

// Totales calculados a partir de los parciales cargados.
function calcularTotales() {
  let metros = 0, segundos = 0, spmSum = 0, spmN = 0, n = 0;
  [...$('parciales-container').children].forEach((row) => {
    const m = Number(row.querySelector('.p-metros').value);
    const s = parseTiempoASegundos(row.querySelector('.p-tiempo').value);
    const spm = Number(row.querySelector('.p-spm').value);
    if (m > 0 || s) n++;
    if (m > 0) metros += m;
    if (s) segundos += s;
    if (spm > 0) { spmSum += spm; spmN++; }
  });
  return { metros, segundos, spm: spmN ? Math.round(spmSum / spmN) : null, n };
}

/* ---------------- Train: importar desde fotos con IA (Google Gemini, gratis) ---------------- */

// Modelo principal y respaldos: si el principal está saturado (error 503 "alta demanda"),
// se prueba con el siguiente. Cada modelo tiene su propia capacidad y su propia cuota.
const GEMINI_MODELOS = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'];
const GEMINI_REINTENTOS = 3;        // intentos por modelo antes de pasar al siguiente
const GEMINI_ESPERA_BASE_MS = 2000; // espera inicial; se duplica en cada reintento (2s → 4s → 8s)
const AI_MAX_FOTOS = 8;     // máximo de fotos por tanda
const AI_MAX_LADO = 1280;   // las fotos se reducen a este tamaño (px) antes de enviarse

const AI_PROMPT_FOTO = `Te paso una o más fotos de pantallas del monitor PM5 (Concept2) de un ergómetro de remo.
Devolvé las sesiones de entrenamiento que veas, siguiendo el esquema JSON pedido.
Reglas:
- Si varias fotos son del MISMO entrenamiento (ej: pantalla de resumen + pantalla de parciales/splits), unilas en UNA sola sesión.
- Si las fotos son de entrenamientos DISTINTOS, devolvé una sesión por cada uno.
- "type": texto corto del trabajo, ej "4x8:00", "6x2000m", "2000m", "30:00".
- "split": promedio /500m de toda la sesión, ej "1:57.9". "totaltime": tiempo total, ej "35:00.0".
- En "parciales" va un elemento por cada intervalo/parcial, en orden. "pace" es el /500m del parcial.
- Si algún dato no se ve en la pantalla, poné null. No inventes datos.`;

const AI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    sesiones: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          date: { type: 'STRING', nullable: true, description: 'AAAA-MM-DD si se ve en la pantalla' },
          type: { type: 'STRING', nullable: true },
          meters: { type: 'NUMBER', nullable: true },
          split: { type: 'STRING', nullable: true },
          totaltime: { type: 'STRING', nullable: true },
          spm: { type: 'NUMBER', nullable: true },
          parciales: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                tiempo: { type: 'STRING', nullable: true },
                metros: { type: 'NUMBER', nullable: true },
                pace: { type: 'STRING', nullable: true },
                spm: { type: 'NUMBER', nullable: true },
              },
            },
          },
        },
      },
    },
  },
  required: ['sesiones'],
};

function getGeminiKey() {
  return GEMINI_API_KEY;
}

function triggerAiPhoto(modo) {
  if (!getGeminiKey() || getGeminiKey() === 'PEGÁ_ACÁ_TU_CLAVE_DE_GEMINI') {
    toast('Falta configurar la clave de Gemini en el código de la app (GEMINI_API_KEY en Index.js).');
    return;
  }
  const input = modo === 'camera' ? $('ai-photo-input-camera') : $('ai-photo-input-gallery');
  input.value = '';
  input.click();
}

// Reduce la foto (lado máx. AI_MAX_LADO) y la devuelve como JPEG en base64: sube más rápido y gasta menos cuota.
async function fotoABase64(file) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, AI_MAX_LADO / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * k);
    canvas.height = Math.round(bmp.height * k);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    if (bmp.close) bmp.close();
    return { mime: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.85).split(',')[1] };
  } catch (e) {
    // Si el navegador no puede decodificarla (ej. HEIC), se manda tal cual.
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ mime: file.type || 'image/jpeg', data: String(reader.result).split(',')[1] || '' });
      reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      reader.readAsDataURL(file);
    });
  }
}

async function handleAiPhoto(event) {
  let files = [...(event.target.files || [])];
  event.target.value = '';
  if (!files.length) return;
  if (files.length > AI_MAX_FOTOS) {
    toast(`Se analizan las primeras ${AI_MAX_FOTOS} fotos.`);
    files = files.slice(0, AI_MAX_FOTOS);
  }
  const statusEl = $('ai-photo-status');
  const botones = document.querySelectorAll('.aiPhotoBtn');
  botones.forEach((b) => (b.disabled = true));
  if (statusEl) statusEl.textContent = `Analizando ${files.length} foto${files.length === 1 ? '' : 's'}…`;
  try {
    const fotos = await Promise.all(files.map(fotoABase64));
    const sesiones = await analizarFotosConGemini(fotos);
    if (!sesiones.length) throw new Error('no se detectó ningún entrenamiento en las fotos.');
    if (sesiones.length === 1) {
      aplicarDatosIA(sesiones[0]);
      toast('Datos cargados desde las fotos. Revisalos y guardá.');
    } else {
      if (statusEl) statusEl.textContent = `Guardando ${sesiones.length} sesiones…`;
      await guardarSesionesIA(sesiones);
    }
  } catch (e) {
    console.error(e);
    toast('No se pudo analizar: ' + (e.message || 'error desconocido'));
  } finally {
    if (statusEl) statusEl.textContent = '';
    botones.forEach((b) => (b.disabled = false));
  }
}

// Envía todas las fotos en una sola consulta y pide salida JSON estructurada (responseSchema).
async function analizarFotosConGemini(fotos) {
  const key = getGeminiKey();
  if (!key) throw new Error('falta la clave de Gemini');
  const statusEl = $('ai-photo-status');
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const armarBody = (modelo) => {
    const generationConfig = { responseMimeType: 'application/json', responseSchema: AI_SCHEMA };
    // thinkingLevel solo lo entienden los modelos Gemini 3; los 2.5 lo rechazarían.
    if (/gemini-3/.test(modelo)) generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    return JSON.stringify({
      contents: [{
        parts: [
          { text: AI_PROMPT_FOTO },
          ...fotos.map((f) => ({ inline_data: { mime_type: f.mime, data: f.data } })),
        ],
      }],
      generationConfig,
    });
  };

  let data = null;
  let ultimoError = 'Gemini no respondió.';
  const registroIA = [];
  modelos:
  for (let m = 0; m < GEMINI_MODELOS.length; m++) {
    const modelo = GEMINI_MODELOS[m];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`;
    const body = armarBody(modelo);
    for (let intento = 1; intento <= GEMINI_REINTENTOS; intento++) {
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body,
        });
      } catch (e) {
        // Error de red: se reintenta igual.
        ultimoError = 'no hay conexión con Gemini.';
        if (intento < GEMINI_REINTENTOS) { await esperar(GEMINI_ESPERA_BASE_MS * 2 ** (intento - 1)); continue; }
        continue modelos;
      }
      if (res.ok) { data = await res.json(); break modelos; }

      let detalle = '';
      try { detalle = (await res.json()).error?.message || ''; } catch (e) { /* ignore */ }
      console.warn(`Gemini ${modelo} (intento ${intento}): HTTP ${res.status} — ${detalle}`);
      registroIA.push(`${modelo}: ${res.status}`);
      // Errores que no se arreglan reintentando: se cortan acá.
      if (res.status === 400 && /api key/i.test(detalle)) throw new Error('la clave de Gemini no es válida.');
      if (res.status === 403) throw new Error('la clave de Gemini no tiene permiso (revisá restricciones de la clave).');

      if (res.status === 429) {
        // Cuota agotada: esperar poco sirve, mejor pasar directo al siguiente modelo.
        ultimoError = 'se alcanzó el límite gratuito por ahora, probá en un minuto.';
        continue modelos;
      }
      if (res.status === 503 || res.status === 500 || res.status === 504) {
        // Saturado / error temporal: reintento con espera creciente (+ azar para no chocar con otros usuarios).
        ultimoError = 'los servidores de la IA están con mucha demanda, probá de nuevo en un rato.';
        if (intento < GEMINI_REINTENTOS) {
          if (statusEl) statusEl.textContent = `IA con mucha demanda, reintentando (${intento}/${GEMINI_REINTENTOS - 1})…`;
          await esperar(GEMINI_ESPERA_BASE_MS * 2 ** (intento - 1) + Math.random() * 500);
          continue;
        }
        if (m < GEMINI_MODELOS.length - 1 && statusEl) statusEl.textContent = 'Probando con otro modelo de IA…';
        continue modelos;
      }
      // Modelo inexistente u otro error: se prueba el siguiente modelo.
      ultimoError = detalle || `Gemini respondió ${res.status}`;
      continue modelos;
    }
  }
  if (!data) {
    // Se muestra qué respondió cada modelo (ej: "gemini-3.8-flash: 503") para saber dónde falla.
    const resumen = [...new Set(registroIA)].join(' · ');
    throw new Error(ultimoError + (resumen ? ` [${resumen}]` : ''));
  }
  const texto = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  const ini = texto.indexOf('{');
  const fin = texto.lastIndexOf('}');
  if (ini === -1 || fin <= ini) throw new Error('la IA no devolvió datos legibles, probá con otras fotos.');
  let obj;
  try {
    obj = JSON.parse(texto.slice(ini, fin + 1));
  } catch (e) {
    throw new Error('la IA no devolvió un JSON válido.');
  }
  return Array.isArray(obj.sesiones) ? obj.sesiones : [];
}

// Aplica al formulario de Train una sesión devuelta por la IA.
function aplicarDatosIA(obj) {
  limpiarAutoTotales();
  ['f-meters', 'f-totaltime', 'f-split', 'f-spm'].forEach((id) => { $(id).value = ''; });
  setIncompleto(false);
  if (obj.date && /^\d{4}-\d{2}-\d{2}$/.test(obj.date)) $('f-date').value = obj.date;
  if (obj.type) $('f-type').value = obj.type;
  if (obj.meters !== undefined && obj.meters !== null) $('f-meters').value = obj.meters;
  if (obj.split) $('f-split').value = obj.split;
  if (obj.totaltime) $('f-totaltime').value = obj.totaltime;
  if (obj.spm !== undefined && obj.spm !== null) $('f-spm').value = obj.spm;
  limpiarParciales();
  (obj.parciales || []).slice(0, N_PARCIALES_MAX).forEach((p) => addParcialRow(p));
  if (!$('parciales-container').children.length) addParcialRow();
  autoTotalesForm();
  zonaManual = false;
  autoZona();
}

// Convierte una sesión de la IA en el registro de la tabla `entrenamientos`.
function registroDesdeIA(obj) {
  const parciales = (obj.parciales || []).slice(0, N_PARCIALES_MAX);
  const tramos = {};
  for (let i = 1; i <= N_PARCIALES_MAX; i++) tramos[`tramo_${i}`] = null;
  let sumM = 0, sumS = 0, spmSum = 0, spmN = 0;
  parciales.forEach((p, i) => {
    const tiempo = normTiempo(p.tiempo);
    const metros = p.metros != null ? Number(p.metros) : null;
    let pace = normTiempo(p.pace);
    const seg = parseTiempoASegundos(tiempo);
    if (!pace && seg && metros > 0) pace = segundosATiempo((seg / metros) * 500);
    if (!tiempo && !metros && !pace && p.spm == null) return;
    tramos[`tramo_${i + 1}`] = { tiempo, metros, pace, spm: p.spm != null ? Number(p.spm) : null };
    if (metros > 0) sumM += metros;
    if (seg) sumS += seg;
    if (p.spm > 0) { spmSum += Number(p.spm); spmN++; }
  });
  const metros = obj.meters != null ? Number(obj.meters) : (sumM || null);
  let tiempoSeg = parseTiempoASegundos(obj.totaltime);
  if (tiempoSeg === null && sumS) tiempoSeg = sumS;
  let pace = normTiempo(obj.split);
  if (!pace && metros && tiempoSeg) pace = segundosATiempo((tiempoSeg / metros) * 500);
  const spm = obj.spm != null ? Number(obj.spm) : (spmN ? Math.round(spmSum / spmN) : null);
  const tipo = (obj.type || '').trim() || (metros ? `${metros}m` : 'Sesión');
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(obj.date || '') ? obj.date : hoyISO();
  const zona = zonaDeDatos({ tipo, spm, metros, n: parciales.length }) || 'z1';
  return {
    usuario_id: currentUser.id,
    fecha,
    tipo,
    categoria: zona,
    medio: 'ergo',
    bote: null,
    porcentaje: null,
    completado: true,
    distancia_metros: metros,
    tiempo_segundos: tiempoSeg,
    pace_500m: pace,
    spm_general: spm,
    ...tramos,
  };
}

// Varias sesiones detectadas en las fotos: se guardan todas directamente.
async function guardarSesionesIA(sesiones) {
  if (!currentUser) { toast('Iniciá sesión primero.'); return; }
  const registros = sesiones.map(registroDesdeIA);
  const { error, aviso } = await guardarConRespaldo((r) => sb.from('entrenamientos').insert(r), registros);
  if (error) throw new Error('error al guardar: ' + error.message);
  toast(`${registros.length} sesiones guardadas desde las fotos.${aviso}`);
  await cargarEntrenamientos();
}

/* ---------------- Train: guardar / editar sesión ---------------- */

function resetTrainForm() {
  $('f-type').value = '';
  $('f-boat').value = 'Single';
  $('f-percentage').value = '';
  $('f-meters').value = '';
  $('f-totaltime').value = '';
  $('f-split').value = '';
  $('f-spm').value = '';
  limpiarAutoTotales();
  setIncompleto(false);
  $('f-medium').value = 'ergo';
  zonaManual = false;
  setCategoria('z1');
  toggleWaterOptions();
  limpiarParciales();
  addParcialRow();
  $('f-date').value = hoyISO();
}

function cancelEdit() {
  editingSessionId = null;
  $('edit-banner').style.display = 'none';
  resetTrainForm();
}

async function addSession() {
  if (!currentUser) { toast('Iniciá sesión primero.'); return; }
  if (!$('f-date').value) { toast('Falta la fecha.'); return; }
  if (!$('f-type').value.trim()) { toast('Falta el nombre del trabajo (ej: 6x8:00).'); return; }

  autoZona();
  const esAgua = $('f-medium').value === 'agua';
  const tot = calcularTotales();
  const tramos = collectParciales();

  const metros = $('f-meters').value ? Number($('f-meters').value) : (tot.metros || null);
  let tiempoSeg = parseTiempoASegundos($('f-totaltime').value);
  if (tiempoSeg === null && tot.segundos) tiempoSeg = tot.segundos;
  let pace = normTiempo($('f-split').value);
  if (!pace && metros && tiempoSeg) pace = segundosATiempo((tiempoSeg / metros) * 500);
  const spm = $('f-spm').value ? Number($('f-spm').value) : tot.spm;

  const registro = {
    usuario_id: currentUser.id,
    fecha: $('f-date').value,
    tipo: $('f-type').value.trim(),
    categoria: $('f-cat').value,
    medio: $('f-medium').value,
    bote: esAgua ? $('f-boat').value : null,
    porcentaje: esAgua ? leerPorcentaje() : null,
    completado: !esIncompleto(),
    distancia_metros: metros,
    tiempo_segundos: tiempoSeg,
    pace_500m: pace,
    spm_general: spm,
    ...tramos,
  };

  const btn = $('btn-add-session');
  btn.disabled = true;
  const eraEdicion = !!editingSessionId;
  const idEdicion = editingSessionId;
  const { error, aviso } = await guardarConRespaldo(
    (r) => (eraEdicion
      ? sb.from('entrenamientos').update(r).eq('id', idEdicion)
      : sb.from('entrenamientos').insert(r)),
    registro,
  );
  btn.disabled = false;

  if (error) {
    toast('Error al guardar: ' + error.message);
    return;
  }
  toast((eraEdicion ? 'Sesión actualizada.' : 'Entrenamiento guardado.') + aviso);
  cancelEdit();
  await cargarEntrenamientos();
  if (eraEdicion) navigateTo('historial', 'historial', $('nav-historial'));
}

function editSession(id) {
  const e = entrenamientosCache.find((x) => x.id === id);
  if (!e) return;
  editingSessionId = id;
  $('edit-banner').style.display = 'flex';
  $('f-date').value = e.fecha;
  $('f-type').value = e.tipo || '';
  zonaManual = true; // se respeta la zona guardada
  setCategoria((e.categoria || 'z1').toLowerCase());
  $('f-medium').value = e.medio || 'ergo';
  toggleWaterOptions();
  $('f-boat').value = e.bote || 'Single';
  $('f-percentage').value = e.porcentaje ?? '';
  $('f-meters').value = e.distancia_metros ?? '';
  $('f-totaltime').value = e.tiempo_segundos != null ? segundosATiempo(e.tiempo_segundos) : '';
  $('f-split').value = e.pace_500m || '';
  $('f-spm').value = e.spm_general ?? '';
  limpiarAutoTotales();
  setIncompleto(e.completado === false);
  limpiarParciales();
  parcialesDesdeEntreno(e).forEach((p) => addParcialRow(p));
  if (!$('parciales-container').children.length) addParcialRow();
  navigateTo('train', 'train', $('nav-train'));
}

/* ---------------- Cargar entrenamientos ---------------- */

async function cargarEntrenamientos() {
  if (!currentUser || !sb) return;
  const { data, error } = await sb
    .from('entrenamientos')
    .select('*')
    .eq('usuario_id', currentUser.id)
    .order('fecha', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) {
    toast('Error al cargar entrenamientos: ' + error.message);
    if ($('db-status')) $('db-status').textContent = 'No se pudieron cargar las sesiones.';
    return;
  }
  entrenamientosCache = data || [];
  if ($('db-status')) {
    const n = entrenamientosCache.length;
    $('db-status').textContent = `${n} sesión${n === 1 ? '' : 'es'} guardada${n === 1 ? '' : 's'}.`;
  }
  poblarFiltroTipos();
  renderHome();
  renderHistorial();
}

/* ---------------- Home ---------------- */

function setAvatarInitials(email) {
  const user = (email || '').split('@')[0];
  const partes = user.split(/[._-]/).filter(Boolean);
  const iniciales = partes.length >= 2 ? partes[0][0] + partes[1][0] : user.slice(0, 2);
  document.querySelectorAll('.avatarCircle').forEach((el) => {
    el.textContent = iniciales.toUpperCase() || '--';
  });
}

function renderHome() {
  // Los trabajos en agua van aparte: no entran en los gráficos de zona ni de 2K (el de agua es solo 2K).
  renderChart(chartSesiones((e) => esErgo(e) && catDe(e) === 'z1'), 'chart-z1', 'chart-z1-best', 'pace');
  renderChart(chartSesiones((e) => esErgo(e) && catDe(e) === 'z2'), 'chart-z2', 'chart-z2-best', 'pace');
  renderChart(chartSesiones(es2K), 'chart-2k', 'chart-2k-best', 'tiempo');
  renderChart(chartSesiones(es2KAgua), 'chart-agua', 'chart-agua-best', 'tiempo');
  renderRaceCard();
  renderWeekBadge();
  renderLastSessionCard();
}

function catDe(e) { return (e.categoria || '').toLowerCase(); }
function esErgo(e) { return e.medio !== 'agua'; }
// 2K = test de 2000 m en ergómetro (por categoría test o por distancia exacta).
function es2K(e) {
  return esErgo(e) && Number(e.distancia_metros) === 2000 && (catDe(e) === 'test' || /2\s*k|2000/i.test(e.tipo || ''));
}

// 2K en agua: lo que importa es el tiempo total. Se acepta una pequeña tolerancia en los metros.
function es2KAgua(e) {
  if (e.medio !== 'agua') return false;
  const m = Number(e.distancia_metros);
  if (m >= 1900 && m <= 2100) return true;
  return /^\s*(2\s*k|2000\s*m?)\s*$/i.test(e.tipo || '');
}

/* ---------------- Tipo de trabajo (20 min, 3000 m, 6x8:00…) ---------------- */

function numTxt(s) { return Number(String(s).replace(',', '.')); }

// Lee el texto libre de "tipo" y lo normaliza para poder agrupar y filtrar.
// Devuelve { key, label, grupo: 'min' | 'm' | 'int' | 'otro', valor } o null si no hay tipo.
function trabajoDe(e) {
  const raw = String(e.tipo || '').trim();
  const t = raw.toLowerCase().replace(/\s+/g, ' ');
  if (!t || t === 'sesión' || t === 'sesion') return null;

  // Intervalos: 6x8:00 · 6x8min · 4x500m · 3x2k
  let m = t.match(/(\d+)\s*[x×]\s*(\d+(?::\d{2})?(?:[.,]\d+)?)\s*(min|mins|minutos|minuto|'|′|km|k|mts|metros|m)?(?![a-z])/);
  if (m) {
    const v = m[2];
    const u = m[3] || '';
    let resto;
    if (v.includes(':')) resto = v.replace(/^0+(?=\d)/, '');
    else {
      const n = numTxt(v);
      if (/^(min|mins|minutos|minuto|'|′)$/.test(u)) resto = `${n}:00`;
      else if (/^(km|k)$/.test(u)) resto = `${n * 1000}m`;
      else if (/^(m|mts|metros)$/.test(u)) resto = `${n}m`;
      else resto = n >= 100 ? `${n}m` : `${n}:00`;
    }
    const label = `${Number(m[1])}x${resto}`;
    return { key: 'int:' + label, label, grupo: 'int', valor: 0 };
  }
  // Por duración: 20 min · 30' · 20:00
  m = t.match(/(\d+(?:[.,]\d+)?)\s*(min|mins|minutos|minuto|'|′)(?![a-z])/) || t.match(/^(\d{1,3}):00$/);
  if (m) {
    const v = numTxt(m[1]);
    return { key: 'min:' + v, label: `${v} min`, grupo: 'min', valor: v };
  }
  // Por distancia: 3000m · 3000 · 5k · 6km
  m = t.match(/(\d+(?:[.,]\d+)?)\s*(km|k)(?![a-z])/);
  if (m) {
    const mt = Math.round(numTxt(m[1]) * 1000);
    return { key: 'm:' + mt, label: `${mt} m`, grupo: 'm', valor: mt };
  }
  m = t.match(/(\d{3,5})\s*(?:m|mts|metros)?(?![a-z\d])/);
  if (m) {
    const mt = Number(m[1]);
    return { key: 'm:' + mt, label: `${mt} m`, grupo: 'm', valor: mt };
  }
  return { key: 'otro:' + t, label: raw.toUpperCase(), grupo: 'otro', valor: 0 };
}

// Tipos de trabajo distintos que hay cargados, ordenados: duración, distancia, intervalos, otros.
function listaTrabajos() {
  const mapa = new Map();
  entrenamientosCache.forEach((e) => {
    const w = trabajoDe(e);
    if (w && !mapa.has(w.key)) mapa.set(w.key, w);
  });
  const orden = { min: 0, m: 1, int: 2, otro: 3 };
  return [...mapa.values()].sort((a, b) =>
    orden[a.grupo] - orden[b.grupo] || a.valor - b.valor || a.label.localeCompare(b.label, 'es', { numeric: true }));
}

/* ---------------- Gráfico de líneas (Sesiones) ---------------- */

const GRAFICO_W = 340;
const GRAFICO_H = 170;

// Qué sesiones entran y qué se mide: tiempo total (pruebas de distancia fija) o /500m.
function defGrafico(v) {
  v = v || 'all';
  if (v === 'k2') return { filtro: es2K, modo: 'tiempo', nombre: '2K ergómetro' };
  if (v === 'k2agua') return { filtro: es2KAgua, modo: 'tiempo', nombre: '2K agua' };
  if (v === 'agua') return { filtro: (e) => e.medio === 'agua', modo: 'pace', nombre: 'Agua' };
  if (v.startsWith('zona:')) {
    const z = v.slice(5);
    return { filtro: (e) => esErgo(e) && catDe(e) === z, modo: 'pace', nombre: CAT_NOMBRE[z] || z };
  }
  if (v.startsWith('trabajo:')) {
    const k = v.slice(8);
    const w = listaTrabajos().find((x) => x.key === k);
    return {
      filtro: (e) => { const t = trabajoDe(e); return !!t && t.key === k; },
      modo: w && w.grupo === 'm' ? 'tiempo' : 'pace',
      nombre: w ? w.label : k,
    };
  }
  return { filtro: () => true, modo: 'pace', nombre: 'Todos los trabajos' };
}

function poblarSelectorGrafico() {
  const sel = $('hist-chart-select');
  if (!sel) return;
  const zonas = CATEGORIAS.filter((c) => entrenamientosCache.some((e) => esErgo(e) && catDe(e) === c));
  const pruebas = [];
  if (entrenamientosCache.some(es2K)) pruebas.push('<option value="k2">2K ergómetro</option>');
  if (entrenamientosCache.some(es2KAgua)) pruebas.push('<option value="k2agua">2K agua</option>');
  if (entrenamientosCache.some((e) => e.medio === 'agua')) pruebas.push('<option value="agua">Agua (todos)</option>');
  const trabajos = listaTrabajos();
  sel.innerHTML = '<option value="all">Todos los trabajos</option>' +
    (zonas.length ? '<optgroup label="Zona">' + zonas.map((z) => `<option value="zona:${z}">${esc(CAT_NOMBRE[z])}</option>`).join('') + '</optgroup>' : '') +
    (pruebas.length ? '<optgroup label="Pruebas">' + pruebas.join('') + '</optgroup>' : '') +
    (trabajos.length ? '<optgroup label="Tipo de trabajo">' + trabajos.map((w) => `<option value="trabajo:${esc(w.key)}">${esc(w.label)}</option>`).join('') + '</optgroup>' : '');
  if (![...sel.options].some((o) => o.value === chartFilterValue)) chartFilterValue = 'all';
  sel.value = chartFilterValue;
}

function setChartFilter(value) {
  chartFilterValue = value || 'all';
  renderGraficoSesiones();
}

function renderGraficoSesiones() {
  const cont = $('hist-chart');
  if (!cont) return;
  const bestEl = $('hist-chart-best');
  const labelEl = $('hist-chart-label');
  const def = defGrafico(chartFilterValue);
  if (labelEl) labelEl.textContent = def.nombre;

  const desde = $('hist-date-from') ? $('hist-date-from').value : '';
  const hasta = $('hist-date-to') ? $('hist-date-to').value : '';
  const valor = def.modo === 'tiempo' ? tiempoDeSesion : paceDeSesion;
  const unidad = def.modo === 'tiempo' ? '' : '/500m';

  const ses = entrenamientosCache
    .filter(def.filtro)
    .filter((e) => (!desde || e.fecha >= desde) && (!hasta || e.fecha <= hasta))
    .filter((e) => valor(e) !== null)
    .slice().reverse()
    .sort((a, b) => a.fecha.localeCompare(b.fecha))
    .slice(-30);

  cont.innerHTML = '';
  if (!ses.length) {
    cont.innerHTML = '<div class="empty">Sin sesiones para este trabajo</div>';
    if (bestEl) bestEl.textContent = '--';
    return;
  }

  const vals = ses.map(valor);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const completas = vals.filter((_, i) => ses[i].completado !== false);
  const mejor = completas.length ? Math.min(...completas) : min;
  const mejorTexto = 'Mejor ' + conComa(segundosATiempo(mejor));
  if (bestEl) bestEl.textContent = mejorTexto;

  const W = GRAFICO_W, H = GRAFICO_H, pl = 46, pr = 12, pt = 14, pb = 26;
  const rango = max - min;
  const lo = rango ? min - rango * 0.12 : min - 1;
  const hi = rango ? max + rango * 0.12 : max + 1;
  // Lo más rápido (menor valor) queda arriba, igual que las barras del Resumen.
  const yDe = (v) => pt + ((v - lo) / (hi - lo)) * (H - pt - pb);
  const xDe = (i) => (ses.length === 1 ? pl + (W - pl - pr) / 2 : pl + (i * (W - pl - pr)) / (ses.length - 1));

  let grid = '';
  for (let k = 0; k < 3; k++) {
    const v = lo + ((hi - lo) * k) / 2;
    const y = yDe(v).toFixed(1);
    grid += `<line class="lc-grid" x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}"/>` +
            `<text class="lc-ylab" x="${pl - 6}" y="${(+y + 3).toFixed(1)}" text-anchor="end">${esc(conComa(segundosATiempo(v)))}</text>`;
  }
  const path = ses.map((e, i) => `${i ? 'L' : 'M'}${xDe(i).toFixed(1)},${yDe(vals[i]).toFixed(1)}`).join(' ');
  const r = ses.length > 20 ? 3 : 4.5;
  const puntos = ses.map((e, i) => {
    const incompleta = e.completado === false;
    const mejorPunto = vals[i] === mejor && !incompleta;
    const cx = xDe(i).toFixed(1), cy = yDe(vals[i]).toFixed(1);
    const tip = `${fechaLegible(e.fecha)} — ${conComa(segundosATiempo(vals[i]))}${unidad}`;
    return `<circle class="lc-dot${mejorPunto ? ' best' : ''}${incompleta ? ' incompleto' : ''}" data-i="${i}" cx="${cx}" cy="${cy}" r="${r}"><title>${esc(tip)}</title></circle>` +
           `<circle class="lc-hit" data-i="${i}" cx="${cx}" cy="${cy}" r="12"/>`;
  }).join('');
  const xl = `<text class="lc-xlab" x="${pl}" y="${H - 6}" text-anchor="start">${esc(fechaCorta(ses[0].fecha))}</text>` +
    (ses.length > 1 ? `<text class="lc-xlab" x="${W - pr}" y="${H - 6}" text-anchor="end">${esc(fechaCorta(ses[ses.length - 1].fecha))}</text>` : '');

  cont.innerHTML = `<svg class="lineChartSvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución de ${esc(def.nombre)}">${grid}<path class="lc-line" d="${path}"/>${puntos}${xl}</svg>`;

  // Tocá un punto para ver su fecha y valor; tocalo de nuevo para volver al mejor.
  cont.querySelectorAll('.lc-hit').forEach((h) => {
    h.addEventListener('click', () => {
      const i = Number(h.dataset.i);
      const dot = cont.querySelector(`.lc-dot[data-i="${i}"]`);
      const ya = dot.classList.contains('sel');
      cont.querySelectorAll('.lc-dot').forEach((d) => d.classList.remove('sel'));
      if (ya) { if (bestEl) bestEl.textContent = mejorTexto; return; }
      dot.classList.add('sel');
      if (bestEl) bestEl.textContent = `${fechaCorta(ses[i].fecha)} · ${conComa(segundosATiempo(vals[i]))}`;
    });
  });
}

function paceDeSesion(e) {
  if (e.pace_500m) {
    const p = parseTiempoASegundos(e.pace_500m);
    if (p !== null) return p;
  }
  if (e.tiempo_segundos && e.distancia_metros) return (e.tiempo_segundos / e.distancia_metros) * 500;
  return null;
}

// Tiempo total del 2K (si no está guardado, se deduce del /500m).
function tiempoDeSesion(e) {
  if (e.tiempo_segundos) return Number(e.tiempo_segundos);
  const p = paceDeSesion(e);
  return p !== null && e.distancia_metros ? p * Number(e.distancia_metros) / 500 : null;
}

function chartSesiones(filtro) {
  return entrenamientosCache.filter(filtro).slice().sort((a, b) => a.fecha.localeCompare(b.fecha)).slice(-20);
}

// Barras: la más alta es la más rápida (menor valor). Tocá una barra para ver su fecha y valor.
// modo 'pace' → /500m · modo 'tiempo' → tiempo total (2K).
function renderChart(lista, contId, bestId, modo) {
  const cont = $(contId);
  const bestEl = $(bestId);
  if (!cont) return;
  const valor = modo === 'tiempo' ? tiempoDeSesion : paceDeSesion;
  const sesiones = lista.filter((e) => valor(e) !== null);

  cont.innerHTML = '';
  if (!sesiones.length) {
    cont.innerHTML = '<div class="empty">Sin sesiones todavía</div>';
    if (bestEl) bestEl.textContent = '--';
    return;
  }

  const vals = sesiones.map(valor);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  // El "mejor" ignora los trabajos que no se completaron (salvo que sean los únicos).
  const completas = vals.filter((_, i) => sesiones[i].completado !== false);
  const mejor = completas.length ? Math.min(...completas) : min;
  const mejorTexto = 'Mejor ' + conComa(segundosATiempo(mejor));
  if (bestEl) bestEl.textContent = mejorTexto;

  sesiones.forEach((e, i) => {
    const p = vals[i];
    const alto = max === min ? 60 : 22 + 78 * ((max - p) / (max - min));
    const incompleta = e.completado === false;
    const bar = document.createElement('div');
    bar.className = 'bar' + (p === mejor && !incompleta ? ' best' : '') + (incompleta ? ' incompleto' : '');
    bar.style.height = alto.toFixed(0) + '%';
    bar.title = `${fechaLegible(e.fecha)} — ${conComa(segundosATiempo(p))}${modo === 'tiempo' ? '' : '/500m'}`;
    bar.addEventListener('click', () => {
      const ya = bar.classList.contains('sel');
      cont.querySelectorAll('.bar').forEach((b) => b.classList.remove('sel'));
      if (ya) {
        if (bestEl) bestEl.textContent = mejorTexto;
        return;
      }
      bar.classList.add('sel');
      if (bestEl) bestEl.textContent = `${fechaCorta(e.fecha)} · ${conComa(segundosATiempo(p))}`;
    });
    cont.appendChild(bar);
  });
}

function renderRaceCard() {
  const hoy = hoyISO();
  const proxima = getRaces().filter((r) => r.fecha >= hoy).sort((a, b) => a.fecha.localeCompare(b.fecha))[0];
  if (!proxima) {
    $('race-card-name').textContent = 'Sin regatas';
    $('race-card-days').textContent = '--';
    $('race-card-date').innerHTML = '&nbsp;';
    return;
  }
  const dias = diasEntre(hoy, proxima.fecha);
  $('race-card-name').textContent = proxima.nombre;
  $('race-card-days').innerHTML = dias === 0 ? 'Hoy' : `${dias}<small>${dias === 1 ? 'día' : 'días'}</small>`;
  $('race-card-date').textContent = fechaLegible(proxima.fecha);
}

function getLoadStart() {
  return inicioBloque;
}

function renderWeekBadge() {
  const inicio = getLoadStart();
  if (!inicio) { $('week-badge-num').textContent = '--'; return; }
  const dias = diasEntre(inicio, hoyISO());
  $('week-badge-num').textContent = dias < 0 ? '--' : Math.floor(dias / 7) + 1;
}

function renderLastSessionCard() {
  const circle = $('last-session-cat');
  const ultima = entrenamientosCache[0];
  if (!ultima) {
    circle.textContent = '--';
    circle.className = 'cat-circle';
    $('last-session-desc').textContent = 'Sin sesiones todavía';
    $('last-session-meta').textContent = 'Cargá tu primer entreno en Train';
    document.querySelector('.lastSessionCard').classList.remove('agua', 'incompleto');
    $('last-session-time').textContent = '--:--';
    $('last-session-delta').textContent = '';
    return;
  }
  const cat = (ultima.categoria || '').toLowerCase();
  circle.textContent = CAT_LABEL[cat] || '--';
  circle.className = 'cat-circle z-' + cat;
  $('last-session-desc').textContent = ultima.tipo || '';
  const esAgua = ultima.medio === 'agua';
  const incompletaUlt = ultima.completado === false;
  document.querySelector('.lastSessionCard').classList.toggle('agua', esAgua);
  document.querySelector('.lastSessionCard').classList.toggle('incompleto', incompletaUlt);
  $('last-session-meta').innerHTML = esc(`${nombreDia(ultima.fecha)} ${fechaCorta(ultima.fecha)}`) +
    (esAgua ? ` <span class="waterTag">≈ AGUA${ultima.bote ? ' · ' + esc(ultima.bote) : ''}</span>` : '') +
    (incompletaUlt ? ' <span class="incTag">NO COMPLETADO</span>' : '');
  const paceUltima = paceDeSesion(ultima);
  $('last-session-time').textContent = paceUltima !== null ? conComa(segundosATiempo(paceUltima)) : '--:--';

  const deltaEl = $('last-session-delta');
  deltaEl.textContent = '';
  deltaEl.className = 'lastSessionDelta';
  const anterior = entrenamientosCache
    .slice(1)
    .find((e) => (e.categoria || '').toLowerCase() === cat && esAgua === (e.medio === 'agua') && paceDeSesion(e) !== null);
  if (!anterior || paceUltima === null) return;
  // Menor /500m = más rápido: ↓ verde es mejorar, ↑ rojo es empeorar.
  const delta = paceUltima - paceDeSesion(anterior);
  if (Math.abs(delta) < 0.05) return;
  deltaEl.textContent = `${conComa(segundosATiempo(Math.abs(delta)))} ${delta > 0 ? '↑' : '↓'}`;
  deltaEl.className = 'lastSessionDelta ' + (delta > 0 ? 'up' : 'down');
}

/* ---------------- Sesiones (agrupadas por semana) ---------------- */

function poblarFiltroTipos() {
  const sel = $('table-filter-select');
  if (!sel) return;
  // Las zonas filtran solo ergómetro; "Agua" es un filtro aparte.
  const tipos = CATEGORIAS.filter((c) => entrenamientosCache.some((e) => esErgo(e) && catDe(e) === c));
  const hayAgua = entrenamientosCache.some((e) => e.medio === 'agua');
  const opciones = [...tipos, ...(hayAgua ? ['agua'] : [])];
  const actual = tableFilterValue;
  sel.innerHTML = '<option value="">Todas</option>' +
    tipos.map((t) => `<option value="${t}">${CAT_NOMBRE[t]}</option>`).join('') +
    (hayAgua ? '<option value="agua">Agua</option>' : '');
  sel.value = opciones.includes(actual) ? actual : '';
  tableFilterValue = sel.value;
  poblarFiltroTrabajo();
  poblarSelectorGrafico();
}

// Filtro por tipo de trabajo: se arma con los tipos que ya cargaste.
function poblarFiltroTrabajo() {
  const sel = $('trabajo-filter-select');
  if (!sel) return;
  const trabajos = listaTrabajos();
  sel.innerHTML = '<option value="">Todos</option>' +
    trabajos.map((w) => `<option value="${esc(w.key)}">${esc(w.label)}</option>`).join('');
  if (!trabajos.some((w) => w.key === trabajoFilterValue)) trabajoFilterValue = '';
  sel.value = trabajoFilterValue;
}

function setTableFilter(value) {
  tableFilterValue = value;
  renderHistorial();
}

function setTrabajoFilter(value) {
  trabajoFilterValue = value;
  renderHistorial();
}

function setDateFilter() {
  renderHistorial();
}

function clearHistFilters() {
  tableFilterValue = '';
  trabajoFilterValue = '';
  $('table-filter-select').value = '';
  if ($('trabajo-filter-select')) $('trabajo-filter-select').value = '';
  $('hist-date-from').value = '';
  $('hist-date-to').value = '';
  renderHistorial();
}

function toggleHistFilters() {
  const panel = $('hist-filters');
  const abierto = panel.style.display !== 'none';
  panel.style.display = abierto ? 'none' : '';
  $('hist-filter-btn').classList.toggle('on', !abierto);
}

// Devuelve a qué semana pertenece una fecha: relativa al bloque de carga si está
// configurado (Semana 1, 2, 3…), o "Semana del dd/mm" (lunes) si no lo está.
function semanaDe(fechaISO) {
  const inicio = getLoadStart();
  if (inicio) {
    const d = diasEntre(inicio, fechaISO);
    if (d < 0) return { key: 'pre', label: 'Antes del bloque' };
    const n = Math.floor(d / 7) + 1;
    return { key: 'w' + n, label: 'Semana ' + n };
  }
  const f = fechaDesdeISO(fechaISO);
  const lunes = new Date(f.getFullYear(), f.getMonth(), f.getDate() - ((f.getDay() + 6) % 7));
  return { key: isoDeFecha(lunes), label: 'Semana del ' + fechaCorta(isoDeFecha(lunes)) };
}

function renderHistorial() {
  const cont = $('rows');
  if (!cont) return;
  const desde = $('hist-date-from').value;
  const hasta = $('hist-date-to').value;
  renderGraficoSesiones();

  let lista = entrenamientosCache.slice();
  if (desde) lista = lista.filter((e) => e.fecha >= desde);
  if (hasta) lista = lista.filter((e) => e.fecha <= hasta);
  if (tableFilterValue === 'agua') lista = lista.filter((e) => e.medio === 'agua');
  else if (tableFilterValue) lista = lista.filter((e) => esErgo(e) && (e.categoria || '').toLowerCase() === tableFilterValue);
  if (trabajoFilterValue) lista = lista.filter((e) => { const w = trabajoDe(e); return !!w && w.key === trabajoFilterValue; });

  $('result-count').textContent = entrenamientosCache.length
    ? `${lista.length} sesión${lista.length === 1 ? '' : 'es'}`
    : '';

  cont.innerHTML = '';
  if (!lista.length) {
    cont.innerHTML = entrenamientosCache.length
      ? '<p class="emptyMsg">No hay sesiones para este filtro.</p>'
      : '<p class="emptyMsg">Todavía no cargaste sesiones.<br>Tocá Train para guardar la primera.</p>';
    return;
  }

  // Semanas de la más reciente a la más vieja (la lista ya viene ordenada por fecha desc).
  const grupos = new Map();
  lista.forEach((e) => {
    const s = semanaDe(e.fecha);
    if (!grupos.has(s.key)) grupos.set(s.key, { label: s.label, items: [] });
    grupos.get(s.key).items.push(e);
  });

  grupos.forEach((g) => {
    const bloque = document.createElement('div');
    bloque.className = 'week-group';
    bloque.innerHTML = `<h3 class="week-label">${esc(g.label)}</h3>`;
    // Dentro de cada semana, de la más reciente a la más antigua (igual que las semanas).
    g.items.forEach((e) => bloque.appendChild(crearTarjetaSesion(e)));
    cont.appendChild(bloque);
  });
}

function etiquetaCirculo(e) {
  const cat = (e.categoria || '').toLowerCase();
  if (cat === 'test' && Number(e.distancia_metros) === 2000) return '2K';
  return CAT_LABEL[cat] || '--';
}

function crearTarjetaSesion(e) {
  const cat = (e.categoria || '').toLowerCase();
  const pace = paceDeSesion(e);
  const item = document.createElement('div');
  const esAgua = e.medio === 'agua';
  const incompleto = e.completado === false;
  // En agua y en 2K lo que importa es el tiempo total: va como título (el /500m queda a la derecha).
  const totalSeg = tiempoDeSesion(e);
  const mostrarTotal = (esAgua || es2K(e)) && totalSeg !== null;
  item.className = 'session-item' + (esAgua ? ' agua' : '') + (incompleto ? ' incompleto' : '') + (mostrarTotal ? ' totalTitle' : '');

  const parciales = parcialesDesdeEntreno(e);
  const tablaParciales = parciales.length ? `
    <div class="sd-table">
      <div class="sd-row sd-head"><span>#</span><span>Tiempo</span><span>Metros</span><span>/500m</span><span>SPM</span></div>
      ${parciales.map((p, i) => `
        <div class="sd-row">
          <span>${i + 1}</span>
          <span>${esc(conComa(p.tiempo)) || '–'}</span>
          <span>${p.metros != null ? esc(p.metros) + 'm' : '–'}</span>
          <span>${esc(conComa(p.pace)) || '–'}</span>
          <span>${p.spm != null ? esc(p.spm) : '–'}</span>
        </div>`).join('')}
    </div>` : '';

  const datos = [
    ['Fecha', fechaLegible(e.fecha)],
    ['Medio', e.medio === 'agua' ? 'Agua' + (e.bote ? ' · ' + e.bote : '') : 'Ergómetro'],
    e.distancia_metros ? ['Metros', e.distancia_metros + 'm'] : null,
    e.tiempo_segundos != null ? ['Tiempo', segundosATiempo(e.tiempo_segundos)] : null,
    e.spm_general != null ? ['SPM', e.spm_general] : null,
    e.porcentaje != null ? ['%', conComa(e.porcentaje) + '%'] : null,
    incompleto ? ['Estado', 'No completado'] : null,
  ].filter(Boolean);

  item.innerHTML = `
    <div class="session-mini-card glass-card">
      <div class="cat-circle z-${esc(cat)}">${esc(etiquetaCirculo(e))}</div>
      <div class="session-main">
        <div class="session-title">${esc(mostrarTotal ? conComa(segundosATiempo(totalSeg)) : (e.tipo || ''))}</div>
        ${mostrarTotal && e.tipo ? `<div class="session-sub">${esc(e.tipo)}</div>` : ''}
        ${(esAgua || incompleto) ? `<div class="tagRow">
          ${esAgua ? `<span class="waterTag">≈ AGUA${e.bote ? ' · ' + esc(e.bote) : ''}</span>` : ''}
          ${incompleto ? '<span class="incTag">NO COMPLETADO</span>' : ''}
        </div>` : ''}
      </div>
      <div class="session-stats">
        <div class="split">${pace !== null ? esc(conComa(segundosATiempo(pace))) : '--:--'}</div>
        <div class="day">${esc(nombreDia(e.fecha))}</div>
      </div>
    </div>
    <div class="session-detail">
      <div class="sd-grid">
        ${datos.map(([k, v]) => `<div><span class="sd-k">${esc(k)}</span><span class="sd-v">${esc(v)}</span></div>`).join('')}
      </div>
      ${tablaParciales}
      <div class="sd-actions">
        <button type="button" class="sd-btn" data-act="edit">Editar</button>
        <button type="button" class="sd-btn danger" data-act="del">Eliminar</button>
      </div>
    </div>`;

  item.querySelector('.session-mini-card').addEventListener('click', () => item.classList.toggle('open'));
  item.querySelector('[data-act="edit"]').addEventListener('click', () => editSession(e.id));
  item.querySelector('[data-act="del"]').addEventListener('click', () =>
    askDeleteSession(e.id, `${e.tipo} del ${fechaLegible(e.fecha)}`));
  return item;
}

/* ---------------- Eliminar sesión (modal) ---------------- */

function askDeleteSession(id, descripcion) {
  pendingDeleteId = id;
  $('delete-session-desc').textContent = descripcion || 'esta sesión';
  $('delete-confirm-input').value = '';
  $('delete-confirm-btn').disabled = true;
  $('delete-session-overlay').classList.add('show');
}

function cancelDeleteSession() {
  pendingDeleteId = null;
  $('delete-session-overlay').classList.remove('show');
}

function checkDeleteConfirmInput() {
  $('delete-confirm-btn').disabled = $('delete-confirm-input').value.trim().toUpperCase() !== 'ELIMINAR';
}

async function confirmDeleteSession() {
  if (!pendingDeleteId) return;
  const { error } = await sb.from('entrenamientos').delete().eq('id', pendingDeleteId);
  $('delete-session-overlay').classList.remove('show');
  if (error) { toast('Error al eliminar: ' + error.message); return; }
  toast('Sesión eliminada.');
  pendingDeleteId = null;
  await cargarEntrenamientos();
}

/* ---------------- Settings: exportar / importar / borrar ---------------- */

function nombreUsuario() {
  return currentUser ? currentUser.email.split('@')[0] : 'usuario';
}

function exportJSON() {
  if (!entrenamientosCache.length) { toast('No hay entrenamientos para exportar.'); return; }
  const blob = new Blob([JSON.stringify(entrenamientosCache, null, 2)], { type: 'application/json' });
  descargar(blob, `entrenamientos_${nombreUsuario()}.json`);
}

function exportCSV() {
  if (!entrenamientosCache.length) { toast('No hay entrenamientos para exportar.'); return; }
  const celda = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const cols = ['fecha', 'tipo', 'categoria', 'medio', 'bote', 'porcentaje', 'distancia_metros', 'tiempo_segundos', 'pace_500m', 'spm_general'];
  const header = [...cols, 'parciales'].join(',');
  const filas = entrenamientosCache.map((e) => {
    const parciales = parcialesDesdeEntreno(e)
      .map((p) => [p.tiempo, p.metros != null ? p.metros + 'm' : '', p.pace, p.spm != null ? p.spm + 'spm' : ''].filter(Boolean).join(' '))
      .join(' | ');
    return [...cols.map((c) => celda(e[c])), celda(parciales)].join(',');
  });
  const csv = '\uFEFF' + [header, ...filas].join('\n'); // BOM para que Excel lea bien los acentos
  descargar(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `entrenamientos_${nombreUsuario()}.csv`);
}

async function importJSON(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const arr = JSON.parse(await file.text());
    if (!Array.isArray(arr)) throw new Error('El archivo no tiene una lista de entrenamientos.');
    const registros = arr.map((e) => {
      const { id, created_at, usuario_id, ...resto } = e;
      return { ...resto, usuario_id: currentUser.id };
    });
    const { error } = await sb.from('entrenamientos').insert(registros);
    if (error) throw error;
    toast(`${registros.length} sesiones importadas.`);
    await cargarEntrenamientos();
  } catch (e) {
    toast('Error al importar: ' + e.message);
  } finally {
    event.target.value = '';
  }
}

function importRowCoachJSON(event) {
  event.target.value = '';
  toast('Importar backup RowCoach: todavía no implementado en esta etapa.');
}

function importExcel(event) {
  event.target.value = '';
  toast('Carga de Excel del entrenador: todavía no implementada en esta etapa.');
}

async function syncNow() {
  await cargarEntrenamientos();
  toast('Sincronizado con Supabase.');
}

function showClearConfirm() {
  $('clear-overlay').classList.add('show');
}

async function clearDB() {
  $('clear-overlay').classList.remove('show');
  if (!currentUser) return;
  const { error } = await sb.from('entrenamientos').delete().eq('usuario_id', currentUser.id);
  if (error) { toast('Error al borrar: ' + error.message); return; }
  toast('Todas tus sesiones fueron eliminadas.');
  await cargarEntrenamientos();
}

/* ---------------- Bloque de carga y regatas (Supabase) ----------------
   Tablas `configuracion` (inicio_bloque) y `regatas`. Crealas con supabase_regatas_config.sql */

function claveLocal(sufijo) {
  return `remo_${currentUser ? currentUser.id : 'anon'}_${sufijo}`;
}

function esErrorTablaFaltante(error) {
  return !!error && (error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache/i.test(error.message || ''));
}

function avisoTablasFaltantes() {
  configDBLista = false;
  const msg = 'Faltan las tablas "regatas" y "configuracion" en Supabase. Ejecutá supabase_regatas_config.sql en el SQL Editor.';
  if ($('races-status')) $('races-status').textContent = msg;
  if ($('dates-status')) $('dates-status').textContent = msg;
  toast('Faltan tablas en Supabase (ver Settings).');
}

async function cargarConfigDB() {
  if (!currentUser || !sb) return;
  const uid = currentUser.id;
  const [cfg, reg] = await Promise.all([
    sb.from('configuracion').select('inicio_bloque').eq('usuario_id', uid).maybeSingle(),
    sb.from('regatas').select('*').eq('usuario_id', uid).order('fecha', { ascending: true }),
  ]);
  if (esErrorTablaFaltante(cfg.error) || esErrorTablaFaltante(reg.error)) {
    renderConfig();
    avisoTablasFaltantes();
    return;
  }
  const err = cfg.error || reg.error;
  if (err) toast('Error al cargar regatas y bloque de carga: ' + err.message);
  configDBLista = true;
  inicioBloque = (cfg.data && cfg.data.inicio_bloque) || null;
  regatasCache = reg.data || [];
  await migrarConfigLocal();
  renderConfig();
}

// Si el usuario ya tenía datos guardados en este navegador (versión anterior), se suben una sola vez.
async function migrarConfigLocal() {
  const uid = currentUser.id;
  const kInicio = claveLocal('load_start');
  const kRegatas = claveLocal('races');
  const localInicio = localStorage.getItem(kInicio);
  let localRegatas = [];
  try { localRegatas = JSON.parse(localStorage.getItem(kRegatas) || '[]'); } catch (e) { localRegatas = []; }
  let migrado = false;

  if (localInicio && !inicioBloque) {
    const { error } = await sb.from('configuracion')
      .upsert({ usuario_id: uid, inicio_bloque: localInicio }, { onConflict: 'usuario_id' });
    if (!error) { inicioBloque = localInicio; localStorage.removeItem(kInicio); migrado = true; }
  }
  if (localRegatas.length && !regatasCache.length) {
    const filas = localRegatas.filter((r) => r.nombre && r.fecha).map((r) => ({ usuario_id: uid, nombre: r.nombre, fecha: r.fecha }));
    if (filas.length) {
      const { data, error } = await sb.from('regatas').insert(filas).select();
      if (!error) {
        regatasCache = (data || []).sort((a, b) => a.fecha.localeCompare(b.fecha));
        localStorage.removeItem(kRegatas);
        migrado = true;
      }
    }
  }
  if (migrado) toast('Regatas y bloque de carga pasados a tu cuenta.');
}

function renderConfig() {
  if (inicioBloque) {
    $('load-start-input').value = inicioBloque;
    $('dates-status').textContent = `Bloque de carga iniciado el ${fechaLegible(inicioBloque)}.`;
  } else {
    $('load-start-input').value = '';
    $('dates-status').textContent = 'Configurá el inicio del bloque para ver la semana de carga en Home.';
  }
  renderRaces();
  renderHome();
  renderHistorial();
}

async function saveDatesConfig() {
  const val = $('load-start-input').value;
  if (!val) { toast('Elegí una fecha.'); return; }
  const { error } = await sb.from('configuracion')
    .upsert({ usuario_id: currentUser.id, inicio_bloque: val, updated_at: new Date().toISOString() }, { onConflict: 'usuario_id' });
  if (error) {
    if (esErrorTablaFaltante(error)) avisoTablasFaltantes();
    else toast('Error al guardar: ' + error.message);
    return;
  }
  inicioBloque = val;
  toast('Bloque de carga guardado.');
  renderConfig();
}

function getRaces() {
  return regatasCache.slice();
}

function renderRaces() {
  const races = getRaces().sort((a, b) => a.fecha.localeCompare(b.fecha));
  const cont = $('races-list');
  cont.innerHTML = races.length
    ? races.map((r) => `
        <div class="card raceRow">
          <div><strong>${esc(r.nombre)}</strong><div class="muted">${fechaLegible(r.fecha)}</div></div>
          <button type="button" class="settingsBtn danger" style="margin:0;width:auto;" data-id="${esc(r.id)}" onclick="deleteRace(this.dataset.id)">✕</button>
        </div>`).join('')
    : '<p class="muted">Todavía no cargaste regatas.</p>';
}

async function addRace() {
  const nombre = $('race-name-input').value.trim();
  const fecha = $('race-date-new-input').value;
  if (!nombre || !fecha) { $('races-status').textContent = 'Completá nombre y fecha.'; return; }
  const { data, error } = await sb.from('regatas')
    .insert({ usuario_id: currentUser.id, nombre, fecha })
    .select()
    .single();
  if (error) {
    if (esErrorTablaFaltante(error)) avisoTablasFaltantes();
    else $('races-status').textContent = 'Error al guardar la regata: ' + error.message;
    return;
  }
  regatasCache.push(data);
  $('race-name-input').value = '';
  $('race-date-new-input').value = '';
  $('races-status').textContent = 'Regata agregada.';
  renderRaces();
  renderHome();
}

async function deleteRace(id) {
  const { error } = await sb.from('regatas').delete().eq('id', id);
  if (error) { toast('Error al borrar la regata: ' + error.message); return; }
  regatasCache = regatasCache.filter((r) => String(r.id) !== String(id));
  renderRaces();
  renderHome();
}

/* ---------------- Init ---------------- */

document.addEventListener('DOMContentLoaded', () => {
  initSupabase();
  checkSession();
  toggleWaterOptions();
  construirMenuZona();
  zonaManual = false;
  setCategoria('z1');
  addParcialRow();

  // Zona automática: se recalcula al escribir el trabajo, el SPM o los parciales.
  $('train').addEventListener('input', (ev) => {
    const t = ev.target;
    // Lo que escribe el usuario deja de ser "automático" y no se pisa más.
    if (t.dataset) delete t.dataset.auto;
    if (esCampoTiempo(t)) autoFormatoTiempo(t, ev);
    const fila = t.closest('.parcial-row');
    if (fila) { recalcularFila(fila); autoTotalesForm(); }
    else if (t.id === 'f-totaltime' || t.id === 'f-meters') autoTotalesForm();
    if (t.id === 'f-totaltime' || t.id === 'f-meters' || t.id === 'f-type' || t.id === 'f-spm' || t.classList.contains('p-spm') || t.classList.contains('p-metros') || t.classList.contains('p-tiempo')) autoZona();
  });
  // Cerrar la lista de zonas al tocar afuera.
  document.addEventListener('click', (ev) => { if (!ev.target.closest('.zoneWrap')) cerrarMenuZona(); });

  // Fuera de alcance en esta etapa (panel de entrenador).
  if ($('excel-import-wrap')) $('excel-import-wrap').style.display = 'none';

  // Enter para ingresar / crear cuenta.
  [['login-user', doLogin], ['login-pass', doLogin], ['reg-user', doRegister], ['reg-pass', doRegister], ['reg-pass2', doRegister]]
    .forEach(([id, fn]) => $(id).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') fn(); }));
});

// Bloquea el zoom por pellizco (el doble toque ya lo bloquea touch-action en el CSS) (iOS Safari ignora user-scalable=no).
['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) =>
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });
