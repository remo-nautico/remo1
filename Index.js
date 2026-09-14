
function switchView(viewId, btnElement) {
            // Update buttons
            const btns = document.querySelectorAll('.glass-btn');
            btns.forEach(b => b.classList.remove('active'));
            btnElement.classList.add('active');

            // Update views
            const views = document.querySelectorAll('.view-section');
            views.forEach(v => {
                v.classList.remove('active');
            });
            
            const targetView = document.getElementById(`view-${viewId}`);
            if (targetView) {
                targetView.classList.add('active');
            }

            // Regenerate charts if switching back to resumen to re-trigger animations
            if (viewId === 'resumen') {
                setTimeout(() => {
                    generateBars('chart1', 35);
                    generateBars('chart2', 35);
                }, 50);
            }
            
            // Scroll to top when changing tabs
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        // Inicializar gráficos al cargar la página
       

function navigateTo(page, view, button) {
    // Función nueva de navegación
    changePage(page);

    // Función vieja de navegación
    switchView(view, button);
}

function toggleWaterOptions() {
    const medium = document.getElementById("f-medium").value;
    const waterDiv = document.getElementById("water-options");
    if (medium === "agua") {
        waterDiv.style.display = "block";
    } else {
        waterDiv.style.display = "none";
    }
}

function changePage(page){
  if(page === "settings" && !(currentUser && currentUser.role==="profesor")){
    page = "home";
  }

  document.querySelectorAll(".page").forEach(p=>{
    p.classList.remove("active");
  });

  document.getElementById(page).classList.add("active");

  document.querySelectorAll("nav button").forEach(b=>b.classList.remove("navActive"));
  document.getElementById("nav-"+page).classList.add("navActive");

  if(page === "home"){
    setTimeout(()=>{ if(areaChart) areaChart.resize(); },50);
  }

  if(page === "historial" || page === "home"){
    loadFromCloud();
  }
  if(page === "settings" && currentUser && currentUser.role==="profesor"){
    loadUsers().then(()=>{ buildAthleteFilterOptions(); renderApodoList(); });
  }
}

function getUniqueKey(s) {
  if (!s) return "";
  const iso = String(s.iso || "").trim();
  const type = String(s.type || "").trim().toLowerCase();
  const meters = Number(s.meters) || 0;
  return `${iso}|${type}|${meters}`;
}

const LS_KEY="stroke_journal_v2";
const AUTH_KEY="remo_auth_v1";
let DB=[];
let currentUser=null;     
let athleteFilter="todos"; 
let RACES=[];              

const CAT={
  steady:{color:"#c1793c",bg:"#f3e3d2",label:"Ritmo sostenido"},
  z1:{color:"#6f8f52",bg:"#e9f0e0",label:"Zona 1"},
  z2:{color:"#c1793c",bg:"#f3e3d2",label:"Zona 2"},
  intervals:{color:"#3d6b6b",bg:"#e2edec",label:"Intervalos"},
  sprint:{color:"#b3432e",bg:"#f6e2dc",label:"Sprint"},
  test:{color:"#7c4a63",bg:"#f0e3ea",label:"Test"},
  watts:{color:"#a8791b",bg:"#f6ecd7",label:"Watts"},
};

function isTimeSplit(s){ return /^\d+:\d/.test(s); }
function toSec(s){ const[m,r]=s.split(":");return +m*60+parseFloat(r); }
function fmtSec(s){ const m=Math.floor(s/60);const sec=(s%60).toFixed(2).padStart(5,"0");return `${m}:${sec}`; }
function fmtTotal(s){ const h=Math.floor(s/3600);const m=Math.floor((s%3600)/60);const sec=Math.round(s%60);const ss=String(sec).padStart(2,"0");if(h>0)return `${h}:${String(m).padStart(2,"0")}:${ss}`;return `${m}:${ss}`; }
function fmtDate(iso){const d=new Date(iso+"T00:00:00");const months=["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];return `${String(d.getDate()).padStart(2,"0")} ${months[d.getMonth()]} ${d.getFullYear()}`;}

function setHomeGreeting(){
  const nameEl=document.getElementById("home-greeting-name");
  const dateEl=document.getElementById("home-greeting-date");
  if(!nameEl || !dateEl) return;
  const usuario = currentUser ? currentUser.usuario : "";
  nameEl.textContent = usuario ? `Hola, ${usuario} 👋` : "Hola 👋";
  const dias=["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
  const meses=["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  const hoy=new Date();
  dateEl.textContent = `${dias[hoy.getDay()]} ${hoy.getDate()} de ${meses[hoy.getMonth()]}`;
}

function normType(t){
  return String(t ?? "")
    .replace(/\s+/g, "")
    .toLowerCase();
}
function validSplit(v){ return /^(\d+:\d{2}\.\d{1,2}|W\s?\d+)$/i.test(v.trim()); }

function isIntervalWork(type){
  return /\d+\s*[×x]\s*\d/i.test(type||"");
}

// Acepta "M:SS.d" o "H:MM:SS" y devuelve segundos totales.
function toSecFlexible(s){
  if(!s) return null;
  const parts = String(s).trim().split(":");
  if(parts.length===3){
    const h=parseInt(parts[0],10)||0, m=parseInt(parts[1],10)||0, sec=parseFloat(parts[2])||0;
    return h*3600+m*60+sec;
  }
  if(parts.length===2 && isTimeSplit(s)) return toSec(s);
  return null;
}

const TOL = 0.15; // 15% de tolerancia para redondeos manuales

// Chequea el modo "suma": cada tramo es independiente, la suma de tiempos
// (y de metros, si están todos cargados) tiene que dar el total.
function checkSuma(totalMeters, totalSec, rows, secs){
  if(totalSec){
    const sumSec = secs.reduce((a,b)=>a+b,0);
    const tolerancia = totalSec*TOL;
    if(Math.abs(sumSec-totalSec) > tolerancia){
      return {ok:false, msg:"la suma de los tiempos de los tramos ("+fmtSec(sumSec)+") no coincide con el Tiempo Total ("+fmtSec(totalSec)+")"};
    }
  }
  const metersRows = rows.map(p=>p.meters||0);
  const rowsWithMeters = metersRows.filter(m=>m>0).length;
  if(totalMeters && rowsWithMeters===rows.length){
    const sumMeters = metersRows.reduce((a,b)=>a+b,0);
    const tolMeters = totalMeters*TOL;
    if(Math.abs(sumMeters-totalMeters) > tolMeters){
      return {ok:false, msg:"la suma de los metros de los tramos ("+sumMeters+"m) no coincide con los Metros Totales ("+totalMeters+"m)"};
    }
  }
  return {ok:true};
}

// Chequea el modo "acumulado": es un solo trabajo continuo, el tiempo de
// cada tramo es el acumulado hasta ese punto (va creciendo) y el último
// tramo se tiene que acercar al Tiempo Total.
function checkAcumulado(totalSec, secs){
  for(let i=1;i<secs.length;i++){
    if(secs[i] <= secs[i-1]){
      return {ok:false, msg:"el tiempo del Tramo "+(i+1)+" no es mayor al del Tramo "+i+" (en un trabajo continuo el tiempo tiene que ir creciendo)"};
    }
  }
  if(totalSec){
    const last = secs[secs.length-1];
    const tolerancia = totalSec*TOL;
    if(Math.abs(last-totalSec) > tolerancia){
      return {ok:false, msg:"el último tramo acumulado ("+fmtSec(last)+") no coincide con el Tiempo Total ("+fmtSec(totalSec)+")"};
    }
  }
  return {ok:true};
}

/**
 * Verifica que los parciales cargados sean consistentes con el trabajo.
 * No pide que se elija un método a mano: prueba primero si los tramos
 * "suman" el total (trabajo tipo intervalo, con tramos independientes) y,
 * si eso no cierra, prueba si son un tiempo "acumulado" que va creciendo
 * (un solo trabajo continuo). Sólo marca error si NINGUNO de los dos cierra.
 */
function validateParciales(totalMeters, totalTimeStr, parciales){
  const rows = (parciales||[]).filter(p=>p && p.time);
  if(rows.length<2) return {ok:true};
  const secs = rows.map(p=>isTimeSplit(p.time)?toSec(p.time):null);
  if(secs.some(s=>s===null)) return {ok:true};

  const totalSec = toSecFlexible(totalTimeStr);

  const sumaResult = checkSuma(totalMeters, totalSec, rows, secs);
  if(sumaResult.ok) return {ok:true, mode:"suma"};

  const acumResult = checkAcumulado(totalSec, secs);
  if(acumResult.ok) return {ok:true, mode:"acumulado"};

  return {
    ok:false,
    msg:"Los parciales no cierran de ninguna de las dos formas: ni sumados ("+sumaResult.msg+") ni acumulados ("+acumResult.msg+"). Revisá los tiempos/metros de los tramos."
  };
}

function getRestSeconds(type){
  if(!type) return 0;
  const m=type.match(/(\d+)\s*[×x]\s*[^/]+\/\s*(\d+):(\d{2})\s*r/i);
  if(!m) return 0;
  const reps=parseInt(m[1],10);
  if(!reps||reps<2) return 0;
  const restSec=parseInt(m[2],10)*60+parseInt(m[3],10);
  return (reps-1)*restSec;
}

function saveLS(){localStorage.setItem(LS_KEY,JSON.stringify(DB));}
function loadLS(){try{const raw=localStorage.getItem(LS_KEY);if(raw){DB=JSON.parse(raw);return true;}}catch(e){}return false;}

const API_URL = "https://script.google.com/macros/s/AKfycbxe0Lk4epbhLNCNeKDNr9ad7skw7wjIyGTigm1hKiNdCDxi56pP_aBPh71a00XNqhzFgg/exec";
const SHEETS_TZ_OFFSET_MIN = 180; 

function repairSheetValue(v){
  if (typeof v !== "string") return v;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z?$/);
  if (!m) return stripTextSafe(v);
  const [, yy, mo, dd, hh, mi, ss] = m;
  const year = parseInt(yy, 10);

  if (year === 1899 || year === 1900) {
    let totalMin = parseInt(hh, 10) * 60 + parseInt(mi, 10);
    totalMin -= SHEETS_TZ_OFFSET_MIN;
    if (totalMin < 0) totalMin += 24 * 60;
    const h = Math.floor(totalMin / 60), mnt = totalMin % 60;
    const secStr = ss.padStart(2, "0");
    return h > 0 ? `${h}:${String(mnt).padStart(2,"0")}:${secStr}` : `${mnt}:${secStr}`;
  }
  return `${yy}-${mo}-${dd}`;
}

function stripTextSafe(v){
  return (typeof v === "string" && v.startsWith("'")) ? v.slice(1) : v;
}

function textSafe(v){
  if (typeof v !== "string" || !v) return v;
  return v.startsWith("'") ? v : "'" + v;
}

function sanitizeSession(s){
  if (!s) return s;
  s.iso = repairSheetValue(s.iso);
  s.type = repairSheetValue(s.type);
  s.split = repairSheetValue(s.split);
  s.totaltime = repairSheetValue(s.totaltime);
  s.usuario = stripTextSafe(s.usuario);
  s.date = /^\d{4}-\d{2}-\d{2}$/.test(s.iso) ? fmtDate(s.iso) : repairSheetValue(s.date);
  if (Array.isArray(s.parciales)){
    s.parciales = s.parciales.map(p => p ? {
      ...p,
      time: repairSheetValue(p.time),
      split: repairSheetValue(p.split)
    } : p);
  }
  // Mantenemos las opciones de agua si las hay
  s.medium = s.medium || "ergo";
  s.boat = s.boat || "";
  s.percentage = s.percentage || "";
  return s;
}

function toApiSafeSession(entry){
  return {
    ...entry,
    iso: textSafe(entry.iso),
    type: textSafe(entry.type),
    split: textSafe(entry.split),
    totaltime: textSafe(entry.totaltime),
    medium: textSafe(entry.medium),
    boat: textSafe(entry.boat),
    percentage: textSafe(entry.percentage),
    parciales: Array.isArray(entry.parciales) ? entry.parciales.map(p => ({
      ...p,
      time: textSafe(p.time),
      split: textSafe(p.split)
    })) : entry.parciales
  };
}

async function loadFromCloud() {
  if (!API_URL) {
    document.getElementById("api-status").textContent = "Falta configurar API_URL.";
    return;
  }
  try {
    document.getElementById("api-status").textContent = "Cargando desde Google Sheets...";
    let remote = await postToApi("get");
    if (remote === null) {
      document.getElementById("api-status").textContent = "Error al conectar con Google Sheets.";
      return;
    }
    if (remote && typeof remote === "object" && !Array.isArray(remote)) {
      remote = remote.data || remote.sessions || remote.result || remote.rows || [];
    }
    if (!Array.isArray(remote)) {
      throw new Error("Respuesta inválida del servidor.");
    }

    DB = remote.map(s => {
      s.meters = Number(s.meters) || 0;
      return sanitizeSession(s);
    });
    refresh();
    document.getElementById("api-status").textContent = "Conectado a " + shortUrl(API_URL);

  } catch (err) {
    console.error("Error al cargar datos:", err);
    document.getElementById("api-status").textContent = "Error de carga: " + err.message;
  }
}

async function postToApi(action,payload){
  if(!API_URL) return null;
  try{
    const auth = action==="login" ? {} : {
      _usuario: currentUser?currentUser.usuario:"",
      _role: currentUser?currentUser.role:""
    };
    const res=await fetch(API_URL,{
      method:"POST",
      body:JSON.stringify({action,...auth,...payload})
    });
    if(!res.ok){
      throw new Error("El servidor respondió con un error ("+res.status+").");
    }
    const text=await res.text();
    if(!text) return null;
    try{
      return JSON.parse(text);
    }catch(e){
      throw new Error("La respuesta del servidor no es JSON válido.");
    }
  }catch(err){
    console.error("Error de conexión con la API:",err);
    showToast("Se guardó local pero no se pudo sincronizar con Sheets.");
    return null;
  }
}

function shortUrl(u){
  const m=u.match(/\/s\/([^/]+)\//);
  return m?"…"+m[1].slice(-6)+"/exec":u;
}

let chartFilter="avg_z2",tableFilter="todos",areaChart=null,lastSorted=[];
let TYPE_LABELS={}; 
let histDateFrom="", histDateTo=""; 

function loadStoredAuth(){
  try{
    const raw=localStorage.getItem(AUTH_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return null;
}

function showRegisterMode(){
  document.getElementById("login-mode").style.display="none";
  document.getElementById("register-mode").style.display="block";
  document.getElementById("register-err").textContent="";
}

function showLoginMode(){
  document.getElementById("register-mode").style.display="none";
  document.getElementById("login-mode").style.display="block";
  document.getElementById("login-err").textContent="";
}

async function doRegister(){
  const usuario=document.getElementById("reg-user").value.trim();
  const pass=document.getElementById("reg-pass").value;
  const pass2=document.getElementById("reg-pass2").value;
  const inviteCode=document.getElementById("reg-invite").value.trim();
  const errEl=document.getElementById("register-err");
  errEl.textContent="";

  if(!usuario || usuario.length<3){ errEl.textContent="El usuario tiene que tener al menos 3 caracteres."; return; }
  if(!pass || pass.length<4){ errEl.textContent="La contraseña tiene que tener al menos 4 caracteres."; return; }
  if(pass!==pass2){ errEl.textContent="Las contraseñas no coinciden."; return; }

  errEl.textContent="Creando cuenta...";
  const res=await postToApi("register",{usuario,pass,inviteCode});
  if(!res || !res.ok){
    errEl.textContent=(res && res.msg) || "No se pudo crear la cuenta.";
    return;
  }

  document.getElementById("reg-user").value="";
  document.getElementById("reg-pass").value="";
  document.getElementById("reg-pass2").value="";
  document.getElementById("reg-invite").value="";
  showToast("Cuenta creada ✓ Iniciá sesión.");
  showLoginMode();
  document.getElementById("login-user").value=usuario;
}

async function doLogin(){
  const usuario=document.getElementById("login-user").value.trim();
  const pass=document.getElementById("login-pass").value;
  const errEl=document.getElementById("login-err");
  errEl.textContent="";
  if(!usuario || !pass){ errEl.textContent="Completá usuario y contraseña."; return; }

  errEl.textContent="Verificando...";
  const res=await postToApi("login",{usuario,pass});
  if(!res || !res.ok){
    errEl.textContent=(res && res.msg) || "Usuario o contraseña incorrectos.";
    return;
  }
  currentUser={usuario:res.usuario||usuario, role:res.role||"atleta"};
  localStorage.setItem(AUTH_KEY, JSON.stringify(currentUser));
  document.getElementById("login-err").textContent="";
  document.getElementById("login-user").value="";
  document.getElementById("login-pass").value="";
  await startApp();
}

function doLogout(){
  localStorage.removeItem(AUTH_KEY);
  currentUser=null;
  athleteFilter="todos";
  document.getElementById("login-overlay").classList.remove("hide");
  document.getElementById("user-bar").style.display="none";
}

function applyRoleUI(){
  const isCoach = currentUser && currentUser.role==="profesor";
  document.body.classList.toggle("role-coach", !!isCoach);
  document.body.classList.toggle("role-athlete", !isCoach);

  document.getElementById("home-coach").style.display = isCoach ? "block":"none";
  document.getElementById("home-athlete").style.display = isCoach ? "none":"block";
  document.getElementById("nav-settings").style.display = isCoach ? "" : "none";
  if(!isCoach && document.getElementById("settings").classList.contains("active")){
    changePage("home");
  }

  document.getElementById("user-bar").style.display="flex";
  document.getElementById("user-who").innerHTML =
    (currentUser?currentUser.usuario:"") + `<span class="roleTag">${isCoach?"Profesor":"Atleta"}</span>`;

  setHomeGreeting();

  document.getElementById("athlete-filter-wrap").style.display = "none";
  document.getElementById("hist-athlete-filter-wrap").style.display = isCoach ? "block":"none";
  document.getElementById("race-add-row").style.display = isCoach ? "grid":"none";
  document.getElementById("race-add-btn").style.display = isCoach ? "flex":"none";
  document.getElementById("excel-import-wrap").style.display = isCoach ? "block":"none";
  document.getElementById("reset-db-wrap").style.display = isCoach ? "block":"none";

  if(isCoach) renderApodoList();
}

function setAthleteFilter(v){ athleteFilter=v; refresh(); }

let ALL_USERS=[]; 
async function loadUsers(){
  const res=await postToApi("getUsers",{});
  let list=[];
  if(Array.isArray(res)) list=res;
  else if(res && Array.isArray(res.users)) list=res.users;
  else if(res && Array.isArray(res.data)) list=res.data;

  ALL_USERS=list
    .map(u=>typeof u==="string" ? {usuario:u, role:"atleta"} : {usuario:u.usuario||u.user||"", role:u.role||"atleta"})
    .filter(u=>u.usuario);
}

function knownAthletes(){
  const fromUsers=ALL_USERS.filter(u=>u.role!=="profesor").map(u=>u.usuario);
  const fromDB=DB.map(w=>w.usuario).filter(Boolean);
  return [...new Set([...fromUsers, ...fromDB])].sort();
}

function buildAthleteFilterOptions(){
  const sels=[document.getElementById("athlete-filter-select"), document.getElementById("hist-athlete-filter-select")].filter(Boolean);
  if(!sels.length) return;
  const users=knownAthletes();
  const opts=["todos",...users];
  const html=opts.map(u=>`<option value="${u}"${athleteFilter===u?" selected":""}>${u==="todos"?"Todos los atletas":u}</option>`).join("");
  sels.forEach(sel=>sel.innerHTML=html);
}

function setDateFilter(){
  histDateFrom=document.getElementById("hist-date-from").value||"";
  histDateTo=document.getElementById("hist-date-to").value||"";
  refresh();
}

function visibleDB(){
  if(!currentUser) return DB;
  if(currentUser.role==="profesor"){
    if(athleteFilter==="todos") return DB;
    return DB.filter(w=>w.usuario===athleteFilter);
  }
  return DB.filter(w=>!w.usuario || w.usuario===currentUser.usuario);
}

async function startApp(){
  document.getElementById("login-overlay").classList.add("hide");
  applyRoleUI();
  document.getElementById("f-date").value = new Date().toISOString().split("T")[0];
  addParcialRow();
  await loadFromCloud();
  await loadRaces();
  await loadUsers();
  refresh();
  if(currentUser && currentUser.role==="profesor") renderApodoList();
}

async function init(){
  currentUser = loadStoredAuth();
  if(!currentUser){
    document.getElementById("login-overlay").classList.remove("hide");
    return;
  }
  await startApp();
}

window.addEventListener("DOMContentLoaded", init);

function refresh(){
  buildAthleteFilterOptions();
  const sorted = [...visibleDB()].sort((a, b) =>
    String(b?.iso || "").localeCompare(String(a?.iso || ""))
);
  lastSorted=sorted;
  updateStats(sorted);buildChartFilters(sorted);buildTableFilters(sorted);buildChart(sorted);renderRows(sorted);
  renderProgressCards(sorted);
  updateCountdown();
  if(currentUser && currentUser.role==="profesor") renderCoachHome();
  document.getElementById("db-status").textContent="Guardado localmente · "+DB.length+" registros";
  if(API_URL){
    document.getElementById("api-status").textContent="Conectado a "+shortUrl(API_URL)+" · "+DB.length+" registros";
  }else{
    document.getElementById("api-status").textContent="Sin conectar — los datos se guardan solo en este navegador.";
  }
}

const DATES_KEY="remo_dates_config";
function loadDatesConfig(){
  try{
    const raw=localStorage.getItem(DATES_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return {loadStart:""};
}

function saveDatesConfig(){
  const loadStart=document.getElementById("load-start-input").value;
  localStorage.setItem(DATES_KEY,JSON.stringify({loadStart}));
  document.getElementById("dates-status").textContent="Bloque de carga guardado ✓";
  updateCountdown();
  showToast("Fecha actualizada.");
}

function getVisibleRaces(){
  const isCoach = currentUser && currentUser.role==="profesor";
  if(!isCoach) return RACES;
  return RACES.filter(r=>!r.coachOwner || r.coachOwner===currentUser.usuario);
}

async function loadRaces(){
  const res=await postToApi("getRaces",{});
  let list = Array.isArray(res) ? res : (res && res.races) ? res.races : [];
  RACES = list
    .filter(r=>r && r.date)
    .map(r=>({...r, date: repairSheetValue(r.date), name: stripTextSafe(r.name)}))
    .filter(r=>/^\d{4}-\d{2}-\d{2}$/.test(r.date))
    .sort((a,b)=>a.date.localeCompare(b.date));
  renderRaces();
  updateCountdown();
}

async function saveRacesToCloud(){
  const safeRaces = RACES.map(r=>({...r, name: textSafe(r.name), date: textSafe(r.date)}));
  await postToApi("saveRaces",{races:safeRaces});
}

async function addRace(){
  if(!currentUser || currentUser.role!=="profesor"){ showToast("Sólo el profesor puede cargar regatas."); return; }
  const name=document.getElementById("race-name-input").value.trim();
  const date=document.getElementById("race-date-new-input").value;
  if(!name || !date){ showToast("Completá nombre y fecha de la regata."); return; }
  RACES.push({id:Date.now().toString(36), name, date, coachOwner:currentUser.usuario});
  RACES.sort((a,b)=>a.date.localeCompare(b.date));
  document.getElementById("race-name-input").value="";
  document.getElementById("race-date-new-input").value="";
  document.getElementById("races-status").textContent="Guardando regata...";
  await saveRacesToCloud();
  renderRaces();
  updateCountdown();
  document.getElementById("races-status").textContent="Regata guardada ✓";
  showToast("Regata agregada.");
}

async function deleteRace(id){
  if(!currentUser || currentUser.role!=="profesor"){ showToast("Sólo el profesor puede borrar regatas."); return; }
  const race=RACES.find(r=>r.id===id);
  if(race && race.coachOwner && race.coachOwner!==currentUser.usuario){
    showToast("Esa regata pertenece a otro entrenador.");
    return;
  }
  RACES = RACES.filter(r=>r.id!==id);
  await saveRacesToCloud();
  renderRaces();
  updateCountdown();
  showToast("Regata eliminada.");
}

function renderRaces(){
  const el=document.getElementById("races-list");
  if(!el) return;
  const isCoach = currentUser && currentUser.role==="profesor";
  const visible=getVisibleRaces();
  if(!visible.length){ el.innerHTML=`<div class="emptyMsg">Todavía no hay regatas cargadas.</div>`; return; }
  const today=new Date(); today.setHours(0,0,0,0);
  el.innerHTML = visible.map(r=>{
    const d=new Date(r.date+"T00:00:00");
    const diff=Math.round((d-today)/86400000);
    const daysTxt = diff>0 ? `Faltan ${diff}d` : (diff===0 ? "¡Es hoy!" : "Ya pasó");
    return `<div class="raceItem">
      <div class="raceInfo"><div class="raceName">${r.name}</div><div class="raceDate">${fmtDate(r.date)}</div></div>
      <div class="raceDays">${daysTxt}</div>
      ${isCoach?`<button class="iconBtn delBtn" onclick="deleteRace('${r.id}')" title="Eliminar">✕</button>`:''}
    </div>`;
  }).join("");
}

function updateCountdown(){
  const cfg=loadDatesConfig();
  document.getElementById("load-start-input").value=cfg.loadStart||"";

  const today=new Date();
  today.setHours(0,0,0,0);

  const upcoming=getVisibleRaces().filter(r=>{
    const d=new Date(r.date+"T00:00:00");
    return Math.round((d-today)/86400000) >= 0;
  }).sort((a,b)=>a.date.localeCompare(b.date));

  const heroEl=document.getElementById("race-hero");
  if(heroEl){
    const nameEl=document.getElementById("race-hero-name");
    const dateEl=document.getElementById("race-hero-date");
    const daysEl=document.getElementById("race-hero-days");
    if(upcoming.length){
      const next=upcoming[0];
      const diffDays=Math.round((new Date(next.date+"T00:00:00")-today)/86400000);
      heroEl.classList.remove("empty");
      heroEl.classList.toggle("today", diffDays===0);
      nameEl.textContent=next.name;
      dateEl.textContent=fmtDate(next.date);
      daysEl.textContent = diffDays===0 ? "¡Es hoy!" : (diffDays===1 ? "Falta 1 día" : `Faltan ${diffDays} días`);
    }else{
      heroEl.classList.add("empty");
      heroEl.classList.remove("today");
      nameEl.textContent="Sin regatas cargadas";
      dateEl.textContent="Tu entrenador todavía no cargó ninguna.";
      daysEl.textContent="---";
    }
  }

  const weekEl=document.getElementById("load-week");
  if(cfg.loadStart){
    const start=new Date(cfg.loadStart+"T00:00:00");
    const diffDays=Math.round((today-start)/86400000);
    const week=Math.floor(diffDays/7)+1;
    weekEl.textContent = week>0 ? week : (diffDays<0?"—":"1");
  }else{
    weekEl.textContent="---";
  }
}

function renderCoachHome(){
  const athletes=knownAthletes();
  const athEl=document.getElementById("coach-stat-athletes");
  if(!athEl) return; 
  athEl.textContent=athletes.length;

  const today=new Date(); today.setHours(0,0,0,0);
  const sessions7=DB.filter(w=>{
    if(!w.iso) return false;
    const diff=Math.round((today-new Date(w.iso+"T00:00:00"))/86400000);
    return diff>=0 && diff<7;
  }).length;
  document.getElementById("coach-stat-sessions7").textContent=sessions7;

  const upcoming=getVisibleRaces().filter(r=>{
    const d=new Date(r.date+"T00:00:00");
    return Math.round((d-today)/86400000) >= 0;
  }).sort((a,b)=>a.date.localeCompare(b.date));
  document.getElementById("coach-days-to-race").textContent =
    upcoming.length ? Math.round((new Date(upcoming[0].date+"T00:00:00")-today)/86400000) : "---";

  const cfg=loadDatesConfig();
  const weekEl=document.getElementById("coach-load-week");
  if(cfg.loadStart){
    const start=new Date(cfg.loadStart+"T00:00:00");
    const diffDays=Math.round((today-start)/86400000);
    const week=Math.floor(diffDays/7)+1;
    weekEl.textContent = week>0 ? week : (diffDays<0?"—":"1");
  }else{
    weekEl.textContent="---";
  }

  const listEl=document.getElementById("team-list");
  if(!athletes.length){
    listEl.innerHTML=`<div class="emptyMsg">Todavía no hay atletas registrados.</div>`;
    return;
  }
  listEl.innerHTML=athletes.map(u=>{
    const rows=DB.filter(w=>w.usuario===u).sort((a,b)=>String(b.iso||"").localeCompare(String(a.iso||"")));
    const last=rows[0];
    const lastTxt=last?`${last.date} · ${last.type}`:"Sin sesiones";
    const safeU=u.replace(/'/g,"&#39;");
    return `<div class="teamAthleteCard" onclick="viewAthlete('${safeU}')">
      <div>
        <div class="name">${u}</div>
        <div class="meta">${rows.length} sesion${rows.length!==1?'es':''}</div>
        <div class="lastSession">${lastTxt}</div>
      </div>
      <div class="goBtn">Ver →</div>
    </div>`;
  }).join("");
}

function viewAthlete(usuario){
  athleteFilter=usuario;
  changePage("historial");
}

function renderProgressCards(sorted){ 
  const todayEl = document.getElementById("prog-today"); 
  const cmpEl = document.getElementById("prog-compare"); 
  if(!todayEl || !cmpEl) return; 

  // Tomar el último entrenamiento registrado
  const last = sorted[0];

  if(!last){ 
    todayEl.innerHTML = `<div class="progTitle">Último entrenamiento</div>
      <div class="progEmpty">Todavía no cargaste ningún entrenamiento.</div>`; 

    cmpEl.innerHTML = `<div class="progTitle">Vs. la vez anterior</div>
      <div class="progEmpty">No hay entrenamientos para comparar.</div>`; 
    return; 
  } 

  // Mostrar el último entrenamiento
  todayEl.innerHTML = `<div class="progTitle">Último entrenamiento</div> 
    <div class="progType">${last.type}</div> 
    <div class="progVal">${last.split||'—'} /500m</div>`; 

  // Buscar el entrenamiento anterior del mismo tipo
  const prev = sorted.find(w =>
    w !== last &&
    normType(w.type) === normType(last.type) &&
    (w.usuario||'') === (last.usuario||'')
  ); 

  if(!prev || !isTimeSplit(last.split) || !isTimeSplit(prev.split)){ 
    cmpEl.innerHTML = `<div class="progTitle">Vs. la vez anterior</div>
      <div class="progEmpty">Sin un registro previo igual para comparar.</div>`; 
    return; 
  } 

  const diffSec = toSec(last.split) - toSec(prev.split);  
  const better = diffSec < 0; 
  const diffTxt = (better?"-":"+") + 
    fmtSec(Math.abs(diffSec)).replace(/^0:/,'') + 
    "/500m"; 

  let parcialTxt = ""; 

  if(last.parciales && prev.parciales && 
     last.parciales.length && prev.parciales.length){ 

    const n = Math.min(last.parciales.length, prev.parciales.length); 
    let diffs=[]; 

    for(let i=0;i<n;i++){ 
      const a=last.parciales[i], b=prev.parciales[i]; 

      if(a && b && isTimeSplit(a.split) && isTimeSplit(b.split)){ 
        diffs.push(toSec(a.split)-toSec(b.split)); 
      } 
    } 

    if(diffs.length){ 
      const avg = diffs.reduce((x,y)=>x+y,0)/diffs.length; 

      parcialTxt = `<div class="progDiff ${avg<0?'better':'worse'}" style="font-size:11px;">
        Parciales: ${(avg<0?"-":"+") + fmtSec(Math.abs(avg)).replace(/^0:/,'')} en promedio
      </div>`; 
    } 
  } 

  cmpEl.innerHTML = `<div class="progTitle">Vs. "${prev.date}"</div> 
    <div class="progType">${last.type}</div> 
    <div class="progVal">${prev.split} → ${last.split}</div> 
    <div class="progDiff ${better?'better':'worse'}">
      ${better?'▼':'▲'} ${diffTxt}
    </div> 
    ${parcialTxt}`; 
}

function updateStats(sorted){
  const totalM = sorted.reduce((a, b) => a + (Number(b.meters) || 0), 0);
  const rows2k = sorted.filter(w => {
    const is2k = Number(w.meters) === 2000;
    const isTest = String(w.cat || "").trim().toLowerCase() === "test";
    const hasValidSplit = isTimeSplit(w.split);
    return is2k && isTest && hasValidSplit;
  });
  
  let best2kSplit = null;
  let best2kTotal = null;

  if (rows2k.length > 0) {
    const times2k = rows2k.map(w => {
      const splitSec = toSec(w.split);
      let totalSec = splitSec * 4; 
      if (w.totaltime && isTimeSplit(w.totaltime)) {
        totalSec = toSec(w.totaltime);
      }
      return { splitSec, totalSec };
    });

    const bestRow = times2k.reduce((min, cur) => cur.totalSec < min.totalSec ? cur : min, times2k[0]);
    best2kSplit = bestRow.splitSec;
    best2kTotal = bestRow.totalSec;
  }

  document.getElementById("stat-dist").textContent = (totalM / 1000).toFixed(1) + "k";
  document.getElementById("stat-sessions").textContent = sorted.length;
  document.getElementById("stat-avg").textContent = best2kSplit ? fmtSec(best2kSplit) : "---";
  document.getElementById("stat-best").textContent = best2kTotal ? fmtSec(best2kTotal) : "---";
}

function buildTypeLabelMap(sorted){
  const map={};
  sorted.forEach(w=>{
    const key=normType(w.type);
    if(key && !(key in map)) map[key]=(w.type||key).trim();
  });
  return map;
}

function buildChartFilters(sorted){
  TYPE_LABELS=buildTypeLabelMap(sorted);
  const types=[...new Set(sorted.filter(w=>isTimeSplit(w.split)).map(w=>normType(w.type)))]
    .sort((a,b)=>(TYPE_LABELS[a]||a).localeCompare(TYPE_LABELS[b]||b,"es"));
  const opts=["avg_z1","avg_z2",...types];
  const sel=document.getElementById("chart-filter-select");
  const labels={avg_z1:"Promedio Zona 1",avg_z2:"Promedio Zona 2",...TYPE_LABELS};
  sel.innerHTML=opts.map(t=>`<option value="${t}"${chartFilter===t?" selected":""}>${labels[t]||t}</option>`).join("");
}

function buildTableFilters(sorted){
  TYPE_LABELS=buildTypeLabelMap(sorted);
  const types=[...new Set(sorted.map(w=>normType(w.type)))]
    .sort((a,b)=>(TYPE_LABELS[a]||a).localeCompare(TYPE_LABELS[b]||b,"es"));
  const opts=["todos",...types];
  const sel=document.getElementById("table-filter-select");
  sel.innerHTML=opts.map(t=>`<option value="${t}"${tableFilter===t?" selected":""}>${t==="todos"?"Todos los ejercicios":(TYPE_LABELS[t]||t)}</option>`).join("");
}

function matchesZone(w,zoneCat){
  if(w.cat===zoneCat) return true;
  if(zoneCat==="z2" && w.cat==="steady") return true;
  return false;
}

function buildChart(sorted){
  const isZoneAvg = chartFilter==="avg_z1" || chartFilter==="avg_z2";
  const canvas=document.getElementById("areaChart");
  if(!canvas) return;
  const ctx=canvas.getContext("2d");

  let data, color, label;
  if(isZoneAvg){
    const zoneCat = chartFilter==="avg_z1" ? "z1" : "z2";
    data=sorted.filter(w=>isTimeSplit(w.split) && matchesZone(w,zoneCat));
    data=[...data].sort((a,b)=>a.iso.localeCompare(b.iso));
    const meta=CAT[zoneCat];
    color=meta.color;
    label="Tendencia de paso — "+meta.label;
  }else{
    data=sorted.filter(w=>isTimeSplit(w.split) && normType(w.type)===chartFilter);
    data=[...data].sort((a,b)=>a.iso.localeCompare(b.iso));
    color="#c1793c";
    label="Tendencia de paso — "+(TYPE_LABELS[chartFilter]||chartFilter);
  }
  document.getElementById("chart-label").textContent=label;

  if(areaChart) areaChart.destroy();
  areaChart=new Chart(ctx,{
    type:"line",
    data:{
      labels:data.map(w=>w.date),
      datasets:[{
        data:data.map(w=>toSec(w.split)),
        borderColor:color,
        backgroundColor:color+"22",
        fill:true,
        tension:0.3,
        pointRadius:3,
        pointBackgroundColor:data.map(w=>(CAT[w.cat]||CAT.steady).color),
        pointHoverRadius:5,
        borderWidth:2
      }]
    },
    options:{
      responsive:true,
      plugins:{
        legend:{display:false},
        tooltip:{
          callbacks:{
            label:ctx=>{
              const w=data[ctx.dataIndex];
              const lines=[`Split: ${fmtSec(ctx.parsed.y)} /500m`,`Distancia: ${w.meters.toLocaleString()}m`];
              if(w.totaltime) lines.push(`T. Total: ${w.totaltime}`);
              else lines.push(`T. Total: ${fmtTotal(toSec(w.split)*w.meters/500+getRestSeconds(w.type))}`);
              if(w.spm) lines.push(`SPM: ${w.spm}`);
              return lines;
            },
            title:ctx=>{
              const w=data[ctx[0].dataIndex];
              return w.date+" – "+w.type;
            }
          }
        }
      },
      scales:{
        y:{reverse:true,ticks:{callback:v=>fmtSec(v),font:{size:9},color:"#8a7f6c"},grid:{color:"#efe8d9"},border:{display:false}},
        x:{ticks:{font:{size:7},maxRotation:50,color:"#8a7f6c"},grid:{display:false},border:{display:false}}
      }
    }
  });
}

function renderRows(sorted){
  let data=[...sorted];
  if(histDateFrom) data=data.filter(w=>String(w.iso||"")>=histDateFrom);
  if(histDateTo) data=data.filter(w=>String(w.iso||"")<=histDateTo);
  if(tableFilter!=="todos") data=data.filter(w=>normType(w.type)===tableFilter);
  document.getElementById("result-count").textContent=data.length===sorted.length?"":data.length+" resultado"+(data.length!==1?"s":"");
  if(!data.length){document.getElementById("rows").innerHTML=`<div class="emptyMsg">Sin sesiones para este filtro.</div>`;return;}

  document.getElementById("rows").innerHTML=data.map((w,i)=>{
    const meta=CAT[w.cat]||CAT.steady;

    let totalDisp="—";
    if(w.totaltime){totalDisp=w.totaltime;}
    else if(isTimeSplit(w.split)){
      const rowingSec=toSec(w.split)*w.meters/500;
      totalDisp=fmtTotal(rowingSec+getRestSeconds(w.type));
    }

    const hasPar=w.parciales&&w.parciales.length>0;
    const uid="r"+i+"_"+(w.iso?.replace(/-/g,'')||'');
    const safeType=w.type?.replace(/'/g,"&#39;")||'';

    let detailHTML='';
    if(hasPar){
      detailHTML=`<div class="splitDetailHeader"><span>#</span><span>T. acum.</span><span>Metros</span><span>/500m</span><span>SPM</span></div>
        ${w.parciales.map((p)=>`<div class="splitDetailRow">
          <span>${p.label||'—'}</span>
          <span>${p.time||'—'}</span>
          <span>${p.meters?(p.meters.toLocaleString()+'m'):'—'}</span>
          <span>${p.split||'—'}</span>
          <span>${p.spm||'—'}</span>
        </div>`).join('')}`;
    }

    const isCoach = currentUser && currentUser.role==="profesor";
    const ownerTxt = isCoach && w.usuario ? `<div class="sessionOwner">${w.usuario}</div>` : '';
    const safeUser = (w.usuario||'').replace(/'/g,"&#39;");

    let chipsHTML = `
      <div class="chip"><span class="chipLbl">Metros</span><span class="chipVal">${w.meters.toLocaleString()}m</span></div>
      <div class="chip"><span class="chipLbl">Total</span><span class="chipVal">${totalDisp}</span></div>
      <div class="chip"><span class="chipLbl">SPM</span><span class="chipVal">${w.spm||'—'}</span></div>
    `;

    if (w.medium === 'agua') {
      chipsHTML += `
        <div class="chip"><span class="chipLbl">Bote</span><span class="chipVal">${w.boat || 'Single'}</span></div>
        <div class="chip"><span class="chipLbl">% Coach</span><span class="chipVal">${w.percentage ? w.percentage + '%' : '—'}</span></div>
      `;
    }

    return `<div class="sessionCard compact" style="--cat-color:${meta.color}">
      <div class="sessionTop">
        <div class="sessionDateRow">
          <span class="sessionDate">${w.date}</span>
          ${ownerTxt}
        </div>
        <div class="sessionActions">
          <button class="editBtn iconBtn" onclick="editSession('${w.iso}','${safeType}',${w.meters},'${safeUser}')" title="Editar">✎</button>
          <button class="delBtn iconBtn" onclick="deleteSession('${w.iso}','${safeType}',${w.meters},'${safeUser}')" title="Eliminar">✕</button>
        </div>
      </div>

      <div class="sessionHeadRow">
        <div class="sessionTypeCol">
          <div class="sessionType">${w.type}</div>
          <span class="tag" style="background:${meta.bg};color:${meta.color};">${meta.label}</span>
        </div>
        <div class="sessionSplitBig">
          <span class="val">${w.split}</span>
          <span class="unit">/500m</span>
        </div>
      </div>

      <div class="sessionChips">
        ${chipsHTML}
      </div>

      ${hasPar ? `
        <button class="expandBtn" id="eb-${uid}" onclick="toggleDetail('${uid}', ${w.parciales.length})">▸ Ver ${w.parciales.length} split${w.parciales.length!==1?'s':''}</button>
        <div class="sessionExpand" id="det-${uid}">
          <div>
            <div class="splitDetail">${detailHTML}</div>
          </div>
        </div>
      ` : ''}
    </div>`;
  }).join("");
}

function toggleDetail(uid, count){
  const d=document.getElementById('det-'+uid);
  const b=document.getElementById('eb-'+uid);
  if(!d || !b) return;
  const open=d.classList.toggle('show');
  b.classList.toggle('open',open);
  
  if(count !== undefined) {
    const label = count !== 1 ? 'splits' : 'split';
    b.textContent = (open ? '▾ Ocultar' : '▸ Ver') + ' ' + count + ' ' + label;
  } else {
    const num=b.textContent.match(/\d+/)?.[0]||'';
    const label=`split${num!='1'?'s':''}`;
    b.textContent=(open?'▾ Ocultar':'▸ Ver')+' '+num+' '+label;
  }
}

function setChartFilter(t){chartFilter=t;refresh();}
function setTableFilter(t){tableFilter=t;refresh();}

function suggestZone(spm){
  if(!spm) return null;
  if(spm===17) return {cat:"z1",label:"Zona 1",confidence:"ideal (17 spm)"};
  if(spm===16) return {cat:"z1",label:"Zona 1",confidence:"16 spm"};
  if(spm===19) return {cat:"z2",label:"Zona 2",confidence:"ideal (19 spm)"};
  if(spm===18||spm===20) return {cat:"z2",label:"Zona 2",confidence:spm+" spm"};
  return null;
}

function updateZoneHint(){
  const spm=parseInt(document.getElementById("f-spm").value)||0;
  const sug=suggestZone(spm);
  const box=document.getElementById("zone-suggestion");
  if(sug){
    box.textContent="Sugerido: "+sug.label+" · "+sug.confidence;
    box.classList.add("hasSuggestion");
  }else if(spm){
    box.textContent=spm+" spm no coincide con Zona 1 (16-17) ni Zona 2 (18-20).";
    box.classList.remove("hasSuggestion");
  }else{
    box.textContent="Sin sugerencia todavía";
    box.classList.remove("hasSuggestion");
  }
}

function applyZoneSuggestion(){
  const spm=parseInt(document.getElementById("f-spm").value)||0;
  const sug=suggestZone(spm);
  if(!sug){
    showToast("Ingresá un SPM entre 16 y 20 para sugerir zona.");
    return;
  }
  document.getElementById("f-cat").value=sug.cat;
  showToast("Zona aplicada: "+sug.label);
}

function copyAiPrompt(){
  const prompt=`Analizá la foto de la pantalla del monitor Concept2 (PM5) que te voy a mandar y devolveme SOLO un bloque de código JSON (sin texto adicional, sin explicación) con esta estructura exacta:

{
  "date": "AAAA-MM-DD",
  "type": "texto corto del entrenamiento, ej: 2000m o 30:00",
  "meters": numero_de_metros_totales,
  "split": "M:SS.d /500m, ej: 2:05.3 (o W123 si está en watts)",
  "totaltime": "tiempo total M:SS o H:MM:SS",
  "spm": numero_de_paladas_por_minuto_promedio,
  "cat": "z1 | z2 | intervals | sprint | test | watts",
  "parciales": [
    {"time":"tiempo acumulado M:SS.d","meters":metros_del_tramo,"split":"split /500m del tramo","spm":spm_del_tramo}
  ]
}

Si la pantalla no muestra parciales, dejá "parciales" como un array vacío []. No inventes datos que no se vean en la foto.`;
  const btn=document.getElementById("ai-copy-btn");
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(prompt).then(()=>{
      showToast("Instrucciones copiadas. Pegalas junto con la foto en tu IA.");
      if(btn){
        const original=btn.textContent;
        btn.textContent="Copiado ✓";
        btn.classList.add("copied");
        setTimeout(()=>{ btn.textContent=original; btn.classList.remove("copied"); },2000);
      }
    }).catch(()=>{
      showToast("No se pudo copiar automáticamente. Copiá el texto manualmente.");
    });
  }else{
    showToast("Tu navegador no permite copiar automáticamente.");
  }
}

function loadFromAiCode(){
  const raw=document.getElementById("ai-code-input").value.trim();
  if(!raw){showToast("Pegá primero el código que te dio la IA.");return;}

  let data;
  try{
    const cleaned=raw.replace(/```json/gi,"").replace(/```/g,"").trim();
    data=JSON.parse(cleaned);
  }catch(err){
    showToast("Ese texto no es un JSON válido. Revisá que se haya copiado completo.");
    return;
  }

  if(data.date) document.getElementById("f-date").value=data.date;
  if(data.type) document.getElementById("f-type").value=data.type;
  if(data.meters) document.getElementById("f-meters").value=data.meters;
  if(data.split) document.getElementById("f-split").value=data.split;
  if(data.totaltime) document.getElementById("f-totaltime").value=data.totaltime;
  if(data.spm) document.getElementById("f-spm").value=data.spm;
  if(data.cat) document.getElementById("f-cat").value=data.cat;
  updateZoneHint();

  document.getElementById("parciales-container").innerHTML="";
  parcialCount=0;
  if(Array.isArray(data.parciales) && data.parciales.length){
    data.parciales.forEach(p=>addParcialRow(p));
  }else{
    addParcialRow();
  }

  document.getElementById("ai-code-input").value="";
  showToast("Datos cargados en el formulario. Revisá antes de guardar.");
}

let parcialCount=0;

function addParcialRow(data={}){
  parcialCount++;
  const n=parcialCount;
  const div=document.createElement('div');
  div.className='partial';
  div.id='pr-'+n;
  div.innerHTML=`
    <span class="tramoLabel">Tramo ${n}</span>
    <input type="text" placeholder="4:00.0" value="${data.time||''}" title="Tiempo del tramo (según el método de verificación elegido arriba)">
    <input type="number" placeholder="851" value="${data.meters||''}" title="Metros">
    <input type="text" placeholder="2:21.0" value="${data.split||''}" title="Split /500m">
    <input type="number" placeholder="18" value="${data.spm||''}" title="SPM">
    <button type="button" class="removeRow" onclick="document.getElementById('pr-${n}').remove(); reindexParcials();">✕</button>`;
  document.getElementById('parciales-container').appendChild(div);
}

function reindexParcials(){
  const rows=document.querySelectorAll('#parciales-container .partial');
  parcialCount=0;
  rows.forEach((row)=>{
    parcialCount++;
    const span=row.querySelector('.tramoLabel');
    if(span) span.textContent=`Tramo ${parcialCount}`;
  });
}

let editingKey=null; 

function editSession(iso,type,meters,usuario){
  const entry=DB.find(w=>w.iso===iso&&w.type===type&&w.meters===meters&&(w.usuario||'')===(usuario||''));
  if(!entry){showToast("No se encontró la sesión.");return;}
  if(currentUser && currentUser.role!=="profesor" && (entry.usuario||'')!==currentUser.usuario){
    showToast("Sólo el profesor puede editar trabajos de otros atletas.");
    return;
  }

  editingKey={iso,type,meters,usuario:entry.usuario||""};

  document.getElementById("f-date").value=entry.iso;
  document.getElementById("f-type").value=entry.type;
  document.getElementById("f-meters").value=entry.meters;
  document.getElementById("f-split").value=entry.split;
  document.getElementById("f-totaltime").value=entry.totaltime||"";
  document.getElementById("f-spm").value=entry.spm||"";
  document.getElementById("f-cat").value=entry.cat;
  
  // Novedad: Llenar y mostrar los campos de agua
  document.getElementById("f-medium").value=entry.medium || "ergo";
  toggleWaterOptions();
  document.getElementById("f-boat").value=entry.boat || "Single";
  document.getElementById("f-percentage").value=entry.percentage || "";

  updateZoneHint();

  document.getElementById("parciales-container").innerHTML="";
  parcialCount=0;
  if(entry.parciales && entry.parciales.length){
    entry.parciales.forEach(p=>addParcialRow(p));
  }else{
    addParcialRow();
  }

  document.getElementById("edit-banner").style.display="flex";
  document.getElementById("btn-add-session").textContent="Guardar cambios";
  document.getElementById("train-title").textContent="Editar sesión";

  changePage("train");
  showToast("Editando sesión — modificá los campos y guardá.");
}

function cancelEdit(){
  editingKey=null;
  document.getElementById("edit-banner").style.display="none";
  document.getElementById("btn-add-session").textContent="Guardar Entrenamiento";
  document.getElementById("train-title").textContent="Nuevo Entrenamiento";
  document.getElementById("f-type").value="";
  document.getElementById("f-meters").value="";
  document.getElementById("f-split").value="";
  document.getElementById("f-totaltime").value="";
  document.getElementById("f-spm").value="";
  
  document.getElementById("f-medium").value="ergo";
  toggleWaterOptions();
  document.getElementById("f-boat").value="Single";
  document.getElementById("f-percentage").value="";

  document.getElementById("parciales-container").innerHTML="";
  parcialCount=0;
  addParcialRow();
  updateZoneHint();
}

let isSavingSession=false; 

async function addSession(){
  if(isSavingSession) return; 
  const iso = document.getElementById("f-date").value;
  const type = document.getElementById("f-type").value.trim();
  const meters = parseInt(document.getElementById("f-meters").value) || 0;
  const split = document.getElementById("f-split").value.trim();
  const totaltime = document.getElementById("f-totaltime").value.trim();
  const spm = parseInt(document.getElementById("f-spm").value) || 0;
  const cat = document.getElementById("f-cat").value;

  const medium = document.getElementById("f-medium").value;
  const boat = medium === "agua" ? document.getElementById("f-boat").value : "";
  const percentage = medium === "agua" ? document.getElementById("f-percentage").value : "";

  if(!iso || !type || !meters || !split){
    showToast("Completá fecha, tipo, metros y split.");
    return;
  }
  if(!validSplit(split)){
    showToast("Formato inválido de split.");
    return;
  }

  const parciales = [...document.querySelectorAll("#parciales-container .partial")].map(r => {
    const labelText = r.querySelector('.tramoLabel').textContent;
    const ins = r.querySelectorAll("input");
    return {
      label: labelText,
      time: ins[0].value.trim(),
      meters: parseInt(ins[1].value) || 0,
      split: ins[2].value.trim(),
      spm: parseInt(ins[3].value) || 0
    };
  }).filter(p => p.time || p.meters || p.split);

  const parCheck = validateParciales(meters, totaltime, parciales);
  if(!parCheck.ok){
    showToast(parCheck.msg);
    return;
  }

  const months = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
  const [y, m, d] = iso.split("-");
  const dateStr = `${d} ${months[parseInt(m)-1]} ${y}`;

  const owner = editingKey ? (editingKey.usuario || (currentUser?currentUser.usuario:"")) : (currentUser?currentUser.usuario:"");
  
  // Guardamos también medium, boat, percentage
  const entry = { iso, date: dateStr, type, meters, split, totaltime, spm, cat, medium, boat, percentage, parciales, parcialMode: parCheck.mode||"", usuario: owner };

  isSavingSession = true;
  const btn = document.getElementById("btn-add-session");
  btn.disabled = true;
  btn.textContent = "Guardando...";

  try{
    document.getElementById("api-status").textContent = "Guardando en Google Sheets...";

    const wasEditing = editingKey;

    if(wasEditing){
      await postToApi("delete", wasEditing);
      DB = DB.filter(w=>!(w.iso===wasEditing.iso && normType(w.type)===normType(wasEditing.type) && w.meters===wasEditing.meters && (w.usuario||'')===(wasEditing.usuario||'')));
      cancelEdit();
    }

    await postToApi("add", { session: toApiSafeSession(entry) });

    DB.push(entry);
    refresh();
    document.getElementById("api-status").textContent = "Guardado en Google Sheets ✓ · " + DB.length + " registros";

    document.getElementById("f-type").value = "";
    document.getElementById("f-meters").value = "";
    document.getElementById("f-split").value = "";
    document.getElementById("f-totaltime").value = "";
    document.getElementById("f-spm").value = "";
    document.getElementById("f-medium").value="ergo";
    toggleWaterOptions();
    document.getElementById("f-boat").value="Single";
    document.getElementById("f-percentage").value="";

    document.getElementById("parciales-container").innerHTML = "";
    parcialCount = 0;
    addParcialRow();

    showToast("Guardado en Google Sheets ✓");

    loadFromCloud();
  } finally {
    setTimeout(()=>{
      isSavingSession = false;
      btn.disabled = false;
      btn.textContent = editingKey ? "Guardar cambios" : "Guardar Entrenamiento";
    }, 700);
  }
}

let pendingDelete=null;

function deleteSession(iso,type,meters,usuario){
  const entry=DB.find(w=>w.iso===iso&&w.type===type&&w.meters===meters&&(w.usuario||'')===(usuario||''));
  if(!entry) return;
  if(currentUser && currentUser.role!=="profesor" && (entry.usuario||'')!==currentUser.usuario){
    showToast("Sólo el profesor puede eliminar trabajos de otros atletas.");
    return;
  }
  pendingDelete={iso,type,meters,usuario:entry.usuario||""};
  document.getElementById("delete-session-desc").textContent=
    `${entry.date} · ${entry.type} · ${entry.meters.toLocaleString()}m`;
  const input=document.getElementById("delete-confirm-input");
  input.value="";
  document.getElementById("delete-confirm-btn").disabled=true;
  document.getElementById("delete-session-overlay").classList.add("show");
  setTimeout(()=>input.focus(),50);
}

function checkDeleteConfirmInput(){
  const val=document.getElementById("delete-confirm-input").value.trim().toUpperCase();
  document.getElementById("delete-confirm-btn").disabled = (val!=="ELIMINAR");
}

function cancelDeleteSession(){
  pendingDelete=null;
  document.getElementById("delete-session-overlay").classList.remove("show");
}

async function confirmDeleteSession(){
  if(!pendingDelete) return;
  const { iso, type, meters, usuario } = pendingDelete;

  DB = DB.filter(w=>!(w.iso===iso && normType(w.type)===normType(type) && w.meters===meters && (w.usuario||'')===(usuario||'')));
  refresh();
  document.getElementById("delete-session-overlay").classList.remove("show");
  showToast("Sesión eliminada ✓");
  pendingDelete = null;

  document.getElementById("api-status").textContent = "Eliminando en Google Sheets...";

  await postToApi("delete", { iso, type, meters, usuario });
  loadFromCloud();
}

function exportJSON(){
  const blob=new Blob([JSON.stringify(DB,null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob);const a=document.createElement("a");
  a.href=url;a.download="stroke_journal.json";a.click();URL.revokeObjectURL(url);showToast("stroke_journal.json guardado.");
}

function importJSON(e){
  const file=e.target.files[0];if(!file) return;
  const reader=new FileReader();
  reader.onload=ev=>{try{const data=JSON.parse(ev.target.result);if(!Array.isArray(data))throw new Error();DB=data;saveLS();refresh();showToast(data.length+" sesiones importadas ✓");}catch(err){showToast("Error: archivo JSON inválido.");}};
  reader.readAsText(file);e.target.value="";
}

function rcGuessCat(work, zone){
  const w=(work||"").toString();
  const z=(zone||"").toString().toUpperCase();
  const isInterval=/[×x]/i.test(w) && /\d/.test(w);
  if(isInterval) return "intervals";
  if(/Z?5|\bAN\b|SPRINT|MAX/.test(z)) return "sprint";
  if(/Z?4|\bTR\b|THR|\bAT\b/.test(z)) return "intervals";
  if(/Z?3/.test(z)) return "intervals";
  return "steady";
}
function rcPaceStr(timeSec, meters){
  if(!meters) return "";
  return fmtSec(timeSec/meters*500);
}
function rcAvgSpm(splits){
  if(!splits || !splits.length) return 0;
  let prevT=0, totalT=0, weighted=0;
  splits.forEach(sp=>{
    const segT=Math.max((sp.accTimeSeconds||0)-prevT,0);
    weighted += (sp.rpm||0)*segT;
    totalT += segT;
    prevT = sp.accTimeSeconds||prevT;
  });
  if(totalT<=0) return Math.round(splits.reduce((a,b)=>a+(b.rpm||0),0)/splits.length);
  return Math.round(weighted/totalT);
}
function rcParciales(splits){
  if(!splits || splits.length<2) return null;
  let prevT=0, prevM=0;
  return splits.map(sp=>{
    const segT=Math.max((sp.accTimeSeconds||0)-prevT,0);
    const segM=Math.max((sp.accMeters||0)-prevM,0);
    prevT=sp.accTimeSeconds||prevT; prevM=sp.accMeters||prevM;
    return {label:String(sp.number), time:fmtSec(sp.accTimeSeconds||0), meters:segM, split:segM>0?rcPaceStr(segT,segM):"", spm:sp.rpm||0};
  });
}
function convertRowCoachTraining(t){
  const iso=t.date;
  const meters=t.totalMeters;
  const timeSec=t.totalTimeSeconds;
  const type=t.work;
  if(!iso || !meters || !timeSec || !type) return null;
  const row={
    iso, date:fmtDate(iso), type, meters,
    split:rcPaceStr(timeSec, meters),
    spm:rcAvgSpm(t.splits),
    cat:rcGuessCat(type, t.zone)
  };
  row.totaltime=fmtTotal(timeSec);
  const parciales=rcParciales(t.splits);
  if(parciales) row.parciales=parciales;
  return row;
}
function importRowCoachJSON(e){
  const file=e.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=ev=>{
    try{
      const backup=JSON.parse(ev.target.result);
      const trainings=(backup && backup.data && Array.isArray(backup.data.trainings)) ? backup.data.trainings : null;
      if(!trainings) throw new Error("Formato no reconocido");
      let added=0, skipped=0;
      trainings.forEach(t=>{
        const row=convertRowCoachTraining(t);
        if(!row){ skipped++; return; }
        const dup=DB.some(w=>w.iso===row.iso && w.type===row.type && w.meters===row.meters && w.split===row.split);
        if(dup){ skipped++; return; }
        DB.push(row); added++;
      });
      saveLS(); refresh();
      showToast(added+" sesiones importadas desde RowCoach"+(skipped?(" ("+skipped+" omitidas)"):"")+" ✓");
    }catch(err){
      showToast("Error: backup de RowCoach inválido.");
    }
  };
  reader.readAsText(file); e.target.value="";
}

const APODO_MAP_KEY="remo_apodo_map_v1";
function loadApodoMap(){ try{return JSON.parse(localStorage.getItem(APODO_MAP_KEY))||{};}catch(e){return {};} }
function saveApodoMap(map){ localStorage.setItem(APODO_MAP_KEY, JSON.stringify(map)); }

function renderApodoList(){
  const el=document.getElementById("apodo-list");
  if(!el) return;
  const map=loadApodoMap();
  const keys=Object.keys(map);
  if(!keys.length){
    el.innerHTML=`<div class="emptyMsg">Todavía no se cargó ningún Excel con apodos nuevos.</div>`;
    return;
  }
  const usuarios=knownAthletes();
  el.innerHTML=keys.sort().map(k=>{
    const current=map[k]||"";
    const opts=[`<option value=""${!current?' selected':''}>Sin asignar (omitir)</option>`]
      .concat(usuarios.map(u=>`<option value="${u}"${u===current?' selected':''}>${u}</option>`))
      .join("");
    const safeK=k.replace(/'/g,"&#39;");
    return `<div class="apodoRow">
      <div class="apodoNick" title="${k}">${k}</div>
      <select onchange="updateApodoMapping('${safeK}',this.value)">${opts}</select>
      <button class="iconBtn delBtn" onclick="deleteApodoMapping('${safeK}')" title="Eliminar">✕</button>
    </div>`;
  }).join("");
}

function updateApodoMapping(key,usuario){
  const map=loadApodoMap();
  map[key]=usuario||null;
  saveApodoMap(map);
  showToast("Mapeo actualizado.");
}

function deleteApodoMapping(key){
  const map=loadApodoMap();
  delete map[key];
  saveApodoMap(map);
  renderApodoList();
  showToast("Apodo eliminado del mapeo. La próxima vez que aparezca se va a volver a preguntar.");
}
function normHeader(h){
  return String(h||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim();
}
function normApodo(n){ return normHeader(n).replace(/\s+/g," "); }

function dateFromFilename(filename){
  const base=filename.replace(/\.[^.]+$/,"");
  const matches=[...base.matchAll(/(\d{1,2})-(\d{1,2})(?:-(\d{2,4}))?/g)];
  if(!matches.length) return null;
  const m=matches[matches.length-1]; 
  let [,d,mo,y]=m;
  const today=new Date();
  if(!y) y=String(today.getFullYear());
  if(y.length===2) y="20"+y;
  d=d.padStart(2,"0"); mo=mo.padStart(2,"0");
  let iso=`${y}-${mo}-${d}`;
  if(new Date(iso+"T00:00:00") > new Date(today.toDateString())){
    iso=`${parseInt(y)-1}-${mo}-${d}`;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

function excelSplitToStr(v){
  if(v instanceof Date && !isNaN(v)){
    const mi=v.getMinutes(), se=v.getSeconds(), ms=Math.round(v.getMilliseconds()/100);
    return `${mi}:${String(se).padStart(2,"0")}.${ms}`;
  }
  let s=String(v??"").trim();
  const m=s.match(/^(\d+)\.(\d{2})\.(\d{1,2})$/);
  if(m) return `${m[1]}:${m[2]}.${m[3]}`;
  return s.replace(/^(\d+)\./, "$1:"); 
}

function findHeaderRowIndex(rows){
  for(let i=0;i<Math.min(rows.length,15);i++){
    const norm=(rows[i]||[]).map(normHeader);
    const hasNombre=norm.some(h=>h==="nombre"||h.includes("nombre"));
    const hasRankOrProm=norm.some(h=>h.includes("rank")||h.includes("puesto")||h.includes("prom"));
    if(hasNombre && hasRankOrProm) return i;
  }
  return -1;
}

function findColIndex(headerRow,aliases){
  const norm=headerRow.map(normHeader);
  for(const alias of aliases){
    const idx=norm.findIndex(h=>h===alias || h.includes(alias));
    if(idx!==-1) return idx;
  }
  return -1;
}

function guessTypeCat(type){
  return rcGuessCat(type,"");
}

async function importExcel(e){
  const file=e.target.files[0]; if(!file) return;
  const statusEl=document.getElementById("excel-import-status");
  statusEl.textContent="Leyendo archivo...";
  try{
    const buf=await file.arrayBuffer();
    const wb=XLSX.read(buf,{type:"array",cellDates:true});
    const sheet=wb.Sheets[wb.SheetNames[0]];
    const rows=XLSX.utils.sheet_to_json(sheet,{header:1,raw:true,defval:""});
    if(!rows.length) throw new Error("El archivo está vacío.");

    const headerIdx=findHeaderRowIndex(rows);
    if(headerIdx===-1) throw new Error("No encontré la fila de encabezados (RANKING / Nombre / Prom / RPM).");
    const headerRow=rows[headerIdx];

    const colNombre=findColIndex(headerRow,["nombre","atleta"]);
    const colProm=findColIndex(headerRow,["prom","promedio","split"]);
    const colRpm=findColIndex(headerRow,["rpm","spm"]);
    if(colNombre===-1 || colProm===-1) throw new Error("No encontré las columnas de Nombre y Promedio.");

    let mainType="";
    for(let i=0;i<headerIdx;i++){
      const texts=(rows[i]||[]).filter(c=>typeof c==="string" && c.trim().length>2);
      if(texts.length===1){ mainType=texts[0].trim(); }
    }
    if(!mainType) mainType=file.name.replace(/\.[^.]+$/,"").replace(/_/g," ").trim();

    const iso=dateFromFilename(file.name);
    if(!iso) throw new Error("No pude sacar la fecha del nombre del archivo (esperaba algo como '22-07'). Renombralo o cargá esta sesión a mano.");
    const dateStr=fmtDate(iso);

    const usedCols=new Set([colNombre,colProm,colRpm]);

    const apodoMap=loadApodoMap();
    const nuevosApodos=[];
    const filas=[];

    for(let i=headerIdx+1;i<rows.length;i++){
      const r=rows[i]||[];
      const nombreRaw=String(r[colNombre]||"").trim();
      const promRaw=r[colProm];
      if(!nombreRaw || promRaw===""||promRaw==null) continue; 
      const split=excelSplitToStr(promRaw);
      if(!/\d/.test(split)) continue;

      const rpm=colRpm!==-1?(parseInt(r[colRpm])||0):0;
      let nota="";
      r.forEach((c,ci)=>{
        if(usedCols.has(ci)) return;
        if(typeof c==="string" && c.trim() && !/^\d+$/.test(c.trim())) nota=(nota?nota+" · ":"")+c.trim();
      });

      let type=mainType;
      if(nota && /\d+\s*[x×]\s*\d/i.test(nota)){ type=nota; nota=""; }

      const key=normApodo(nombreRaw);
      if(!(key in apodoMap) && !nuevosApodos.includes(key)) nuevosApodos.push(key);

      filas.push({nombreRaw, key, split, rpm, nota, type});
    }

    if(!filas.length){ statusEl.textContent="No encontré filas de atletas debajo del encabezado."; e.target.value=""; return; }

    if(nuevosApodos.length){
      const usuariosConocidos=knownAthletes().join(", ")||"(todavía no hay ninguno registrado)";
      for(const key of nuevosApodos){
        const original=filas.find(f=>f.key===key).nombreRaw;
        const resp=window.prompt(
          `¿A qué usuario (login) corresponde el apodo "${original}"?\n\nUsuarios existentes: ${usuariosConocidos}\n\nDejá vacío para omitir siempre las filas de "${original}".`,
          ""
        );
        apodoMap[key]=resp?resp.trim():null;
      }
      saveApodoMap(apodoMap);
      renderApodoList();
    }

    let added=0, skipped=0, omitidos=0;
    const nuevos=[];
    for(const f of filas){
      const usuario=apodoMap[f.key];
      if(!usuario){ omitidos++; continue; }
      const dup=DB.some(w=>w.iso===iso && normType(w.type)===normType(f.type) && (w.usuario||"")===usuario);
      if(dup){ skipped++; continue; }
      nuevos.push({
        iso, date:dateStr, type:f.type, meters:0, split:f.split, totaltime:"",
        spm:f.rpm, cat:guessTypeCat(f.type), parciales:[], usuario,
        ...(f.nota?{nota:f.nota}:{})
      });
    }

    if(!nuevos.length){
      statusEl.textContent=`Nada nuevo para agregar (${skipped} ya estaban, ${omitidos} apodos sin usuario asignado).`;
      e.target.value=""; return;
    }

    statusEl.textContent=`Subiendo ${nuevos.length} sesiones a Google Sheets...`;
    for(const row of nuevos){
      await postToApi("add",{session:toApiSafeSession(row)});
      added++;
      statusEl.textContent=`Subiendo... ${added}/${nuevos.length}`;
    }

    await loadFromCloud();
    statusEl.textContent=`${added} sesiones importadas ✓ (${skipped} ya existían, ${omitidos} apodos sin asignar) — ${mainType}, ${dateStr}.`;
    showToast(added+" sesiones importadas desde Excel ✓");
  }catch(err){
    console.error(err);
    statusEl.textContent="Error al importar: "+err.message;
    showToast("Error al leer el Excel: "+err.message);
  }
  e.target.value="";
}

function exportCSV(){
  const header="Fecha ISO,Fecha,Tipo,Metros,Split /500m,T.Total,SPM,Categoría\n";
  const rows=DB.map(w=>`${w.iso},"${w.date}","${w.type}",${w.meters},"${w.split}","${w.totaltime||''}",${w.spm},${w.cat}`).join("\n");
  const blob=new Blob([header+rows],{type:"text/csv;charset=utf-8;"});
  const url=URL.createObjectURL(blob);const a=document.createElement("a");
  a.href=url;a.download="stroke_journal.csv";a.click();URL.revokeObjectURL(url);showToast("CSV exportado.");
}

function showClearConfirm(){document.getElementById("clear-overlay").classList.add("show");}
function clearDB(){
  const toDelete=[...DB];
  DB=[];
  saveLS();
  refresh();
  document.getElementById("clear-overlay").classList.remove("show");
  showToast("Base de datos reseteada localmente.");
  toDelete.forEach(w=>postToApi("delete",{iso:w.iso,type:w.type,meters:w.meters,usuario:w.usuario}));
}

function showToast(msg){const t=document.getElementById("toast");t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2800);}

document.getElementById("f-date").value=new Date().toISOString().slice(0,10);
init();