/* ============================================================
   REMO — Index.js
   Conexión a Supabase + lógica de la app (login, Train, Historial, Home)
   Alcance de esta etapa: atleta individual (sin panel de entrenador,
   Excel ni apodos — ver notas al final del archivo).
   ============================================================ */

const SUPABASE_URL = 'https://bpclsyvvwsdybicddmee.supabase.co';
const SUPABASE_KEY = 'sb_publishable_1tWdx70gALNUqj38Hh75UQ_s2I4fgf1';

let sb = null;
let currentUser = null;
let entrenamientosCache = [];
let editingSessionId = null;
let pendingDeleteId = null;
let ultimaSugerenciaZona = null;
let tableFilterValue = '';
const DOMINIO_INTERNO = 'remo.local';
const N_PARCIALES_MAX = 10;

const $ = (id) => document.getElementById(id);

/* ---------------- Utilidades ---------------- */

async function logout() {
  // 1. Le avisa a Supabase que cierre la sesión de forma segura en el servidor
  await sb.auth.signOut();
  
  // 2. Borra los datos del usuario de la memoria de la aplicación
  currentUser = null;
  entrenamientosCache = [];
  
  // 3. Vuelve a mostrar la pantalla que "tapa" la app (el overlay de login)
  $('login-overlay').style.display = '';
  
  // 4. Se asegura de mostrar el formulario de iniciar sesión (por si estaba en la vista de registro)
  showLoginMode();
  
  // 5. Limpia los campos de texto para que no quede escrita la contraseña ni el usuario
  $('login-user').value = '';
  $('login-pass').value = '';
}

function toast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('show'), 2600);
}

// "mm:ss" o "mm:ss.s" o "hh:mm:ss(.s)" -> segundos (float)
function parseTiempoASegundos(str) {
  if (!str) return null;
  const partes = String(str).trim().split(':').map((p) => parseFloat(p));
  if (partes.some((n) => isNaN(n))) return null;
  if (partes.length === 2) return partes[0] * 60 + partes[1];
  if (partes.length === 3) return partes[0] * 3600 + partes[1] * 60 + partes[2];
  return null;
}

function segundosATiempo(seg) {
  if (seg === null || seg === undefined) return '';
  const s = Math.round(seg * 10) / 10;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const restStr = rest < 10 ? '0' + rest.toFixed(1) : rest.toFixed(1);
  return m + ':' + restStr;
}

