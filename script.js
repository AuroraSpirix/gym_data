// ── SUPABASE ───────────────────────────────────────────
const SUPABASE_URL = 'https://ivjrmhprkgsviyqmvfdv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_XsA5mZBS--3Wpj6aUuI3oQ_HdBv05rP';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── STATE ──────────────────────────────────────────────
const state = {
  currentWorkout: null,
  currentExerciseId: null,
  user: null,
  data: defaultData()
};

const FOOD_TAGS = [
  { id: 'breakfast', label: 'BREAKFAST' },
  { id: 'lunch', label: 'LUNCH' },
  { id: 'dinner', label: 'DINNER' },
  { id: 'snacks', label: 'SNACKS' },
  { id: 'desserts', label: 'DESSERTS' },
  { id: 'ingredients', label: 'INGREDIENTS' }
];

function defaultData() {
  return {
    workouts: { push: [], pull: [], legs: [] },
    foods: [],
    foodLibrary: []
  };
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function findExercise() {
  return state.data.workouts[state.currentWorkout]
    .find(e => e.id === state.currentExerciseId);
}

// ── SYNC INDICATOR ─────────────────────────────────────
let syncTimeout = null;
function showSync(msg = '↑', isError = false) {
  const el = document.getElementById('sync-indicator');
  el.textContent = msg;
  el.className = 'sync-indicator' + (isError ? ' error' : '');
  clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => el.classList.add('hidden'), 1800);
}

// ── LOCAL CACHE ────────────────────────────────────────
function saveLocal() {
  try { localStorage.setItem('grind_data', JSON.stringify(state.data)); } catch {}
}
function loadLocal() {
  try { return JSON.parse(localStorage.getItem('grind_data')) || defaultData(); } catch { return defaultData(); }
}

// ── SUPABASE: GYM ──────────────────────────────────────
async function syncGymToCloud() {
  if (!state.user || !state.currentWorkout) return;
  const today = new Date().toDateString();
  const exercises = state.data.workouts[state.currentWorkout];

  const todayExercises = exercises.map(ex => {
    const todaySets = ex.sets.filter(s => new Date(s.date).toDateString() === today);
    return { id: ex.id, name: ex.name, notes: ex.notes || '', sets: todaySets };
  });

  // Always upsert the full exercise list structure (for names/notes persistence)
  const fullSnapshot = exercises.map(ex => ({
    id: ex.id, name: ex.name, notes: ex.notes || '',
    sets: ex.sets
  }));

  const { error } = await sb.from('gym_logs').upsert({
    user_id: state.user.id,
    date: today,
    type: state.currentWorkout,
    snapshot: fullSnapshot,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id,date,type' });

  if (error) { showSync('⚠', true); console.error(error); }
  else { showSync('✓'); queueDailySnapshot(); }
}

async function loadGymFromCloud() {
  if (!state.user) return;
  // Load all gym logs to rebuild full exercise history
  const { data, error } = await sb.from('gym_logs')
    .select('*')
    .eq('user_id', state.user.id)
    .order('date', { ascending: false });

  if (error) { console.error(error); return; }
  if (!data || !data.length) return;

  // Rebuild workouts: merge all historical snapshots, latest wins for each exercise
  const workouts = { push: [], pull: [], legs: [] };

  // Process oldest to newest so latest overwrites
  [...data].reverse().forEach(log => {
    const type = log.type;
    if (!workouts[type]) return;
    log.snapshot.forEach(ex => {
      const existing = workouts[type].find(e => e.id === ex.id);
      if (existing) {
        existing.name = ex.name;
        existing.notes = ex.notes || '';
        // Merge sets by date, avoiding duplicates
        ex.sets.forEach(s => {
          const dup = existing.sets.find(es => es.date === s.date);
          if (!dup) existing.sets.push(s);
        });
      } else {
        workouts[type].push({ ...ex, sets: [...ex.sets] });
      }
    });
  });

  state.data.workouts = workouts;
  saveLocal();
}

// ── SUPABASE: FOODS ─────────────────────────────────────
async function syncFoodsToCloud() {
  if (!state.user) return;
  const today = new Date().toDateString();
  const { error } = await sb.from('food_logs').upsert({
    user_id: state.user.id,
    date: today,
    foods: state.data.foods,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id,date' });

  if (error) { showSync('⚠', true); console.error(error); }
  else { showSync('✓'); queueDailySnapshot(); }
}

async function loadFoodsFromCloud() {
  if (!state.user) return;
  const today = new Date().toDateString();
  const { data, error } = await sb.from('food_logs')
    .select('*')
    .eq('user_id', state.user.id)
    .eq('date', today)
    .single();

  if (error && error.code !== 'PGRST116') { console.error(error); return; }
  if (data) {
    state.data.foods = data.foods || [];
    saveLocal();
  }
  // Re-apply daily reset (in case cloud had stale foods from yesterday)
  checkDailyFoodReset();

async function syncFoodLibraryToCloud() {
  if (!state.user) return;
  const { error } = await sb.from('food_library').upsert({
    user_id: state.user.id,
    items: state.data.foodLibrary,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });

  if (error) { showSync('⚠', true); console.error(error); }
  else showSync('✓');
}

async function loadFoodLibraryFromCloud() {
  if (!state.user) return;
  const { data, error } = await sb.from('food_library')
    .select('items')
    .eq('user_id', state.user.id)
    .single();

  if (error && error.code !== 'PGRST116') { console.error(error); return; }
  if (data?.items) {
    state.data.foodLibrary = data.items;
    saveLocal();
  }
}

function ensureFoodLibrary() {
  if (!Array.isArray(state.data.foodLibrary)) state.data.foodLibrary = [];
  state.data.foodLibrary.forEach(f => {
    if (!f.id) f.id = generateId();
  });
}

function checkDailyFoodReset() {
  const today = new Date().toDateString();
  const lastDay = localStorage.getItem('grind_food_day');
  if (lastDay && lastDay !== today) {
    // New day — clear today's food list (archive already happened via daily_snapshots)
    state.data.foods = [];
    saveLocal();
  }
  localStorage.setItem('grind_food_day', today);
}

// ── CALORIE HISTORY MODAL ──────────────────────────────
document.getElementById('cal-history-btn').addEventListener('click', openCalHistoryModal);
document.getElementById('cal-history-close').addEventListener('click', () => {
  document.getElementById('modal-cal-history').classList.add('hidden');
});
document.getElementById('modal-cal-history').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-cal-history'))
    document.getElementById('modal-cal-history').classList.add('hidden');
});

async function openCalHistoryModal() {
  document.getElementById('modal-cal-history').classList.remove('hidden');
  const body = document.getElementById('cal-history-body');
  body.innerHTML = '<div class="wh-empty">Loading…</div>';

  if (!state.user) { body.innerHTML = '<div class="wh-empty">Not logged in</div>'; return; }

  const { data, error } = await sb.from('daily_snapshots')
    .select('date, total_kcal, total_protein')
    .eq('user_id', state.user.id)
    .order('date', { ascending: false })
    .limit(30);

  if (error || !data?.length) {
    body.innerHTML = '<div class="wh-empty">No history yet</div>';
    return;
  }

  body.innerHTML = '';
  data.forEach(row => {
    const label = new Date(row.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const el = document.createElement('div');
    el.className = 'wh-session';
    el.innerHTML = `
      <div class="wh-date">${label}</div>
      <div class="cal-hist-row">
        <span class="cal-hist-num">${Math.round(row.total_kcal || 0)}</span><span class="cal-hist-label">kcal</span>
        <span class="cal-hist-sep">·</span>
        <span class="cal-hist-num">${Math.round(row.total_protein || 0)}</span><span class="cal-hist-label">g protein</span>
      </div>
    `;
    body.appendChild(el);
  });
}


async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) {
    state.user = session.user;
    await onLogin();
  }
  // else stay on login screen
}

async function onLogin() {
  // Load local first for instant feel, then sync from cloud
  state.data = loadLocal();
  ensureFoodLibrary();
  // Reset today's foods if it's a new day
  checkDailyFoodReset();
  renderExercises();
  showScreen('home');
  await loadGymFromCloud();
  await loadFoodsFromCloud();
  await loadFoodLibraryFromCloud();
  await loadWeightFromCloud();
  ensureFoodLibrary();
  renderExercises();
  // Seal yesterday's snapshot so past days are permanently archived
  await sealYesterdayIfNeeded();
  // Save today's snapshot with current data
  queueDailySnapshot();
}

document.getElementById('login-btn').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');

  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    errEl.textContent = error.message;
    errEl.classList.remove('hidden');
    return;
  }
  state.user = data.user;
  await onLogin();
});

