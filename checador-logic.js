import { supabase } from './supabase-config.js';

// ----- HELPER: enganchar eventos sin tronar si el elemento no existe -----
function on(el, event, handler) {
  if (!el) {
    console.warn('[checador] Elemento no encontrado para el evento:', event);
    return;
  }
  el.addEventListener(event, handler);
}

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

const unitDriversOverlay = document.getElementById('unitDriversOverlay');
const unitDriversTitle = document.getElementById('unitDriversTitle');
const unitDriversList = document.getElementById('unitDriversList');
const unitDriversCancelBtn = document.getElementById('unitDriversCancelBtn');

const incidentOverlay = document.getElementById('incidentOverlay');
const incidentUnitLabel = document.getElementById('incidentUnitLabel');
const incidentCancelBtn = document.getElementById('incidentCancelBtn');
const incidentTardeBtn = document.getElementById('incidentTardeBtn');
const incidentNoPresentoBtn = document.getElementById('incidentNoPresentoBtn');

const pinSubmitBtn = document.getElementById('pinSubmit');
const backToPinBtn = document.getElementById('backToPinBtn');
const switchChecadorBtn = document.getElementById('switchChecadorBtn'); // puede no existir, es opcional
const sendSummaryBtn = document.getElementById('sendSummaryBtn');

let currentChecador = null;
let currentUbicacion = null;
let driversChannel = null;
let toastTimer = null;
let longPressTimer = null;
let longPressFired = false;
let pendingIncidentDriver = null; // objeto {driverId, unitId, driverName, route, ownerId, unitNumber}
let allowUbicacionCancel = false;
let unitsById = {}; // { unitId: { unit_number, drivers: [...] } }

// ----- LOGIN CON PIN -----
on(pinSubmitBtn, 'click', tryPin);
on(pinInput, 'keydown', (e) => { if (e.key === 'Enter') tryPin(); });

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

on(backToPinBtn, 'click', goToPinScreen);
on(switchChecadorBtn, 'click', goToPinScreen); // solo si existe en el HTML

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

on(ubicacionChip, 'click', () => openUbicacionOverlay(false));
on(ubicacionCancelBtn, 'click', () => {
  if (allowUbicacionCancel) closeUbicacionOverlay();
});
on(ubicacionInput, 'keydown', (e) => { if (e.key === 'Enter') saveUbicacion(); });
on(ubicacionSaveBtn, 'click', saveUbicacion);

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

function routeColor(route) {
  return route === 'capilla' ? 'var(--cempasuchil)' : (route === 'secundaria' ? 'var(--agave)' : 'var(--ink-soft)');
}

function routeLabel(route) {
  return route === 'capilla' ? 'Por Capilla' : (route === 'secundaria' ? 'Por Secundaria' : 'Sin ramal');
}

// Agrupa a los conductores por unidad, porque una misma unidad puede
// tener más de un conductor (turnos / días distintos).
function renderUnitsGrid(drivers) {
  const withUnit = drivers.filter((d) => d.unit && d.unit.unit_number != null);

  unitsById = {};
  withUnit.forEach((d) => {
    const uid = d.unit.id;
    if (!unitsById[uid]) unitsById[uid] = { unit_number: d.unit.unit_number, drivers: [] };
    unitsById[uid].drivers.push({
      driverId: d.id,
      driverName: d.name || 'Conductor',
      route: d.route || '',
      ownerId: d.owner_id,
      unitId: uid,
      unitNumber: d.unit.unit_number,
    });
  });

  const units = Object.entries(unitsById).map(([id, val]) => ({ id, ...val }));
  units.sort((a, b) => Number(a.unit_number) - Number(b.unit_number));

  if (units.length === 0) {
    unitsEmpty.classList.remove('hidden');
    unitsGrid.innerHTML = '';
    return;
  }
  unitsEmpty.classList.add('hidden');

  unitsGrid.innerHTML = units.map((u) => {
    const dotColor = u.drivers.length === 1 ? routeColor(u.drivers[0].route) : 'var(--ink-soft)';
    return `
      <button class="unit-btn" data-unit-id="${u.id}">
        <span class="unit-number">${u.unit_number}</span>
        <span class="unit-dot" style="background:${dotColor};"></span>
        ${u.drivers.length > 1 ? `<span class="text-[10px] font-display font-semibold" style="color:var(--ink-soft);">${u.drivers.length} choferes</span>` : ''}
      </button>
    `;
  }).join('');

  attachUnitButtonHandlers();
  if (window.lucide) lucide.createIcons();
}

