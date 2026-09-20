/* ============================================================
   REMO — Index.js
   Conexión a Supabase + lógica de la app (login, Train, Sesiones, Home)
   Alcance: atleta individual (sin panel de entrenador, Excel ni apodos).
   ============================================================ */

const SUPABASE_URL = 'https://bpclsyvvwsdybicddmee.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1tWdx70gALNUqj38Hh75UQ_s2I4fgf1';

let sb = null;
let currentUser = null;
let entrenamientosCache = [];
let editingSessionId = null;
let pendingDeleteId = null;
let tableFilterValue = '';
let regatasCache = [];      // regatas del usuario (tabla `regatas` en Supabase)
let inicioBloque = null;    // inicio del bloque de carga (tabla `configuracion`)
let zonaManual = false;     // true = el usuario eligió la zona a mano; false = automática
let configDBLista = true;
// Umbrales para reconocer la zona automáticamente por SPM (ajustalos al plan del entrenador).
// hasta z1Max → Z1 · hasta z2Max → Z2 · hasta wattsMax → Watts · más → Sprint
const ZONA_SPM = { z1Max: 19, z2Max: 23};
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

// Reconoce la zona con lo que hay cargado: nombre del trabajo, SPM y parciales.
function detectarZona() {
  const tipo = $('f-type').value.trim().toLowerCase();
  const tot = calcularTotales();
  if (/\btest\b/.test(tipo) || /^(2000\s*m?|2\s*k(m)?)$/.test(tipo)) return 'test';
  if (tot.n <= 1 && tot.metros === 2000) return 'test';
  if (/sprint/.test(tipo)) return 'sprint';
  if (/watt/.test(tipo)) return 'watts';
  const spm = Number($('f-spm').value) || tot.spm;
  if (!spm) return null;
  if (spm <= ZONA_SPM.z1Max) return 'z1';
  if (spm <= ZONA_SPM.z2Max) return 'z2';
  if (spm <= ZONA_SPM.wattsMax) return 'watts';
  return 'sprint';
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

/* ---------------- Train: importar desde IA ---------------- */

function copyAiPrompt() {
  const prompt = `Mirá la foto de la pantalla del PM5 (Concept2) que te paso y devolveme ÚNICAMENTE un JSON (sin texto extra, sin backticks) con esta forma exacta:
{"date":"AAAA-MM-DD","type":"texto corto del trabajo, ej 4x8:00","meters":numero_metros_totales,"split":"promedio /500m, ej 1:57.9","totaltime":"tiempo total, ej 35:00.0","spm":numero_spm_promedio,"parciales":[{"tiempo":"mm:ss.s","metros":numero,"pace":"mm:ss.s por 500m","spm":numero}]}
Si no ves algún dato en la pantalla, poné null en ese campo. No inventes datos.`;
  const btn = $('ai-copy-btn');
  const ok = () => {
    toast('Instrucciones copiadas.');
    if (btn) { btn.classList.add('copied'); setTimeout(() => btn.classList.remove('copied'), 1500); }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(prompt).then(ok, () => alert(prompt));
  } else {
    alert(prompt);
  }
}

function loadFromAiCode() {
  const raw = $('ai-code-input').value.trim();
  if (!raw) { toast('Pegá el código generado por la IA primero.'); return; }
  // Tolera ```json ... ``` o texto alrededor del JSON.
  const ini = raw.indexOf('{');
  const fin = raw.lastIndexOf('}');
  let obj;
  try {
    if (ini === -1 || fin <= ini) throw new Error('sin json');
    obj = JSON.parse(raw.slice(ini, fin + 1));
  } catch (e) {
    toast('Ese texto no es un JSON válido.');
    return;
  }
  if (obj.date && /^\d{4}-\d{2}-\d{2}$/.test(obj.date)) $('f-date').value = obj.date;
  if (obj.type) $('f-type').value = obj.type;
  if (obj.meters !== undefined && obj.meters !== null) $('f-meters').value = obj.meters;
  if (obj.split) $('f-split').value = obj.split;
  if (obj.totaltime) $('f-totaltime').value = obj.totaltime;
  if (obj.spm !== undefined && obj.spm !== null) $('f-spm').value = obj.spm;
  limpiarParciales();
  (obj.parciales || []).slice(0, N_PARCIALES_MAX).forEach((p) => addParcialRow(p));
  if (!$('parciales-container').children.length) addParcialRow();
  // Si el código trae una zona válida se respeta; si no, se reconoce sola.
  const catIA = String(obj.cat || '').toLowerCase();
  if (CATEGORIAS.includes(catIA)) { zonaManual = true; setCategoria(catIA); }
  else { zonaManual = false; autoZona(); }
  toast('Datos cargados. Revisalos y guardá.');
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
  $('f-medium').value = 'ergo';
  zonaManual = false;
  setCategoria('z1');
  toggleWaterOptions();
  limpiarParciales();
  addParcialRow();
  $('ai-code-input').value = '';
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
    porcentaje: esAgua && $('f-percentage').value ? Number($('f-percentage').value) : null,
    distancia_metros: metros,
    tiempo_segundos: tiempoSeg,
    pace_500m: pace,
    spm_general: spm,
    ...tramos,
  };

  const btn = $('btn-add-session');
  btn.disabled = true;
  const eraEdicion = !!editingSessionId;
  let error;
  if (eraEdicion) {
    ({ error } = await sb.from('entrenamientos').update(registro).eq('id', editingSessionId));
  } else {
    ({ error } = await sb.from('entrenamientos').insert(registro));
  }
  btn.disabled = false;

  if (error) {
    toast('Error al guardar: ' + error.message);
    return;
  }
  toast(eraEdicion ? 'Sesión actualizada.' : 'Entrenamiento guardado.');
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
  renderZoneChart('z1', 'chart-z1', 'chart-z1-best');
  renderZoneChart('z2', 'chart-z2', 'chart-z2-best');
  renderRaceCard();
  renderWeekBadge();
  renderLastSessionCard();
}