// Allow Enter key on password field
document.getElementById('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('login-btn').click();
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await sb.auth.signOut();
  state.user = null;
  state.data = defaultData();
  showScreen('login');
});

// ── NAVIGATION ─────────────────────────────────────────
function showScreen(id) {
  const current = document.querySelector('.screen.active');
  const next = document.getElementById('screen-' + id);
  if (!next || next === current) return;
  if (current) {
    current.classList.remove('active');
    current.classList.add('leaving');
    setTimeout(() => current.classList.remove('leaving'), 320);
  }
  next.classList.add('active');
}

// ── HOME ───────────────────────────────────────────────
document.getElementById('btn-gym').addEventListener('click', () => showScreen('gym'));
document.getElementById('btn-calories').addEventListener('click', () => {
  resetCalView();
  renderFoods();
  showScreen('calories');
});

// ── BACK BUTTONS ───────────────────────────────────────
document.querySelectorAll('.back-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const leavingCalories = document.getElementById('screen-calories').classList.contains('active');
    if (leavingCalories && btn.dataset.target === 'home') archiveDeselectedFoods();
    showScreen(btn.dataset.target);
  });
});

function archiveDeselectedFoods() {
  ensureFoodLibrary();
  const deselected = state.data.foods.filter(f => f.selected === false);
  let libraryChanged = false;
  deselected.forEach(f => {
    const alreadyInLibrary = state.data.foodLibrary.some(
      lib => lib.name.toLowerCase() === f.name.toLowerCase()
    );
    if (!alreadyInLibrary) {
      state.data.foodLibrary.push({
        id: generateId(),
        name: f.name,
        cal: f.cal,
        protein: f.protein,
        tag: f.tag || 'snacks'
      });
      libraryChanged = true;
    }
  });
  if (libraryChanged) syncFoodLibraryToCloud();
  const before = state.data.foods.length;
  state.data.foods = state.data.foods.filter(f => f.selected !== false);
  if (state.data.foods.length !== before) {
    saveLocal();
    syncFoodsToCloud();
  }
}

// ── GYM SECTIONS ───────────────────────────────────────
['push', 'pull', 'legs'].forEach(type => {
  document.getElementById('btn-' + type).addEventListener('click', () => {
    state.currentWorkout = type;
    document.getElementById('workout-title').textContent = type.toUpperCase();
    renderExercises();
    showScreen('workout');
  });
});

