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

function defaultData() {
  return {
    workouts: { push: [], pull: [], legs: [] },
    foods: []
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
  else showSync('✓');
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
  else showSync('✓');
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
}

// ── AUTH ────────────────────────────────────────────────
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
  renderExercises();
  showScreen('home');
  await loadGymFromCloud();
  await loadFoodsFromCloud();
  renderExercises();
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
  renderFoods();
  showScreen('calories');
});

// ── BACK BUTTONS ───────────────────────────────────────
document.querySelectorAll('.back-btn').forEach(btn => {
  btn.addEventListener('click', () => showScreen(btn.dataset.target));
});

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
    const lastSession = ex.sets[ex.sets.length - 1];
    let meta = 'No sets logged';
    if (lastSession) {
      meta = lastSession.sets.map(s => `${s.weight}kg×${s.reps}`).join('  ');
    }
    const item = document.createElement('div');
    item.className = 'exercise-item';
    item.innerHTML = `
      <div>
        <div class="exercise-name">${ex.name}</div>
        <div class="exercise-meta">${meta} · ${ex.sets.length} sessions</div>
      </div>
      <span style="color:#444;font-size:18px;">›</span>
    `;
    item.addEventListener('click', () => openSetModal(ex.id));
    list.appendChild(item);
  });
}

document.getElementById('add-exercise-btn').addEventListener('click', () => {
  const input = document.getElementById('exercise-name-input');
  const name = input.value.trim();
  if (!name) return;
  state.data.workouts[state.currentWorkout].push({ id: generateId(), name, sets: [], notes: '' });
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

// ── INLINE LONG-PRESS RENAME ───────────────────────────
function startLongPress() {
  longPressTimer = setTimeout(() => {
    titleEl.contentEditable = 'true';
    titleEl.focus();
    const range = document.createRange();
    range.selectNodeContents(titleEl);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }, 500);
}
function cancelLongPress() { clearTimeout(longPressTimer); }

titleEl.addEventListener('mousedown', startLongPress);
titleEl.addEventListener('touchstart', startLongPress, { passive: true });
titleEl.addEventListener('mouseup', cancelLongPress);
titleEl.addEventListener('mouseleave', cancelLongPress);
titleEl.addEventListener('touchend', cancelLongPress);

titleEl.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
});
titleEl.addEventListener('blur', () => {
  const newName = titleEl.textContent.trim();
  titleEl.contentEditable = 'false';
  if (newName) {
    const ex = findExercise();
    if (ex) { ex.name = newName; saveLocal(); syncGymToCloud(); renderExercises(); }
    titleEl.textContent = newName;
  } else {
    titleEl.textContent = findExercise()?.name || '';
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
    const weight = parseFloat(row.querySelector('.set-weight-input').value);
    const reps = parseInt(row.querySelector('.set-reps-input').value);
    if (!isNaN(weight) && weight > 0 && !isNaN(reps) && reps > 0) {
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
    <input type="number" class="text-input set-weight-input" placeholder="0" inputmode="decimal" value="${prefill ? prefill.weight : ''}" />
    <input type="number" class="text-input set-reps-input" placeholder="0" inputmode="numeric" value="${prefill ? prefill.reps : ''}" />
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

document.getElementById('modal-set').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-set')) closeModal();
});

function closeModal() {
  document.getElementById('modal-set').classList.add('hidden');
}

// ── CALORIES ───────────────────────────────────────────
function renderFoods() {
  const list = document.getElementById('food-list');
  list.innerHTML = '';
  let totalCal = 0, totalProtein = 0;

  state.data.foods.forEach((f, i) => {
    totalCal += f.cal;
    totalProtein += f.protein;
    const item = document.createElement('div');
    item.className = 'food-item';
    item.innerHTML = `
      <span class="food-name">${f.name}</span>
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="food-macros">${f.cal} kcal<br>${f.protein}g protein</div>
        <button class="delete-btn" data-index="${i}">×</button>
      </div>
    `;
    list.appendChild(item);
  });

  document.getElementById('total-cal').textContent = totalCal;
  document.getElementById('total-protein').textContent = totalProtein;

  list.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.data.foods.splice(parseInt(btn.dataset.index), 1);
      saveLocal();
      syncFoodsToCloud();
      renderFoods();
    });
  });
}

document.getElementById('add-food-btn').addEventListener('click', () => {
  const name = document.getElementById('food-name-input').value.trim();
  const cal = parseInt(document.getElementById('food-cal-input').value) || 0;
  const protein = parseInt(document.getElementById('food-protein-input').value) || 0;
  if (!name) return;
  state.data.foods.push({ name, cal, protein });
  saveLocal();
  syncFoodsToCloud();
  document.getElementById('food-name-input').value = '';
  document.getElementById('food-cal-input').value = '';
  document.getElementById('food-protein-input').value = '';
  renderFoods();
});

// ── TIMER ──────────────────────────────────────────────
const TIMER_DURATION = 120;
let timerSeconds = TIMER_DURATION;
let timerRunning = false;
let timerInterval = null;

const timerDisplay = document.getElementById('timer-display');
const timerResetBtn = document.getElementById('timer-reset');

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function updateTimerDisplay() {
  timerDisplay.textContent = formatTime(timerSeconds);
  timerDisplay.classList.toggle('urgent', timerSeconds <= 10 && timerSeconds > 0 && timerRunning);
  timerDisplay.classList.toggle('running', timerRunning);
}

function startTimer() {
  if (timerRunning) return;
  timerRunning = true;
  timerInterval = setInterval(() => {
    if (timerSeconds <= 0) {
      clearInterval(timerInterval);
      timerRunning = false;
      updateTimerDisplay();
      return;
    }
    timerSeconds--;
    updateTimerDisplay();
  }, 1000);
  updateTimerDisplay();
}

function pauseTimer() {
  clearInterval(timerInterval);
  timerRunning = false;
  updateTimerDisplay();
}

function resetTimer() {
  clearInterval(timerInterval);
  timerRunning = false;
  timerSeconds = TIMER_DURATION;
  updateTimerDisplay();
}

timerDisplay.addEventListener('click', () => {
  if (timerRunning) pauseTimer(); else startTimer();
});
timerResetBtn.addEventListener('click', resetTimer);

// ── BOOT ───────────────────────────────────────────────
init();