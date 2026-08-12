import { supabase } from './supabase-config.js';

// ----- ELEMENTOS DOM -----
const pinScreen = document.getElementById('pinScreen');
const mainScreen = document.getElementById('mainScreen');
const pinInput = document.getElementById('pinInput');
const pinError = document.getElementById('pinError');
const checadorNameText = document.getElementById('checadorNameText');
const ubicacionChip = document.getElementById('ubicacionChip');
const ubicacionText = document.getElementById('ubicacionText');
const unitsGrid = document.getElementById('unitsGrid');
const unitsEmpty = document.getElementById('unitsEmpty');
const toast = document.getElementById('toast');
const toastText = document.getElementById('toastText');

const ubicacionOverlay = document.getElementById('ubicacionOverlay');
const ubicacionInput = document.getElementById('ubicacionInput');
const ubicacionSaveBtn = document.getElementById('ubicacionSaveBtn');
const ubicacionCancelBtn = document.getElementById('ubicacionCancelBtn');
const ubicacionTitle = document.getElementById('ubicacionTitle');

const incidentOverlay = document.getElementById('incidentOverlay');
const incidentUnitLabel = document.getElementById('incidentUnitLabel');
const incidentCancelBtn = document.getElementById('incidentCancelBtn');
const incidentTardeBtn = document.getElementById('incidentTardeBtn');
const incidentNoPresentoBtn = document.getElementById('incidentNoPresentoBtn');

let currentChecador = null;
let currentUbicacion = null;
let driversChannel = null;
let toastTimer = null;
let longPressTimer = null;
let longPressFired = false;
let pendingIncidentDriver = null;
let allowUbicacionCancel = false;

// ----- LOGIN CON PIN -----
document.getElementById('pinSubmit').addEventListener('click', tryPin);
pinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryPin(); });

async function tryPin() {
  const pin = pinInput.value.trim();
  if (!pin) return;

  const { data: checador, error } = await supabase
    .from('checadores')
    .select('*')
    .eq('pin', pin)
    .single();

  if (checador && !error) {
    localStorage.setItem('rss_checador_id', checador.id);
    pinError.classList.add('hidden');
    pinInput.value = '';
    unlock(checador);
  } else {
    pinError.classList.remove('hidden');
  }
}

function unlock(checador) {
  currentChecador = checador;
  pinScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
  checadorNameText.textContent = checador.name;
  setupUbicacion();
  loadUnits();
  initRealtime();
  if (window.lucide) lucide.createIcons();
}

// ----- CIERRE DE SESIÓN -----
function goToPinScreen() {
  if (driversChannel) supabase.removeChannel(driversChannel);
  localStorage.removeItem('rss_checador_id');
  currentChecador = null;
  mainScreen.classList.add('hidden');
  pinScreen.classList.remove('hidden');
  pinInput.value = '';
}

document.getElementById('switchChecadorBtn').addEventListener('click', goToPinScreen);
document.getElementById('backToPinBtn').addEventListener('click', goToPinScreen);

// ----- UBICACIÓN (texto libre, con memoria en este dispositivo) -----
function setupUbicacion() {
  const saved = localStorage.getItem('rss_checador_ubicacion');
  if (saved) {
    currentUbicacion = saved;
    ubicacionText.textContent = currentUbicacion;
    allowUbicacionCancel = true;
  } else {
    openUbicacionOverlay(true);
  }
}

function openUbicacionOverlay(isFirstTime) {
  allowUbicacionCancel = !isFirstTime;
  ubicacionTitle.textContent = isFirstTime ? '¿Dónde estás hoy?' : 'Cambiar ubicación';
  ubicacionCancelBtn.classList.toggle('hidden', isFirstTime);
  ubicacionInput.value = isFirstTime ? '' : (currentUbicacion || '');
  ubicacionOverlay.classList.add('show');
  setTimeout(() => ubicacionInput.focus(), 50);
}

function closeUbicacionOverlay() {
  ubicacionOverlay.classList.remove('show');
}

ubicacionChip.addEventListener('click', () => openUbicacionOverlay(false));
ubicacionCancelBtn.addEventListener('click', () => {
  if (allowUbicacionCancel) closeUbicacionOverlay();
});
ubicacionInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveUbicacion(); });
ubicacionSaveBtn.addEventListener('click', saveUbicacion);

function saveUbicacion() {
  const val = ubicacionInput.value.trim();
  if (!val) return;
  currentUbicacion = val;
  localStorage.setItem('rss_checador_ubicacion', val);
  ubicacionText.textContent = val;
  allowUbicacionCancel = true;
  closeUbicacionOverlay();
}

// ----- CARGAR UNIDADES (todos los conductores, de todos los dueños) -----
async function loadUnits() {
  const { data: drivers, error } = await supabase
    .from('drivers')
    .select('id, name, route, owner_id, unit:unit_id ( id, unit_number )')
    .order('unit_id', { ascending: true });

  if (error) {
    console.error('Error cargando unidades:', error);
    unitsEmpty.textContent = 'No se pudieron cargar las unidades. Revisa tu conexión.';
    unitsEmpty.classList.remove('hidden');
    unitsGrid.innerHTML = '';
    return;
  }

  renderUnitsGrid(drivers || []);
}