// ── WORKOUT / EXERCISES ────────────────────────────────
function renderExercises() {
  const list = document.getElementById('exercise-list');
  if (!state.currentWorkout) return;
  const exercises = state.data.workouts[state.currentWorkout];
  list.innerHTML = '';
  exercises.forEach((ex) => {
    const item = document.createElement('div');
    item.className = 'exercise-item';
    item.dataset.id = ex.id;
    item.draggable = true;
    item.innerHTML = `
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <div class="exercise-name">${ex.name}</div>
      <span style="color:#444;font-size:18px;">›</span>
    `;
    // Tap on name/arrow opens modal; drag handle is for dragging only
    item.querySelector('.exercise-name').addEventListener('click', () => openSetModal(ex.id));
    item.querySelector('span[style]').addEventListener('click', () => openSetModal(ex.id));

    // Drag events
    item.addEventListener('dragstart', onDragStart);
    item.addEventListener('dragover', onDragOver);
    item.addEventListener('drop', onDrop);
    item.addEventListener('dragend', onDragEnd);

    // Touch drag
    item.querySelector('.drag-handle').addEventListener('touchstart', onTouchDragStart, { passive: true });

    list.appendChild(item);
  });
}

// ── EXERCISE DRAG-TO-REORDER ───────────────────────────
let dragSrcId = null;

function onDragStart(e) {
  dragSrcId = e.currentTarget.dataset.id;
  e.currentTarget.style.opacity = '0.4';
  e.dataTransfer.effectAllowed = 'move';
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const target = e.currentTarget;
  document.querySelectorAll('.exercise-item').forEach(el => el.classList.remove('drag-over'));
  if (target.dataset.id !== dragSrcId) target.classList.add('drag-over');
}

function onDrop(e) {
  e.preventDefault();
  const targetId = e.currentTarget.dataset.id;
  if (!dragSrcId || dragSrcId === targetId) return;
  const arr = state.data.workouts[state.currentWorkout];
  const fromIdx = arr.findIndex(ex => ex.id === dragSrcId);
  const toIdx = arr.findIndex(ex => ex.id === targetId);
  if (fromIdx === -1 || toIdx === -1) return;
  const [moved] = arr.splice(fromIdx, 1);
  arr.splice(toIdx, 0, moved);
  saveLocal();
  syncGymToCloud();
  renderExercises();
}

function onDragEnd(e) {
  e.currentTarget.style.opacity = '';
  document.querySelectorAll('.exercise-item').forEach(el => el.classList.remove('drag-over'));
  dragSrcId = null;
}

// Touch-based drag reorder
let touchDragEl = null, touchDragId = null, touchClone = null;

function onTouchDragStart(e) {
  const item = e.currentTarget.closest('.exercise-item');
  touchDragId = item.dataset.id;
  touchDragEl = item;
  const touch = e.touches[0];
  touchClone = item.cloneNode(true);
  touchClone.style.cssText = `position:fixed;opacity:0.7;pointer-events:none;z-index:999;width:${item.offsetWidth}px;left:${item.getBoundingClientRect().left}px;top:${touch.clientY - item.offsetHeight/2}px;background:#111;`;
  document.body.appendChild(touchClone);
  item.style.opacity = '0.3';

  document.addEventListener('touchmove', onTouchDragMove, { passive: false });
  document.addEventListener('touchend', onTouchDragEnd);
}

function onTouchDragMove(e) {
  e.preventDefault();
  const touch = e.touches[0];
  if (touchClone) touchClone.style.top = (touch.clientY - touchClone.offsetHeight / 2) + 'px';
  // Highlight drop target
  document.querySelectorAll('.exercise-item').forEach(el => {
    const rect = el.getBoundingClientRect();
    el.classList.toggle('drag-over',
      el.dataset.id !== touchDragId &&
      touch.clientY >= rect.top && touch.clientY <= rect.bottom
    );
  });
}

function onTouchDragEnd(e) {
  document.removeEventListener('touchmove', onTouchDragMove);
  document.removeEventListener('touchend', onTouchDragEnd);
  if (touchClone) { touchClone.remove(); touchClone = null; }
  if (touchDragEl) { touchDragEl.style.opacity = ''; }

  const overEl = document.querySelector('.exercise-item.drag-over');
  if (overEl && touchDragId && overEl.dataset.id !== touchDragId) {
    const arr = state.data.workouts[state.currentWorkout];
    const fromIdx = arr.findIndex(ex => ex.id === touchDragId);
    const toIdx = arr.findIndex(ex => ex.id === overEl.dataset.id);
    if (fromIdx !== -1 && toIdx !== -1) {
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      saveLocal();
      syncGymToCloud();
    }
  }
  document.querySelectorAll('.exercise-item').forEach(el => el.classList.remove('drag-over'));
  touchDragEl = null;
  touchDragId = null;
  renderExercises();
}

// ── WORKOUT HISTORY MODAL ──────────────────────────────
document.getElementById('workout-title').addEventListener('click', openWorkoutHistoryModal);

function openWorkoutHistoryModal() {
  const type = state.currentWorkout;
  if (!type) return;
  document.getElementById('workout-history-title').textContent = type.toUpperCase() + ' HISTORY';
  renderWorkoutHistory(type);
  document.getElementById('modal-workout-history').classList.remove('hidden');
}

document.getElementById('workout-history-close').addEventListener('click', () => {
  document.getElementById('modal-workout-history').classList.add('hidden');
});
document.getElementById('modal-workout-history').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-workout-history'))
    document.getElementById('modal-workout-history').classList.add('hidden');
});