function paceDeSesion(e) {
  if (e.pace_500m) {
    const p = parseTiempoASegundos(e.pace_500m);
    if (p !== null) return p;
  }
  if (e.tiempo_segundos && e.distancia_metros) return (e.tiempo_segundos / e.distancia_metros) * 500;
  return null;
}

// Barras: la más alta es la más rápida (menor /500m). Tocá una barra para ver su fecha y pace.
function renderZoneChart(zona, contId, bestId) {
  const cont = $(contId);
  const bestEl = $(bestId);
  if (!cont) return;
  const sesiones = entrenamientosCache
    .filter((e) => (e.categoria || '').toLowerCase() === zona && paceDeSesion(e) !== null)
    .slice()
    .sort((a, b) => a.fecha.localeCompare(b.fecha))
    .slice(-20);

  cont.innerHTML = '';
  if (!sesiones.length) {
    cont.innerHTML = '<div class="empty">Sin sesiones todavía</div>';
    if (bestEl) bestEl.textContent = '--';
    return;
  }

  const paces = sesiones.map(paceDeSesion);
  const min = Math.min(...paces);
  const max = Math.max(...paces);
  const mejorTexto = 'Mejor ' + conComa(segundosATiempo(min));
  if (bestEl) bestEl.textContent = mejorTexto;

  sesiones.forEach((e, i) => {
    const p = paces[i];
    const alto = max === min ? 60 : 22 + 78 * ((max - p) / (max - min));
    const bar = document.createElement('div');
    bar.className = 'bar' + (p === min ? ' best' : '') + (e.medio === 'agua' ? ' agua' : '');
    bar.style.height = alto.toFixed(0) + '%';
    bar.title = `${fechaLegible(e.fecha)} — ${conComa(segundosATiempo(p))}/500m${e.medio === 'agua' ? ' · Agua' : ''}`;
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
    document.querySelector('.lastSessionCard').classList.remove('agua');
    $('last-session-time').textContent = '--:--';
    $('last-session-delta').textContent = '';
    return;
  }
  const cat = (ultima.categoria || '').toLowerCase();
  circle.textContent = CAT_LABEL[cat] || '--';
  circle.className = 'cat-circle z-' + cat;
  $('last-session-desc').textContent = ultima.tipo || '';
  const esAgua = ultima.medio === 'agua';
  document.querySelector('.lastSessionCard').classList.toggle('agua', esAgua);
  $('last-session-meta').innerHTML = esc(`${nombreDia(ultima.fecha)} ${fechaCorta(ultima.fecha)}`) +
    (esAgua ? ` <span class="waterTag">≈ AGUA${ultima.bote ? ' · ' + esc(ultima.bote) : ''}</span>` : '');
  const paceUltima = paceDeSesion(ultima);
  $('last-session-time').textContent = paceUltima !== null ? conComa(segundosATiempo(paceUltima)) : '--:--';

  const deltaEl = $('last-session-delta');
  deltaEl.textContent = '';
  deltaEl.className = 'lastSessionDelta';
  const anterior = entrenamientosCache
    .slice(1)
    .find((e) => (e.categoria || '').toLowerCase() === cat && paceDeSesion(e) !== null);
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
  const tipos = CATEGORIAS.filter((c) => entrenamientosCache.some((e) => (e.categoria || '').toLowerCase() === c));
  const actual = tableFilterValue;
  sel.innerHTML = '<option value="">Todas las zonas</option>' +
    tipos.map((t) => `<option value="${t}">${CAT_NOMBRE[t]}</option>`).join('');
  sel.value = tipos.includes(actual) ? actual : '';
  tableFilterValue = sel.value;
}

function setTableFilter(value) {
  tableFilterValue = value;
  renderHistorial();
}

function setDateFilter() {
  renderHistorial();
}

function clearHistFilters() {
  tableFilterValue = '';
  $('table-filter-select').value = '';
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


function renderHistorial() {
  const cont = $('rows');
  if (!cont) return;
  const desde = $('hist-date-from').value;
  const hasta = $('hist-date-to').value;

  let lista = entrenamientosCache.slice();
  if (desde) lista = lista.filter((e) => e.fecha >= desde);
  if (hasta) lista = lista.filter((e) => e.fecha <= hasta);
  if (tableFilterValue) lista = lista.filter((e) => (e.categoria || '').toLowerCase() === tableFilterValue);

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
    // Dentro de cada semana, en orden cronológico (como en el boceto).
    g.items.slice().reverse().forEach((e) => bloque.appendChild(crearTarjetaSesion(e)));
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
  item.className = 'session-item' + (esAgua ? ' agua' : '');

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
    e.porcentaje != null ? ['%', e.porcentaje] : null,
  ].filter(Boolean);

  item.innerHTML = `
    <div class="session-mini-card glass-card">
      <div class="cat-circle z-${esc(cat)}">${esc(etiquetaCirculo(e))}</div>
      <div class="session-main">
        <div class="session-title">${esc(e.tipo || '')}</div>
        ${esAgua ? `<span class="waterTag">≈ AGUA${e.bote ? ' · ' + esc(e.bote) : ''}</span>` : ''}
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
    if (t.id === 'f-type' || t.id === 'f-spm' || t.classList.contains('p-spm') || t.classList.contains('p-metros') || t.classList.contains('p-tiempo')) autoZona();
  });
  // Cerrar la lista de zonas al tocar afuera.
  document.addEventListener('click', (ev) => { if (!ev.target.closest('.zoneWrap')) cerrarMenuZona(); });

  // Fuera de alcance en esta etapa (panel de entrenador).
  if ($('excel-import-wrap')) $('excel-import-wrap').style.display = 'none';

  // Enter para ingresar / crear cuenta.
  [['login-user', doLogin], ['login-pass', doLogin], ['reg-user', doRegister], ['reg-pass', doRegister], ['reg-pass2', doRegister]]
    .forEach(([id, fn]) => $(id).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') fn(); }));
});