function fechaLegible(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/* ---------------- Supabase / Auth ---------------- */

function initSupabase() {
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

async function checkSession() {
  const { data } = await sb.auth.getSession();
  if (data.session) {
    onLoggedIn(data.session.user);
  }
}

function showRegisterMode() {
  if ($('login-mode')) $('login-mode').style.display = 'none';
  if ($('register-mode')) $('register-mode').style.display = '';
  if ($('register-err')) $('register-err').textContent = '';
  else console.warn('No encontré el elemento #register-err en el HTML.');
}

function showLoginMode() {
  if ($('register-mode')) $('register-mode').style.display = 'none';
  if ($('login-mode')) $('login-mode').style.display = '';
  if ($('login-err')) $('login-err').textContent = '';
  else console.warn('No encontré el elemento #login-err en el HTML.');
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
  await sb.auth.signOut();
  currentUser = null;
  entrenamientosCache = [];
  $('login-overlay').style.display = '';
  showLoginMode();
  $('login-user').value = '';
  $('login-pass').value = '';
}

function onLoggedIn(user) {
  currentUser = user;
  $('login-overlay').style.display = 'none';
  // Esta etapa es para atleta individual: se oculta el panel de equipo/entrenador.
  if ($('home-coach')) $('home-coach').style.display = 'none';
  if ($('home-athlete')) $('home-athlete').style.display = '';
  setAvatarInitials(user.email);
  if (!$('f-date').value) $('f-date').value = new Date().toISOString().slice(0, 10);
  cargarEntrenamientos();
  cargarConfigLocal();
}

/* ---------------- Navegación ---------------- */

function navigateTo(pageId, label, btnEl) {
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  const page = $(pageId);
  if (page) page.classList.add('active');
  document.querySelectorAll('.glass-btn').forEach((b) => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  if (pageId === 'historial') renderHistorial();
}

/* ---------------- Train: medio / zona / parciales ---------------- */

function toggleWaterOptions() {
  const esAgua = $('f-medium').value === 'agua';
  $('water-options').style.display = esAgua ? '' : 'none';
}

function updateZoneHint() {
  const spm = parseFloat($('f-spm').value);
  const hint = $('zone-hint');
  const sugerencia = $('zone-suggestion');
  if (isNaN(spm)) {
    hint.textContent = 'Cargá el SPM para sugerir la zona automáticamente';
    sugerencia.textContent = 'Sin sugerencia todavía';
    ultimaSugerenciaZona = null;
    return;
  }
  // Heurística orientativa por SPM — ajustable según el plan del entrenador.
  let zona, texto;
  if (spm < 18) { zona = 'z1'; texto = 'Zona 1 (aeróbico bajo)'; }
  else if (spm < 22) { zona = 'z2'; texto = 'Zona 2 (aeróbico)'; }
  else if (spm < 26) { zona = 'watts'; texto = 'Trabajo de potencia / watts'; }
  else { zona = 'sprint'; texto = 'Sprint / anaeróbico'; }
  ultimaSugerenciaZona = zona;
  hint.textContent = `SPM ${spm} → sugerencia: ${texto}`;
  sugerencia.textContent = `Sugerido: ${texto}`;
}

function applyZoneSuggestion() {
  if (!ultimaSugerenciaZona) {
    toast('Todavía no hay una sugerencia. Cargá el SPM primero.');
    return;
  }
  $('f-cat').value = ultimaSugerenciaZona;
  toast('Zona aplicada.');
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
    <div><input type="text" class="p-tiempo" placeholder="1:47.7" value="${data?.tiempo ?? ''}"></div>
    <div><input type="number" class="p-metros" placeholder="500" value="${data?.metros ?? ''}"></div>
    <div><input type="text" class="p-pace" placeholder="1:47.7" value="${data?.pace ?? ''}"></div>
    <div><input type="number" class="p-spm" placeholder="26" value="${data?.spm ?? ''}"></div>
    <div><button type="button" class="removeParcialBtn" onclick="this.closest('.parcial-row').remove(); renumerarParciales();">✕</button></div>
  `;
  cont.appendChild(row);
}

function renumerarParciales() {
  const cont = $('parciales-container');
  [...cont.children].forEach((row, i) => { row.firstElementChild.textContent = i + 1; });
}

function limpiarParciales() {
  $('parciales-container').innerHTML = '';
}

// Junta los parciales cargados en {tramo_1..tramo_10} (jsonb) para guardar en Supabase.
function collectParciales() {
  const cont = $('parciales-container');
  const filas = [...cont.children];
  const out = {};
  for (let i = 1; i <= N_PARCIALES_MAX; i++) out[`tramo_${i}`] = null;
  filas.forEach((row, i) => {
    if (i >= N_PARCIALES_MAX) return;
    const tiempo = row.querySelector('.p-tiempo').value.trim();
    const metros = row.querySelector('.p-metros').value.trim();
    const pace = row.querySelector('.p-pace').value.trim();
    const spm = row.querySelector('.p-spm').value.trim();
    if (!tiempo && !metros && !pace && !spm) return;
    out[`tramo_${i + 1}`] = {
      tiempo: tiempo || null,
      metros: metros ? Number(metros) : null,
      pace: pace || null,
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

/* ---------------- Train: importar desde IA ---------------- */

function copyAiPrompt() {
  const prompt = `Mirá la foto de la pantalla del PM5 (Concept2) que te paso y devolveme ÚNICAMENTE un JSON (sin texto extra, sin backticks) con esta forma exacta:
{"date":"AAAA-MM-DD","type":"texto corto del trabajo, ej 4x8:00","meters":numero_metros_totales,"split":"promedio /500m, ej 1:57.9","totaltime":"tiempo total, ej 35:00.0","spm":numero_spm_promedio,"cat":"z1|z2|sprint|test|watts","parciales":[{"tiempo":"mm:ss.s","metros":numero,"pace":"mm:ss.s por 500m","spm":numero}]}
Si no ves algún dato en la pantalla, poné null en ese campo. No inventes datos.`;
  navigator.clipboard.writeText(prompt).then(
    () => toast('Instrucciones copiadas.'),
    () => alert(prompt)
  );
}

function loadFromAiCode() {
  const raw = $('ai-code-input').value.trim();
  if (!raw) { toast('Pegá el código generado por la IA primero.'); return; }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    toast('Ese texto no es un JSON válido.');
    return;
  }
  if (obj.date) $('f-date').value = obj.date;
  if (obj.type) $('f-type').value = obj.type;
  if (obj.meters !== undefined && obj.meters !== null) $('f-meters').value = obj.meters;
  if (obj.split) $('f-split').value = obj.split;
  if (obj.totaltime) $('f-totaltime').value = obj.totaltime;
  if (obj.spm !== undefined && obj.spm !== null) $('f-spm').value = obj.spm;
  if (obj.cat) $('f-cat').value = obj.cat;
  limpiarParciales();
  (obj.parciales || []).forEach((p) => addParcialRow(p));
  toast('Datos cargados en el formulario. Revisalos y guardá.');
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
  $('f-cat').value = 'z2';
  $('f-medium').value = 'ergo';
  toggleWaterOptions();
  $('zone-hint').textContent = 'Cargá el SPM para sugerir la zona automáticamente';
  $('zone-suggestion').textContent = 'Sin sugerencia todavía';
  limpiarParciales();
  $('ai-code-input').value = '';
  $('f-date').value = new Date().toISOString().slice(0, 10);
}

function cancelEdit() {
  editingSessionId = null;
  $('edit-banner').style.display = 'none';
  resetTrainForm();
}

async function addSession() {
  if (!currentUser) { toast('Iniciá sesión primero.'); return; }
  if (!$('f-date').value) { toast('Falta la fecha.'); return; }
  if (!$('f-type').value.trim()) { toast('Falta el nombre del trabajo.'); return; }

  const esAgua = $('f-medium').value === 'agua';
  const registro = {
    usuario_id: currentUser.id,
    fecha: $('f-date').value,
    tipo: $('f-type').value.trim(),
    categoria: $('f-cat').value,
    medio: $('f-medium').value,
    bote: esAgua ? $('f-boat').value : null,
    porcentaje: esAgua && $('f-percentage').value ? Number($('f-percentage').value) : null,
    distancia_metros: $('f-meters').value ? Number($('f-meters').value) : null,
    tiempo_segundos: parseTiempoASegundos($('f-totaltime').value),
    pace_500m: $('f-split').value.trim() || null,
    spm_general: $('f-spm').value ? Number($('f-spm').value) : null,
    ...collectParciales(),
  };

  $('btn-add-session').disabled = true;
  let error;
  if (editingSessionId) {
    ({ error } = await sb.from('entrenamientos').update(registro).eq('id', editingSessionId));
  } else {
    ({ error } = await sb.from('entrenamientos').insert(registro));
  }
  $('btn-add-session').disabled = false;

  if (error) {
    toast('Error al guardar: ' + error.message);
    return;
  }
  toast(editingSessionId ? 'Sesión actualizada.' : 'Entrenamiento guardado.');
  cancelEdit();
  await cargarEntrenamientos();
}

function editSession(id) {
  const e = entrenamientosCache.find((x) => x.id === id);
  if (!e) return;
  editingSessionId = id;
  $('edit-banner').style.display = '';
  $('f-date').value = e.fecha;
  $('f-type').value = e.tipo || '';
  $('f-cat').value = e.categoria || 'z2';
  $('f-medium').value = e.medio || 'ergo';
  toggleWaterOptions();
  $('f-boat').value = e.bote || 'Single';
  $('f-percentage').value = e.porcentaje ?? '';
  $('f-meters').value = e.distancia_metros ?? '';
  $('f-totaltime').value = e.tiempo_segundos !== null ? segundosATiempo(e.tiempo_segundos) : '';
  $('f-split').value = e.pace_500m || '';
  $('f-spm').value = e.spm_general ?? '';
  limpiarParciales();
  parcialesDesdeEntreno(e).forEach((p) => addParcialRow(p));
  const trainBtn = $('nav-train');
  navigateTo('train', 'train', trainBtn);
}

/* ---------------- Cargar / listar entrenamientos ---------------- */

async function cargarEntrenamientos() {
  if (!currentUser) return;
  const { data, error } = await sb
    .from('entrenamientos')
    .select('*')
    .eq('usuario_id', currentUser.id)
    .order('fecha', { ascending: false });
  if (error) {
    toast('Error al cargar entrenamientos: ' + error.message);
    return;
  }
  entrenamientosCache = data || [];
  renderHome();
  renderHistorial();
  poblarFiltroTipos();
}

/* ---------------- Home ---------------- */

function setAvatarInitials(email) {
  const user = (email || '').split('@')[0];
  const partes = user.split(/[._-]/).filter(Boolean);
  let iniciales;
  if (partes.length >= 2) iniciales = partes[0][0] + partes[1][0];
  else iniciales = user.slice(0, 2);
  const el = $('home-avatar');
  if (el) el.textContent = iniciales.toUpperCase();
  const el2 = $('train-avatar');
  if (el2) el2.textContent = iniciales.toUpperCase();
}

// "123.4" -> "123,4" (para mostrar tiempos/paces como en el diseño, con coma decimal)
function conComa(str) {
  return str == null ? '' : String(str).replace('.', ',');
}

function renderHome() {
  renderZoneChart('z1', 'chart-z1', 'chart-z1-best');
  renderZoneChart('z2', 'chart-z2', 'chart-z2-best');
  renderRaceCard();
  renderWeekBadge();
  renderLastSessionCard();
}

function paceDeSesion(e) {
  if (e.pace_500m) return parseTiempoASegundos(e.pace_500m);
  if (e.tiempo_segundos && e.distancia_metros) return (e.tiempo_segundos / e.distancia_metros) * 500;
  return null;
}

function renderZoneChart(zona, contId, bestId) {
  const cont = $(contId);
  const bestEl = $(bestId);
  if (!cont) return;
  const sesiones = entrenamientosCache
    .filter((e) => e.categoria === zona && paceDeSesion(e) !== null)
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
  sesiones.forEach((e, i) => {
    const p = paces[i];
    const alto = max === min ? 60 : 20 + 80 * ((max - p) / (max - min));
    const bar = document.createElement('div');
    bar.className = 'bar' + (p === min ? ' best' : '');
    bar.style.height = alto.toFixed(0) + '%';
    bar.title = `${fechaLegible(e.fecha)} — ${conComa(segundosATiempo(p))}/500m`;
    cont.appendChild(bar);
  });
  if (bestEl) bestEl.textContent = conComa(segundosATiempo(min));
}

function renderRaceCard() {
  const hoy = new Date().toISOString().slice(0, 10);
  const proxima = getRaces().filter((r) => r.fecha >= hoy).sort((a, b) => a.fecha.localeCompare(b.fecha))[0];
  if (!proxima) {
    $('race-card-name').textContent = 'Sin regatas';
    $('race-card-days').textContent = '--';
    $('race-card-date').innerHTML = '&nbsp;';
    return;
  }
  const dias = Math.ceil((new Date(proxima.fecha) - new Date(hoy)) / 86400000);
  $('race-card-name').textContent = proxima.nombre;
  $('race-card-days').textContent = dias;
  $('race-card-date').textContent = fechaLegible(proxima.fecha);
}

function renderWeekBadge() {
  const inicio = currentUser ? localStorage.getItem(claveLocal('load_start')) : null;
  if (!inicio) { $('week-badge-num').textContent = '--'; return; }
  const dias = Math.floor((new Date().setHours(0,0,0,0) - new Date(inicio).setHours(0,0,0,0)) / 86400000);
  const semana = Math.max(1, Math.floor(dias / 7) + 1);
  $('week-badge-num').textContent = semana;
}

function renderLastSessionCard() {
  const ultima = entrenamientosCache[0];
  if (!ultima) {
    $('last-session-cat').textContent = '--';
    $('last-session-desc').textContent = 'Sin sesiones todavía';
    $('last-session-time').textContent = '--:--';
    $('last-session-delta').textContent = '';
    return;
  }
  $('last-session-cat').textContent = (ultima.categoria || '').toUpperCase() || '--';
  $('last-session-desc').textContent = ultima.tipo || '';
  const paceUltima = paceDeSesion(ultima);
  $('last-session-time').textContent = paceUltima !== null ? conComa(segundosATiempo(paceUltima)) : '--:--';

  const anterior = entrenamientosCache
    .slice(1)
    .find((e) => e.categoria === ultima.categoria && paceDeSesion(e) !== null);
  const deltaEl = $('last-session-delta');
  if (!anterior || paceUltima === null) {
    deltaEl.textContent = '';
    return;
  }
  const paceAnterior = paceDeSesion(anterior);
  const delta = paceUltima - paceAnterior;
  const signo = delta >= 0 ? '↑' : '↓';
  deltaEl.textContent = `${conComa(segundosATiempo(Math.abs(delta)))}${signo}`;
  deltaEl.className = 'lastSessionDelta ' + (delta >= 0 ? 'up' : 'down');
}

/* ---------------- Historial ---------------- */

function poblarFiltroTipos() {
  const sel = $('table-filter-select');
  const tipos = [...new Set(entrenamientosCache.map((e) => e.categoria).filter(Boolean))];
  const actual = sel.value;
  sel.innerHTML = '<option value="">Todas las categorías</option>' +
    tipos.map((t) => `<option value="${t}">${t}</option>`).join('');
  sel.value = tipos.includes(actual) ? actual : '';
}

function setTableFilter(value) {
  tableFilterValue = value;
  renderHistorial();
}

function setDateFilter() {
  renderHistorial();
}

function setAthleteFilter() {
  // Sin panel de equipo en esta etapa: no aplica (queda para más adelante).
}

function renderHistorial() {
  if (!$('rows')) return;
  const desde = $('hist-date-from').value;
  const hasta = $('hist-date-to').value;

  let lista = entrenamientosCache.slice();
  if (desde) lista = lista.filter((e) => e.fecha >= desde);
  if (hasta) lista = lista.filter((e) => e.fecha <= hasta);
  if (tableFilterValue) lista = lista.filter((e) => e.categoria === tableFilterValue);

  $('result-count').textContent = `${lista.length} sesión${lista.length === 1 ? '' : 'es'}`;

  const cont = $('rows');
  cont.innerHTML = '';
  if (!lista.length) {
    cont.innerHTML = '<p class="muted" style="text-align:center;padding:20px;">No hay sesiones para este filtro.</p>';
    return;
  }

  lista.forEach((e) => {
    const row = document.createElement('div');
    row.className = 'card';
    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <strong>${fechaLegible(e.fecha)}</strong> — ${e.tipo || ''}
          <div class="muted" style="font-size:12px;margin-top:2px;">
            ${e.categoria ?? ''} · ${e.medio === 'agua' ? ('Agua' + (e.bote ? ' · ' + e.bote : '')) : 'Ergómetro'}
          </div>
        </div>
        <div style="text-align:right;font-size:13px;">
          ${e.distancia_metros ? e.distancia_metros + 'm' : ''}<br>
          ${e.tiempo_segundos !== null ? segundosATiempo(e.tiempo_segundos) : ''}
          ${e.pace_500m ? ' · ' + e.pace_500m + '/500m' : ''}
        </div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;">
        <button type="button" class="settingsBtn" style="margin:0;" data-act="edit">Editar</button>
        <button type="button" class="settingsBtn danger" style="margin:0;" data-act="del">Eliminar</button>
      </div>
    `;
    row.querySelector('[data-act="edit"]').addEventListener('click', () => editSession(e.id));
    row.querySelector('[data-act="del"]').addEventListener('click', () => askDeleteSession(e.id, `${e.tipo} del ${fechaLegible(e.fecha)}`));
    cont.appendChild(row);
  });
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

/* ---------------- Settings: exportar / importar / reset ---------------- */

function exportJSON() {
  if (!entrenamientosCache.length) { toast('No hay entrenamientos para exportar.'); return; }
  const blob = new Blob([JSON.stringify(entrenamientosCache, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `entrenamientos_${currentUser.email.split('@')[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportCSV() {
  if (!entrenamientosCache.length) { toast('No hay entrenamientos para exportar.'); return; }
  const cols = ['fecha', 'tipo', 'categoria', 'medio', 'bote', 'porcentaje', 'distancia_metros', 'tiempo_segundos', 'pace_500m', 'spm_general'];
  const header = cols.join(',');
  const filas = entrenamientosCache.map((e) => cols.map((c) => `"${e[c] ?? ''}"`).join(','));
  const csv = [header, ...filas].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `entrenamientos_${currentUser.email.split('@')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importJSON(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const texto = await file.text();
    const arr = JSON.parse(texto);
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

function syncNow() {
  cargarEntrenamientos();
  toast('Sincronizado con Supabase.');
}

function showClearConfirm() {
  $('clear-overlay').classList.add('show');
}

async function clearDB() {
  $('clear-overlay').classList.remove('show');
  if (!currentUser) return;
  const { error } = await sb.from('entrenamientos').delete().eq('usuario_id', currentUser.id);
  if (error) { toast('Error al resetear: ' + error.message); return; }
  toast('Todas tus sesiones fueron eliminadas.');
  await cargarEntrenamientos();
}

/* ---------------- Settings: bloque de carga / regatas (localStorage) ----------------
   Todavía no hay tabla en Supabase para esto: se guarda localmente por usuario.
   Si más adelante lo necesitás sincronizado entre dispositivos, se puede migrar
   a una tabla `configuracion` / `regatas` en Supabase. */

function claveLocal(sufijo) {
  return `remo_${currentUser ? currentUser.id : 'anon'}_${sufijo}`;
}

function cargarConfigLocal() {
  const inicio = localStorage.getItem(claveLocal('load_start'));
  if (inicio) {
    $('load-start-input').value = inicio;
    $('dates-status').textContent = `Bloque de carga iniciado el ${fechaLegible(inicio)}.`;
  }
  renderRaces();
  renderHome();
}

function saveDatesConfig() {
  const val = $('load-start-input').value;
  if (!val) { toast('Elegí una fecha.'); return; }
  localStorage.setItem(claveLocal('load_start'), val);
  $('dates-status').textContent = `Bloque de carga iniciado el ${fechaLegible(val)}.`;
  toast('Guardado.');
  renderHome();
}

function getRaces() {
  try { return JSON.parse(localStorage.getItem(claveLocal('races')) || '[]'); }
  catch (e) { return []; }
}

function renderRaces() {
  const races = getRaces().sort((a, b) => a.fecha.localeCompare(b.fecha));
  const cont = $('races-list');
  cont.innerHTML = races.length
    ? races.map((r, i) => `
        <div class="card" style="display:flex;justify-content:space-between;align-items:center;">
          <div><strong>${r.nombre}</strong><div class="muted">${fechaLegible(r.fecha)}</div></div>
          <button type="button" class="settingsBtn danger" style="margin:0;" onclick="deleteRace(${i})">✕</button>
        </div>`).join('')
    : '<p class="muted">Todavía no cargaste regatas.</p>';
}

function addRace() {
  const nombre = $('race-name-input').value.trim();
  const fecha = $('race-date-new-input').value;
  if (!nombre || !fecha) { $('races-status').textContent = 'Completá nombre y fecha.'; return; }
  const races = getRaces();
  races.push({ nombre, fecha });
  localStorage.setItem(claveLocal('races'), JSON.stringify(races));
  $('race-name-input').value = '';
  $('race-date-new-input').value = '';
  $('races-status').textContent = 'Regata agregada.';
  renderRaces();
  renderHome();
}

function deleteRace(i) {
  const races = getRaces();
  races.splice(i, 1);
  localStorage.setItem(claveLocal('races'), JSON.stringify(races));
  renderRaces();
  renderHome();
}

/* ---------------- Init ---------------- */

document.addEventListener('DOMContentLoaded', () => {
  initSupabase();
  checkSession();
  toggleWaterOptions();
  addParcialRow();

  // Fuera de alcance en esta etapa (panel de entrenador): se ocultan para no
  // mostrar botones que todavía no hacen nada útil.
  if ($('excel-import-wrap')) $('excel-import-wrap').style.display = 'none';
  if ($('apodo-section')) $('apodo-section').style.display = 'none';
  if ($('api-status')) $('api-status').textContent = 'Conectado a Supabase.';

  // Botón de cerrar sesión (no estaba en el HTML original).
  const settingsSection = $('settings');
  if (settingsSection && !$('logout-btn')) {
    const btn = document.createElement('button');
    btn.className = 'settingsBtn danger';
    btn.id = 'logout-btn';
    btn.innerHTML = '<span>Cerrar sesión</span><span>⎋</span>';
    btn.onclick = logout;
    settingsSection.insertBefore(btn, settingsSection.firstChild.nextSibling);
  }
});