function renderWorkoutHistory(type) {
  const body = document.getElementById('workout-history-body');
  body.innerHTML = '';
  const exercises = state.data.workouts[type] || [];
  const today = new Date().toDateString();

  // Collect all past dates across all exercises
  const allDates = new Set();
  exercises.forEach(ex => {
    ex.sets.forEach(s => {
      if (new Date(s.date).toDateString() !== today) allDates.add(s.date);
    });
  });

  // Sort dates newest first
  const sortedDates = [...allDates].sort((a, b) => new Date(b) - new Date(a));

  if (!sortedDates.length) {
    body.innerHTML = '<div class="wh-empty">No past sessions yet</div>';
    return;
  }

  sortedDates.forEach(dateStr => {
    const dayStr = new Date(dateStr).toDateString();
    const label = new Date(dateStr).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    const section = document.createElement('div');
    section.className = 'wh-session';

    let html = `<div class="wh-date">${label}</div>`;
    exercises.forEach(ex => {
      const entry = ex.sets.find(s => new Date(s.date).toDateString() === dayStr);
      if (!entry || !entry.sets.length) return;
      const setsStr = entry.sets.map(r => `${r.weight}kg×${r.reps}`).join('  ');
      html += `<div class="wh-exercise"><span class="wh-ex-name">${ex.name}</span><span class="wh-ex-sets">${setsStr}</span></div>`;
    });

    section.innerHTML = html;
    body.appendChild(section);
  });
}


  const input = document.getElementById('exercise-name-input');
  const name = input.value.trim();
  if (!name) return;
  state.data.workouts[state.currentWorkout].push({ id: generateId(), name, sets: [], notes: '', repMin: null, repMax: null });
  saveLocal();
  syncGymToCloud();
  input.value = '';
  renderExercises();
});

// ── SET MODAL ──────────────────────────────────────────
const titleEl = document.getElementById('modal-exercise-name');
let longPressTimer = null;

function openSetModal(exerciseId) {
  state.currentExerciseId = exerciseId;
  const ex = findExercise();
  titleEl.contentEditable = 'false';
  titleEl.textContent = ex.name;

  // Show rep range
  renderRepRange(ex);

  const notesPanel = document.getElementById('modal-notes-panel');
  const notesText = document.getElementById('modal-notes-text');
  notesPanel.classList.add('hidden');
  document.getElementById('modal-notes-btn').classList.remove('active');
  notesText.value = ex.notes || '';

  document.getElementById('rep-rows').innerHTML = '';

  // Pre-fill today's sets if already logged
  const today = new Date().toDateString();
  const todayEntry = ex.sets.find(s => new Date(s.date).toDateString() === today);
  const todaySets = todayEntry ? todayEntry.sets : [];

  for (let i = 0; i < 3; i++) {
    buildSetRow(i + 1, todaySets[i] || null);
  }

  renderModalHistory(ex);
  document.getElementById('modal-set').classList.remove('hidden');
}

function renderRepRange(ex) {
  const rangeEl = document.getElementById('rep-range-display');
  if (ex.repMin != null || ex.repMax != null) {
    const min = ex.repMin ?? '?';
    const max = ex.repMax ?? '?';
    rangeEl.textContent = `${min}–${max} reps`;
    rangeEl.classList.remove('hidden');
  } else {
    rangeEl.textContent = '';
    rangeEl.classList.add('hidden');
  }
}

// ── INLINE LONG-PRESS RENAME ───────────────────────────
function startLongPress() {
  longPressTimer = setTimeout(() => {
    openExerciseEditPanel();
  }, 500);
}
function cancelLongPress() { clearTimeout(longPressTimer); }

titleEl.addEventListener('mousedown', startLongPress);
titleEl.addEventListener('touchstart', startLongPress, { passive: true });
titleEl.addEventListener('mouseleave', cancelLongPress);
titleEl.addEventListener('mouseup', () => { if (!editPanelJustOpened) cancelLongPress(); });
titleEl.addEventListener('touchend', () => { if (!editPanelJustOpened) cancelLongPress(); });

let editPanelJustOpened = false;

function openExerciseEditPanel() {
  const ex = findExercise();
  if (!ex) return;
  const panel = document.getElementById('exercise-edit-panel');
  document.getElementById('exercise-edit-name').value = ex.name;
  document.getElementById('exercise-edit-rep-min').value = ex.repMin ?? '';
  document.getElementById('exercise-edit-rep-max').value = ex.repMax ?? '';
  panel.classList.remove('hidden');
  editPanelJustOpened = true;
  setTimeout(() => { editPanelJustOpened = false; }, 300);
  document.getElementById('exercise-edit-name').focus();
}

function closeExerciseEditPanel() {
  document.getElementById('exercise-edit-panel').classList.add('hidden');
}

function saveExerciseEditPanel() {
  const ex = findExercise();
  if (!ex) return;
  const name = document.getElementById('exercise-edit-name').value.trim();
  const minVal = document.getElementById('exercise-edit-rep-min').value;
  const maxVal = document.getElementById('exercise-edit-rep-max').value;
  if (name) ex.name = name;
  ex.repMin = minVal !== '' ? parseInt(minVal) : null;
  ex.repMax = maxVal !== '' ? parseInt(maxVal) : null;
  titleEl.textContent = ex.name;
  renderRepRange(ex);
  saveLocal();
  syncGymToCloud();
  renderExercises();
}

['exercise-edit-name', 'exercise-edit-rep-min', 'exercise-edit-rep-max'].forEach(id => {
  document.getElementById(id).addEventListener('input', saveExerciseEditPanel);
});

// Close edit panel when clicking outside the modal box
document.getElementById('modal-set').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-set')) {
    closeExerciseEditPanel();
    closeModal();
  } else if (!editPanelJustOpened &&
             !document.getElementById('exercise-edit-panel').contains(e.target) &&
             !titleEl.contains(e.target)) {
    closeExerciseEditPanel();
  }
});