// ----- REALTIME: refrescar la cuadrícula si cambian conductores/ramales -----
function initRealtime() {
  driversChannel = supabase
    .channel('checador-drivers-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'drivers' }, () => loadUnits())
    .subscribe();
}

// ----- TOCAR UNA UNIDAD -> ABRIR LISTA DE CONDUCTORES -----
function attachUnitButtonHandlers() {
  document.querySelectorAll('.unit-btn').forEach((btn) => {
    btn.addEventListener('click', () => openUnitDriversOverlay(btn.dataset.unitId));
  });
}

function openUnitDriversOverlay(unitId) {
  const unit = unitsById[unitId];
  if (!unit) return;

  unitDriversTitle.innerHTML = `<i data-lucide="users"></i> Unidad ${unit.unit_number}`;
  unitDriversList.innerHTML = unit.drivers.map((d, idx) => `
    <button class="driver-row" data-driver-idx="${idx}">
      <span class="driver-name">${escapeAttr(d.driverName)}</span>
      ${d.route ? `<span class="route-badge" style="background:color-mix(in srgb, ${routeColor(d.route)} 18%, var(--paper-2)); color:${routeColor(d.route)};">${routeLabel(d.route)}</span>` : ''}
    </button>
  `).join('');

  // Enganchar tap (registro normal) vs long-press (incidencia) en cada fila
  unitDriversList.querySelectorAll('.driver-row').forEach((row) => {
    const driverData = unit.drivers[Number(row.dataset.driverIdx)];
    row.addEventListener('pointerdown', () => {
      longPressFired = false;
      longPressTimer = setTimeout(() => {
        longPressFired = true;
        if (navigator.vibrate) navigator.vibrate([15, 40, 15]);
        closeUnitDriversOverlay();
        openIncidentOverlay(driverData);
      }, 500);
    });
    const cancelPress = () => clearTimeout(longPressTimer);
    row.addEventListener('pointerup', () => {
      clearTimeout(longPressTimer);
      if (!longPressFired) {
        closeUnitDriversOverlay();
        registerCheckpoint(driverData, 'a_tiempo');
      }
    });
    row.addEventListener('pointerleave', cancelPress);
    row.addEventListener('pointercancel', cancelPress);
  });

  unitDriversOverlay.classList.add('show');
  if (window.lucide) lucide.createIcons();
}

function closeUnitDriversOverlay() {
  unitDriversOverlay.classList.remove('show');
}

on(unitDriversCancelBtn, 'click', closeUnitDriversOverlay);
on(unitDriversOverlay, 'click', (e) => {
  if (e.target.id === 'unitDriversOverlay') closeUnitDriversOverlay();
});

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

// ----- REGISTRAR CHECADA -----
async function registerCheckpoint(driverData, status) {
  if (navigator.vibrate) navigator.vibrate(20);

  const { driverId, unitId, driverName, route, ownerId, unitNumber } = driverData;

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
  const rLabel = routeLabel(route);

  if (status === 'a_tiempo') {
    showToast(`Unidad ${unitNumber} — ${driverName} — ${rLabel} — ${time}`, 'ok');
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

// ----- INCIDENCIAS (long-press sobre el nombre del conductor) -----
function openIncidentOverlay(driverData) {
  pendingIncidentDriver = driverData;
  incidentUnitLabel.textContent = `Unidad ${driverData.unitNumber} — ${driverData.driverName}`;
  incidentOverlay.classList.add('show');
}

function closeIncidentOverlay() {
  incidentOverlay.classList.remove('show');
  pendingIncidentDriver = null;
}

on(incidentCancelBtn, 'click', closeIncidentOverlay);
on(incidentOverlay, 'click', (e) => {
  if (e.target.id === 'incidentOverlay') closeIncidentOverlay();
});
on(incidentTardeBtn, 'click', () => {
  const driverData = pendingIncidentDriver;
  closeIncidentOverlay();
  if (driverData) registerCheckpoint(driverData, 'retraso');
});
on(incidentNoPresentoBtn, 'click', () => {
  const driverData = pendingIncidentDriver;
  closeIncidentOverlay();
  if (driverData) registerCheckpoint(driverData, 'no_se_presento');
});

// ----- RESUMEN DEL DÍA -> WHATSAPP -----
const STATUS_LINE = {
  a_tiempo: { icon: '✅', label: 'A tiempo' },
  retraso: { icon: '🟠', label: 'Llegó tarde' },
  no_se_presento: { icon: '🔴', label: 'No se presentó' },
};

on(sendSummaryBtn, 'click', sendDaySummary);

async function sendDaySummary() {
  if (!currentChecador) return;

  // Abrimos la ventana YA, de inmediato en el clic (si no, el navegador
  // la bloquea como pop-up porque hay una espera de por medio para
  // cargar los datos, y el clic "ya no cuenta" como el gesto que la abrió).
  const summaryWindow = window.open('', '_blank');

  sendSummaryBtn.disabled = true;
  const originalHtml = sendSummaryBtn.innerHTML;
  sendSummaryBtn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4"></i> Armando resumen…';
  if (window.lucide) lucide.createIcons();

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data: events, error } = await supabase
    .from('checador_events')
    .select('*, driver:driver_id ( name ), unit:unit_id ( unit_number )')
    .eq('checador_id', currentChecador.id)
    .gte('created_at', startOfDay.toISOString())
    .order('created_at', { ascending: true });

  sendSummaryBtn.disabled = false;
  sendSummaryBtn.innerHTML = originalHtml;
  if (window.lucide) lucide.createIcons();

  if (error) {
    console.error('Error armando el resumen del día:', error);
    if (summaryWindow) summaryWindow.close();
    showToast('No se pudo armar el resumen. Intenta de nuevo.', 'error');
    return;
  }

  if (!events || events.length === 0) {
    if (summaryWindow) summaryWindow.close();
    showToast('Todavía no tienes registros hoy para enviar.', 'warn');
    return;
  }

  const todayLabel = new Date().toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' });

  let text = `📋 *Resumen del día — Ruta San Simón (R-18)*\n`;
  text += `Checador: ${currentChecador.name}\n`;
  text += `Fecha: ${todayLabel}\n\n`;

  events.forEach((ev) => {
    const time = ev.created_at
      ? new Date(ev.created_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
      : '--:--';
    const unitNum = ev.unit?.unit_number != null ? ev.unit.unit_number : '?';
    const driverName = ev.driver?.name || 'Conductor';
    const st = STATUS_LINE[ev.status] || { icon: '•', label: ev.status || '—' };
    const lugar = ev.ubicacion ? ` · pasó por *${ev.ubicacion}*` : '';
    text += `${st.icon} ${time} · Unidad ${unitNum} · ${driverName}${lugar} · ${st.label}\n`;
  });

  text += `\nTotal: ${events.length} registros`;

  const url = `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
  if (summaryWindow) {
    summaryWindow.location.href = url;
  } else {
    // El navegador bloqueó la ventana desde un inicio; lo intentamos una vez más.
    window.open(url, '_blank');
  }
}