function renderUnitsGrid(drivers) {
  const withUnit = drivers.filter((d) => d.unit && d.unit.unit_number != null);
  withUnit.sort((a, b) => Number(a.unit.unit_number) - Number(b.unit.unit_number));

  if (withUnit.length === 0) {
    unitsEmpty.classList.remove('hidden');
    unitsGrid.innerHTML = '';
    return;
  }
  unitsEmpty.classList.add('hidden');

  unitsGrid.innerHTML = withUnit.map((d) => {
    const routeColor = d.route === 'capilla' ? 'var(--cempasuchil)' : (d.route === 'secundaria' ? 'var(--agave)' : 'var(--ink-soft)');
    return `
      <button class="unit-btn" data-driver-id="${d.id}" data-unit-id="${d.unit.id}"
              data-driver-name="${escapeAttr(d.name || 'Conductor')}"
              data-route="${d.route || ''}"
              data-owner-id="${d.owner_id}">
        <span class="unit-number">${d.unit.unit_number}</span>
        <span class="unit-dot" style="background:${routeColor};"></span>
      </button>
    `;
  }).join('');

  attachUnitButtonHandlers();
  if (window.lucide) lucide.createIcons();
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

// ----- REALTIME: refrescar la cuadrícula si cambian conductores/ramales -----
function initRealtime() {
  driversChannel = supabase
    .channel('checador-drivers-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'drivers' }, () => loadUnits())
    .subscribe();
}

// ----- TAP (registro normal) vs LONG-PRESS (incidencia) -----
function attachUnitButtonHandlers() {
  document.querySelectorAll('.unit-btn').forEach((btn) => {
    btn.addEventListener('pointerdown', () => {
      longPressFired = false;
      longPressTimer = setTimeout(() => {
        longPressFired = true;
        if (navigator.vibrate) navigator.vibrate([15, 40, 15]);
        openIncidentOverlay(btn);
      }, 500);
    });

    const cancelPress = () => clearTimeout(longPressTimer);
    btn.addEventListener('pointerup', () => {
      clearTimeout(longPressTimer);
      if (!longPressFired) registerCheckpoint(btn, 'a_tiempo');
    });
    btn.addEventListener('pointerleave', cancelPress);
    btn.addEventListener('pointercancel', cancelPress);
  });
}

async function registerCheckpoint(btn, status) {
  if (navigator.vibrate) navigator.vibrate(20);

  const driverId = btn.dataset.driverId;
  const unitId = btn.dataset.unitId;
  const driverName = btn.dataset.driverName;
  const route = btn.dataset.route;
  const ownerId = btn.dataset.ownerId;
  const unitNumber = btn.querySelector('.unit-number').textContent;

  const { error } = await supabase
    .from('checador_events')
    .insert({
      checador_id: currentChecador.id,
      driver_id: driverId,
      unit_id: unitId,
      owner_id: ownerId,
      route: route || null,
      ubicacion: currentUbicacion,
      status,
    });

  if (error) {
    console.error('Error guardando checador_events:', error);
    showToast(`No se pudo registrar la unidad ${unitNumber}. Intenta de nuevo.`, 'error');
    return;
  }

  const time = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  const routeLabel = route === 'capilla' ? 'Por Capilla' : (route === 'secundaria' ? 'Por Secundaria' : 'Sin ramal');

  if (status === 'a_tiempo') {
    showToast(`Unidad ${unitNumber} — ${driverName} — ${routeLabel} — ${time}`, 'ok');
  } else if (status === 'retraso') {
    showToast(`Unidad ${unitNumber} — ${driverName} — Llegó tarde — ${time}`, 'warn');
  } else if (status === 'no_se_presento') {
    showToast(`Unidad ${unitNumber} — ${driverName} — No se presentó — ${time}`, 'warn');
  }
}

// ----- TARJETA DE CONFIRMACIÓN (toast) -----
function showToast(message, kind) {
  clearTimeout(toastTimer);
  toastText.textContent = message;
  toast.classList.remove('ok', 'warn', 'error');
  toast.classList.add(kind);
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2000);
}

// ----- INCIDENCIAS (long-press) -----
function openIncidentOverlay(btn) {
  pendingIncidentDriver = btn;
  const unitNumber = btn.querySelector('.unit-number').textContent;
  incidentUnitLabel.textContent = `Unidad ${unitNumber} — ${btn.dataset.driverName}`;
  incidentOverlay.classList.add('show');
}

function closeIncidentOverlay() {
  incidentOverlay.classList.remove('show');
  pendingIncidentDriver = null;
}

incidentCancelBtn.addEventListener('click', closeIncidentOverlay);
incidentOverlay.addEventListener('click', (e) => {
  if (e.target.id === 'incidentOverlay') closeIncidentOverlay();
});
incidentTardeBtn.addEventListener('click', () => {
  const btn = pendingIncidentDriver;
  closeIncidentOverlay();
  if (btn) registerCheckpoint(btn, 'retraso');
});
incidentNoPresentoBtn.addEventListener('click', () => {
  const btn = pendingIncidentDriver;
  closeIncidentOverlay();
  if (btn) registerCheckpoint(btn, 'no_se_presento');
});