// ── NOTES ──────────────────────────────────────────────
document.getElementById('modal-notes-btn').addEventListener('click', () => {
  const panel = document.getElementById('modal-notes-panel');
  const btn = document.getElementById('modal-notes-btn');
  const isHidden = panel.classList.toggle('hidden');
  btn.classList.toggle('active', !isHidden);
  if (!isHidden) document.getElementById('modal-notes-text').focus();
});

document.getElementById('modal-notes-text').addEventListener('input', () => {
  const ex = findExercise();
  if (!ex) return;
  ex.notes = document.getElementById('modal-notes-text').value;
  saveLocal();
  syncGymToCloud();
});

// ── AUTO-SAVE SETS ─────────────────────────────────────
let saveDebounce = null;
function autoSaveSets() {
  const rows = document.querySelectorAll('#rep-rows .rep-row');
  const sets = [];
  rows.forEach(row => {
    const weightRaw = row.querySelector('.set-weight-input').value;
    const repsRaw = row.querySelector('.set-reps-input').value;
    const weight = weightRaw === '' ? null : parseFloat(weightRaw);
    const reps = repsRaw === '' ? null : parseInt(repsRaw);
    if (weight !== null && !isNaN(weight) && reps !== null && !isNaN(reps) && reps > 0) {
      sets.push({ weight, reps });
    }
  });
  const ex = findExercise();
  if (!ex) return;
  const today = new Date().toDateString();
  const last = ex.sets[ex.sets.length - 1];
  if (last && new Date(last.date).toDateString() === today) {
    last.sets = sets;
  } else if (sets.length > 0) {
    ex.sets.push({ sets, date: new Date().toISOString() });
  }
  saveLocal();
  renderExercises();
  renderModalHistory(ex);

  clearTimeout(saveDebounce);
  saveDebounce = setTimeout(() => syncGymToCloud(), 1200);
}

function buildSetRow(num, prefill = null) {
  const container = document.getElementById('rep-rows');
  const row = document.createElement('div');
  row.className = 'rep-row';
  row.innerHTML = `
    <span class="rep-num">${num}</span>
    <input type="number" class="text-input set-weight-input" placeholder="–" inputmode="decimal" value="${prefill !== null ? prefill.weight : ''}" />
    <input type="number" class="text-input set-reps-input" placeholder="–" inputmode="numeric" value="${prefill !== null ? prefill.reps : ''}" />
  `;
  row.querySelector('.set-weight-input').addEventListener('input', autoSaveSets);
  row.querySelector('.set-reps-input').addEventListener('input', autoSaveSets);
  container.appendChild(row);
}

function renderModalHistory(ex) {
  const hist = document.getElementById('modal-history');
  hist.innerHTML = '';
  const today = new Date().toDateString();
  const prev = ex.sets.filter(s => new Date(s.date).toDateString() !== today).slice(-3).reverse();
  prev.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'history-row';
    const summary = s.sets.map(r => `${r.weight}kg×${r.reps}`).join('  ');
    const label = new Date(s.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    row.innerHTML = `<span>${label}</span><span>${summary}</span>`;
    hist.appendChild(row);
  });
}



function closeModal() {
  document.getElementById('modal-set').classList.add('hidden');
}

// ── CALORIES ───────────────────────────────────────────
const calView = { mode: 'today', pastTag: null };

function tagLabel(tagId) {
  return FOOD_TAGS.find(t => t.id === tagId)?.label || tagId.toUpperCase();
}

function normalizeTodayFood(f) {
  if (f.selected === undefined) f.selected = true;
  if (!f.portions) f.portions = 1;
}

function foodEntryTotals(f) {
  if (f.selected === false) return { cal: 0, protein: 0 };
  const p = f.portions || 1;
  return { cal: f.cal * p, protein: f.protein * p };
}

function purgeInactiveFoods() {
  const before = state.data.foods.length;
  state.data.foods = state.data.foods.filter(f => f.selected !== false);
  if (state.data.foods.length !== before) {
    saveLocal();
    syncFoodsToCloud();
  }
}

function resetCalView() {
  calView.mode = 'today';
  calView.pastTag = null;
  document.getElementById('past-food-header').classList.add('hidden');
  document.getElementById('cal-action-split').classList.remove('hidden');
  document.getElementById('add-food-panel').classList.add('hidden');
  document.getElementById('past-food-categories').classList.add('hidden');
  document.getElementById('btn-add-food-mode').classList.remove('active');
  document.getElementById('btn-past-food-mode').classList.remove('active');
  renderFoods();
}

function showAddFoodPanel() {
  document.getElementById('cal-action-split').classList.add('hidden');
  document.getElementById('past-food-categories').classList.add('hidden');
  document.getElementById('add-food-panel').classList.remove('hidden');
  document.getElementById('btn-add-food-mode').classList.remove('active');
  document.getElementById('btn-past-food-mode').classList.remove('active');
  calView.mode = 'today';
  calView.pastTag = null;
  document.getElementById('past-food-header').classList.add('hidden');
  renderFoods();
}

function showPastFoodCategories() {
  document.getElementById('cal-action-split').classList.add('hidden');
  document.getElementById('add-food-panel').classList.add('hidden');
  document.getElementById('past-food-categories').classList.remove('hidden');
  document.getElementById('btn-past-food-mode').classList.remove('active');
  document.getElementById('btn-add-food-mode').classList.remove('active');
  calView.mode = 'past-categories';
  calView.pastTag = null;
  document.getElementById('past-food-header').classList.add('hidden');
  renderFoods();
}

function showPastFoodList(tagId) {
  calView.mode = 'past-list';
  calView.pastTag = tagId;
  document.getElementById('cal-action-split').classList.add('hidden');
  document.getElementById('add-food-panel').classList.add('hidden');
  document.getElementById('past-food-categories').classList.add('hidden');
  document.getElementById('past-food-header').classList.remove('hidden');
  document.getElementById('past-food-title').textContent = tagLabel(tagId);
  renderFoods();
}

function buildMealGrid(container, onSelect) {
  container.innerHTML = '';
  FOOD_TAGS.forEach(tag => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'meal-grid-btn';
    btn.textContent = tag.label;
    btn.addEventListener('click', () => onSelect(tag.id));
    container.appendChild(btn);
  });
}

function renderFoods() {
  ensureFoodLibrary();
  const list = document.getElementById('food-list');
  list.innerHTML = '';
  let totalCal = 0, totalProtein = 0;

  if (calView.mode === 'past-list') {
    const items = state.data.foodLibrary.filter(f => f.tag === calView.pastTag);
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'food-item';
      empty.innerHTML = '<span class="food-name" style="color:var(--mid);">No saved foods</span>';
      list.appendChild(empty);
    } else {
      items.forEach((f) => {
        const item = document.createElement('div');
        item.className = 'food-item';
        item.innerHTML = `
          <div class="food-item-main">
            <span class="food-name">${f.name}</span>
            <span class="food-item-hint">TAP TO LOG TODAY</span>
          </div>
          <div class="food-item-actions">
            <div class="food-macros">${f.cal} kcal · ${f.protein}g</div>
            <button type="button" class="edit-food-btn" data-id="${f.id}" title="Edit">✎</button>
          </div>
        `;
        item.querySelector('.food-item-main').addEventListener('click', () => {
          state.data.foods.push({
            name: f.name,
            cal: f.cal,
            protein: f.protein,
            portions: 1,
            selected: true
          });
          saveLocal();
          syncFoodsToCloud();
          resetCalView();
          renderFoods();
        });
        item.querySelector('.edit-food-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          openEditFoodModal(f.id);
        });
        list.appendChild(item);
      });
    }
    state.data.foods.forEach(f => {
      normalizeTodayFood(f);
      const t = foodEntryTotals(f);
      totalCal += t.cal;
      totalProtein += t.protein;
    });
  } else {
    state.data.foods.forEach((f, i) => {
      normalizeTodayFood(f);
      const t = foodEntryTotals(f);
      totalCal += t.cal;
      totalProtein += t.protein;

      const isSelected = f.selected !== false;
      const portions = f.portions || 1;
      const displayCal = isSelected ? f.cal * portions : f.cal;
      const displayProtein = isSelected ? f.protein * portions : f.protein;

      const item = document.createElement('div');
      item.className = 'food-item ' + (isSelected ? 'selected' : 'deselected');
      item.innerHTML = `
        <span class="food-name">${f.name}</span>
        <div class="food-portions">
          <button type="button" class="portion-btn" data-action="minus">&#8722;</button>
          <span class="portion-count">${isSelected ? portions : 0}</span>
          <button type="button" class="portion-btn" data-action="plus">+</button>
        </div>
        <div class="food-macros">${displayCal} kcal<br>${displayProtein}g protein</div>
      `;

      item.querySelector('[data-action="minus"]').addEventListener('click', (e) => {
        e.stopPropagation();
        if (!isSelected) return;
        const newPortions = (f.portions || 1) - 1;
        if (newPortions <= 0) {
          f.selected = false;
          f.portions = 0;
        } else {
          f.portions = newPortions;
        }
        saveLocal();
        syncFoodsToCloud();
        renderFoods();
      });

      item.querySelector('[data-action="plus"]').addEventListener('click', (e) => {
        e.stopPropagation();
        f.selected = true;
        f.portions = (isSelected ? (f.portions || 1) : 0) + 1;
        saveLocal();
        syncFoodsToCloud();
        renderFoods();
      });

      list.appendChild(item);
    });
  }

  document.getElementById('total-cal').textContent = totalCal;
  document.getElementById('total-protein').textContent = totalProtein;
}

function openFoodTagModal(onSelect) {
  const modal = document.getElementById('modal-food-tag');
  modal.classList.remove('hidden');
  const grid = document.getElementById('food-tag-grid');
  buildMealGrid(grid, (tagId) => {
    modal.classList.add('hidden');
    onSelect(tagId);
  });
}

function closeFoodTagModal() {
  document.getElementById('modal-food-tag').classList.add('hidden');
}

let editingFoodId = null;
let editingFoodTag = null;

function openEditFoodModal(foodId) {
  ensureFoodLibrary();
  const food = state.data.foodLibrary.find(f => f.id === foodId);
  if (!food) return;

  editingFoodId = foodId;
  editingFoodTag = food.tag;

  document.getElementById('food-edit-name').value = food.name;
  document.getElementById('food-edit-cal').value = food.cal || '';
  document.getElementById('food-edit-protein').value = food.protein || '';

  const grid = document.getElementById('food-edit-tag-grid');
  grid.innerHTML = '';
  FOOD_TAGS.forEach(tag => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'meal-grid-btn' + (tag.id === editingFoodTag ? ' selected' : '');
    btn.textContent = tag.label;
    btn.addEventListener('click', () => {
      editingFoodTag = tag.id;
      grid.querySelectorAll('.meal-grid-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      autoSaveEditedFood();
    });
    grid.appendChild(btn);
  });

  document.getElementById('modal-edit-food').classList.remove('hidden');
}

function closeEditFoodModal(skipSave = false) {
  if (!skipSave) autoSaveEditedFood();
  document.getElementById('modal-edit-food').classList.add('hidden');
  editingFoodId = null;
  editingFoodTag = null;
}

function deleteEditedFood() {
  if (!editingFoodId) return;
  state.data.foodLibrary = state.data.foodLibrary.filter(f => f.id !== editingFoodId);
  editingFoodId = null;
  editingFoodTag = null;
  saveLocal();
  syncFoodLibraryToCloud();
  document.getElementById('modal-edit-food').classList.add('hidden');
  if (calView.mode === 'past-list') renderFoods();
}

let foodEditSyncDebounce = null;

function autoSaveEditedFood() {
  if (!editingFoodId || !editingFoodTag) return;

  const food = state.data.foodLibrary.find(f => f.id === editingFoodId);
  if (!food) return;

  const nameInput = document.getElementById('food-edit-name').value.trim();
  const cal = parseInt(document.getElementById('food-edit-cal').value) || 0;
  const protein = parseInt(document.getElementById('food-edit-protein').value) || 0;
  const prevTag = food.tag;

  if (nameInput) food.name = nameInput;
  food.cal = cal;
  food.protein = protein;
  food.tag = editingFoodTag;

  saveLocal();
  clearTimeout(foodEditSyncDebounce);
  foodEditSyncDebounce = setTimeout(() => syncFoodLibraryToCloud(), 800);

  if (calView.mode === 'past-list' && calView.pastTag === prevTag && prevTag !== editingFoodTag) {
    showPastFoodList(calView.pastTag);
  } else if (calView.mode === 'past-list') {
    renderFoods();
  }
}

function addFoodWithTag(tagId) {
  const name = document.getElementById('food-name-input').value.trim();
  const cal = parseInt(document.getElementById('food-cal-input').value) || 0;
  const protein = parseInt(document.getElementById('food-protein-input').value) || 0;
  if (!name) return;

  ensureFoodLibrary();
  state.data.foodLibrary.push({
    id: generateId(),
    name,
    cal,
    protein,
    tag: tagId
  });
  state.data.foods.push({ name, cal, protein, portions: 1, selected: true });
  saveLocal();
  syncFoodsToCloud();
  syncFoodLibraryToCloud();
  document.getElementById('food-name-input').value = '';
  document.getElementById('food-cal-input').value = '';
  document.getElementById('food-protein-input').value = '';
  renderFoods();
}

document.getElementById('btn-add-food-mode').addEventListener('click', showAddFoodPanel);
document.getElementById('btn-past-food-mode').addEventListener('click', showPastFoodCategories);
document.getElementById('add-food-back').addEventListener('click', resetCalView);

document.getElementById('past-food-back').addEventListener('click', () => {
  if (calView.mode === 'past-list') showPastFoodCategories();
});

document.getElementById('past-categories-back').addEventListener('click', resetCalView);

buildMealGrid(document.getElementById('meal-category-grid'), showPastFoodList);

document.getElementById('add-food-btn').addEventListener('click', () => {
  const name = document.getElementById('food-name-input').value.trim();
  if (!name) return;
  openFoodTagModal(addFoodWithTag);
});

document.getElementById('modal-food-tag').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-food-tag')) closeFoodTagModal();
});

['food-edit-name', 'food-edit-cal', 'food-edit-protein'].forEach(id => {
  document.getElementById(id).addEventListener('input', autoSaveEditedFood);
});

document.getElementById('food-edit-delete').addEventListener('click', deleteEditedFood);
document.getElementById('modal-edit-food').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-edit-food')) closeEditFoodModal();
});

// ── TIMER ──────────────────────────────────────────────
const TIMER_DURATION = 120;
let timerSeconds = TIMER_DURATION;
let timerRunning = false;
let timerInterval = null;
let timerStartedAt = null;   // wall-clock ms when timer last started
let timerSecondsAtStart = TIMER_DURATION; // seconds remaining when started

const timerDisplay = document.getElementById('timer-display');
const timerResetBtn = document.getElementById('timer-reset');

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function updateTimerDisplay() {
  timerDisplay.textContent = formatTime(Math.max(0, timerSeconds));
  timerDisplay.classList.toggle('urgent', timerSeconds <= 10 && timerSeconds > 0 && timerRunning);
  timerDisplay.classList.toggle('running', timerRunning);
}

function startTimer() {
  if (timerRunning) return;
  timerRunning = true;
  timerStartedAt = Date.now();
  timerSecondsAtStart = timerSeconds;
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - timerStartedAt) / 1000);
    timerSeconds = timerSecondsAtStart - elapsed;
    if (timerSeconds <= 0) {
      timerSeconds = 0;
      clearInterval(timerInterval);
      timerRunning = false;
    }
    updateTimerDisplay();
  }, 500); // poll every 500ms so wakeup correction is fast
  updateTimerDisplay();
}

function pauseTimer() {
  clearInterval(timerInterval);
  timerRunning = false;
  // Capture accurate remaining time before pausing
  if (timerStartedAt) {
    const elapsed = Math.floor((Date.now() - timerStartedAt) / 1000);
    timerSeconds = Math.max(0, timerSecondsAtStart - elapsed);
  }
  timerStartedAt = null;
  updateTimerDisplay();
}

function resetTimer() {
  clearInterval(timerInterval);
  timerRunning = false;
  timerStartedAt = null;
  timerSeconds = TIMER_DURATION;
  timerSecondsAtStart = TIMER_DURATION;
  updateTimerDisplay();
  // Reset always starts counting down immediately
  startTimer();
}

// When app comes back into focus, recalculate elapsed time
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && timerRunning && timerStartedAt) {
    const elapsed = Math.floor((Date.now() - timerStartedAt) / 1000);
    timerSeconds = Math.max(0, timerSecondsAtStart - elapsed);
    if (timerSeconds <= 0) {
      timerSeconds = 0;
      clearInterval(timerInterval);
      timerRunning = false;
    }
    updateTimerDisplay();
  }
});

timerDisplay.addEventListener('click', () => {
  if (timerRunning) {
    pauseTimer();
  } else if (timerSeconds === 0) {
    // At 0:00 — restart from full duration and count down
    timerSeconds = TIMER_DURATION;
    timerSecondsAtStart = TIMER_DURATION;
    startTimer();
  } else {
    startTimer();
  }
});
timerResetBtn.addEventListener('click', resetTimer);

// ── WEIGHT TRACKER ─────────────────────────────────────
const WEIGHT_KEY = 'grind_weight';
const DEFAULT_WEIGHT = 160;

function loadWeight() {
  try {
    const stored = JSON.parse(localStorage.getItem(WEIGHT_KEY));
    if (stored && typeof stored.value === 'number') return stored.value;
  } catch {}
  return DEFAULT_WEIGHT;
}

function saveWeight(val) {
  try {
    localStorage.setItem(WEIGHT_KEY, JSON.stringify({
      value: val,
      date: new Date().toDateString()
    }));
  } catch {}
}

async function syncWeightToCloud(val) {
  if (!state.user) return;
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await sb.from('weight_logs').upsert({
    user_id: state.user.id,
    date: today,
    weight_lbs: val,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id,date' });
  if (error) { showSync('⚠', true); console.error(error); }
  else showSync('✓');
}

async function loadWeightFromCloud() {
  if (!state.user) return;
  // Get the most recent weight entry
  const { data, error } = await sb.from('weight_logs')
    .select('weight_lbs, date')
    .eq('user_id', state.user.id)
    .order('date', { ascending: false })
    .limit(1)
    .single();
  if (error && error.code !== 'PGRST116') { console.error(error); return; }
  if (data) {
    saveWeight(data.weight_lbs);
    updateWeightDisplay();
  }
}

function updateWeightDisplay() {
  const val = loadWeight();
  document.getElementById('weight-value').textContent = val % 1 === 0 ? val : val.toFixed(1);
}

document.getElementById('weight-minus').addEventListener('click', () => {
  const current = loadWeight();
  const next = Math.round((current - 0.5) * 10) / 10;
  saveWeight(next);
  updateWeightDisplay();
  syncWeightToCloud(next);
});

document.getElementById('weight-plus').addEventListener('click', () => {
  const current = loadWeight();
  const next = Math.round((current + 0.5) * 10) / 10;
  saveWeight(next);
  updateWeightDisplay();
  syncWeightToCloud(next);
});

updateWeightDisplay();

// ── DAILY SNAPSHOT ─────────────────────────────────────
// Saves an immutable summary row for each calendar day.
// Called on login (seals yesterday if missed) and after
// any data change today. Past rows are never overwritten
// because upsert only matches user_id+date — once the
// date rolls over, yesterday's row is permanently locked.

async function saveDailySnapshot(dateStr) {
  if (!state.user) return;
  // dateStr is YYYY-MM-DD
  const weight = loadWeight();

  // Sum foods for the given date
  let totalCal = 0, totalProtein = 0;
  const dayStr = new Date(dateStr).toDateString();
  // food_logs stores foods for a specific date — fetch that day's row
  const { data: foodRow } = await sb.from('food_logs')
    .select('foods')
    .eq('user_id', state.user.id)
    .eq('date', dayStr)
    .single();
  if (foodRow?.foods) {
    foodRow.foods.forEach(f => {
      if (f.selected !== false) {
        const p = f.portions || 1;
        totalCal += (f.cal || 0) * p;
        totalProtein += (f.protein || 0) * p;
      }
    });
  }

  // Collect gym sets done that day across all workout types
  const gymSummary = {};
  for (const type of ['push', 'pull', 'legs']) {
    const { data: gymRows } = await sb.from('gym_logs')
      .select('snapshot')
      .eq('user_id', state.user.id)
      .eq('date', dayStr)
      .eq('type', type)
      .single();
    if (gymRows?.snapshot) {
      const exercises = [];
      gymRows.snapshot.forEach(ex => {
        const daySets = ex.sets.filter(s => new Date(s.date).toDateString() === dayStr);
        if (daySets.length) {
          exercises.push({ name: ex.name, sets: daySets });
        }
      });
      if (exercises.length) gymSummary[type] = exercises;
    }
  }

  const { error } = await sb.from('daily_snapshots').upsert({
    user_id: state.user.id,
    date: dateStr,
    weight_lbs: weight,
    total_kcal: totalCal,
    total_protein: totalProtein,
    gym: gymSummary,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id,date' });

  if (error) console.error('snapshot error', error);
}

async function sealYesterdayIfNeeded() {
  // On login, make sure yesterday's snapshot is saved
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().slice(0, 10);
  // Only seal if there's any food or gym data for yesterday
  const dayStr = yesterday.toDateString();
  const { data: foodRow } = await sb.from('food_logs')
    .select('date')
    .eq('user_id', state.user.id)
    .eq('date', dayStr)
    .single();
  if (foodRow) await saveDailySnapshot(yStr);
}

let snapshotDebounce = null;
function queueDailySnapshot() {
  clearTimeout(snapshotDebounce);
  snapshotDebounce = setTimeout(() => {
    const today = new Date().toISOString().slice(0, 10);
    saveDailySnapshot(today);
  }, 3000);
}

// ── BOOT ───────────────────────────────────────────────
init();