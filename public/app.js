const API_BASE = 'https://box-game-6y1g.onrender.com';

const DEFAULT_CHARGE_INTERVAL_MS = 15 * 1000; // 서버에서 실제 값(업그레이드 반영)을 받기 전까지 쓰는 기본값
const MAX_BOX_CHARGES = 100;
let REBIRTH_GOLD_REQUIRED = 300000; // 서버 상태 응답(rebirthGoldRequired)으로 갱신됩니다
const CRAFT_COST = 3;
const RANK_PAGE_SIZE = 10;

let authToken = localStorage.getItem('boxGameToken');
let currentUser = null;
let currentMode = 'record'; // 'record' | 'collection'
let statusInterval = null;
let resyncInterval = null;
let isOpening = false;

// 캐시된 상태값 (0.2초마다 로컬에서 다시 그릴 때 사용)
let cachedCharges = 0;
let cachedMaxCharges = MAX_BOX_CHARGES;
let cachedNextChargeAt = null;
let cachedChargeIntervalMs = DEFAULT_CHARGE_INTERVAL_MS;
let cachedAutoOpen = false;        // 지금 자동 개봉이 돌아가는 중인지 (켜짐 + 남은 시간 있음)
let cachedAutoOpenEndsAt = null;   // 남은 자동 개봉 시간이 끝나는 시각 (화면 카운트다운용)
// 골드는 서버가 마지막으로 정산한 값(cachedGold, 정산 시각) + 그 뒤로 흐른 시간 × 분당 수입으로 실시간 표시합니다.
let cachedGold = 0;
let cachedLastIncomeCollectedAt = null;
let cachedPerMinuteIncome = 60;
let cachedIncome = null;
let lastStatus = null; // 강화 화면 등에서 쓰는 마지막 상태 응답
let cachedBoostUntil = null;      // 수입 2배가 끝나는 시각
let cachedBoostMultiplier = 2;
let goldenBoxAppearAt = null;     // 황금 상자가 나타나는 시각
let goldenBoxExpireAt = null;     // 황금 상자가 사라지는 시각
let cachedRunStartedAt = null;
let cachedRebirthCount = 0;
let serverTimeOffset = 0;
let currentRankPage = 1;
let currentRankSeason = null; // null이면 현재 시즌
let cachedPityReduction = 0;

const authScreen = document.getElementById('authScreen');
const gameScreen = document.getElementById('gameScreen');
const collectionScreen = document.getElementById('collectionScreen');
const rankingScreen = document.getElementById('rankingScreen');
const upgradeScreen = document.getElementById('upgradeScreen');
const achievementScreen = document.getElementById('achievementScreen');
const authError = document.getElementById('authError');

// 골드는 소수점 없이 표시합니다. 10만 미만은 쉼표(95,003), 그 이상은 한국식 단위로
// 큰 단위 두 개까지 보여줘요(12만 3,456 · 1억 2,345만 · 3조 20억 · 5경).
const KOREAN_UNITS = [[1e20, '해'], [1e16, '경'], [1e12, '조'], [1e8, '억'], [1e4, '만']];
function formatGold(value){
  const n = Math.floor(Number(value) || 0);
  const abs = Math.abs(n);
  if (abs < 100000) return n.toLocaleString();
  const sign = n < 0 ? '-' : '';
  const i = KOREAN_UNITS.findIndex(([unit]) => abs >= unit);
  const [unit, name] = KOREAN_UNITS[i];
  const head = Math.floor(abs / unit);
  const subUnit = unit / 1e4;
  const rest = Math.floor((abs % unit) / subUnit);
  const restName = KOREAN_UNITS[i + 1] ? KOREAN_UNITS[i + 1][1] : '';
  return `${sign}${head.toLocaleString()}${name}${rest > 0 ? ` ${rest.toLocaleString()}${restName}` : ''}`;
}

// 지금 이 순간의 골드 (서버 정산값 + 정산 이후 쌓인 골드). 서버와 같은 방식으로 내림 계산합니다.
function liveGold(){
  if (!cachedLastIncomeCollectedAt) return cachedGold;
  const now = adjustedNow();
  const elapsedMs = Math.max(0, now - cachedLastIncomeCollectedAt);
  // 수입 2배 버프가 걸려 있던 구간은 한 번 더 셉니다 (서버와 같은 계산)
  const boostedMs = cachedBoostUntil
    ? Math.min(elapsedMs, Math.max(0, Math.min(now, cachedBoostUntil) - cachedLastIncomeCollectedAt)) * (cachedBoostMultiplier - 1)
    : 0;
  return cachedGold + Math.floor((elapsedMs + boostedMs) / 1000 * cachedPerMinuteIncome / 60);
}

function boostRemainingMs(){
  return cachedBoostUntil ? Math.max(0, cachedBoostUntil - adjustedNow()) : 0;
}

// 서버 응답의 골드로 기준값을 맞춥니다. (서버는 응답 직전에 정산하므로 기본 정산 시각은 "지금")
function setGold(total, collectedAt){
  cachedGold = Number(total) || 0;
  cachedLastIncomeCollectedAt = collectedAt ? new Date(collectedAt) : adjustedNow();
  renderGold();
}

function renderGold(){
  const text = formatGold(liveGold());
  document.getElementById('totalTreasure').textContent = text;
  // 숫자가 길어지면(억·조 단위) 글자를 줄여서 '분당 +G'가 잘리지 않게 합니다.
  const goldAmount = document.querySelector('#gameScreen .gold-amount');
  goldAmount.classList.toggle('long', text.length > 10);
  goldAmount.classList.toggle('xlong', text.length > 13);
  document.getElementById('shopGold').textContent = text;
  document.getElementById('upgradeGold').textContent = text;
}

function applyIncome(income){
  if (!income) return;
  cachedIncome = income;
  cachedPerMinuteIncome = income.perMinuteIncome;
  cachedBoostUntil = income.boostUntil ? new Date(income.boostUntil) : null;
  if (income.boostMultiplier) cachedBoostMultiplier = income.boostMultiplier;
  if (income.lastCollectedAt) {
    cachedLastIncomeCollectedAt = new Date(income.lastCollectedAt);
  }
}

// 칭호(수집가 등급)를 메인 화면과 가방·도감 화면에 표시합니다.
function renderCollectorRank(rank){
  const main = document.getElementById('collectorRankMain');
  const detail = document.getElementById('collectorRankCollection');
  if (!rank) {
    main.classList.add('hidden');
    detail.classList.add('hidden');
    return;
  }
  const title = `${rank.emoji} ${rank.name}`;
  const nextText = rank.next
    ? `다음 칭호 ${rank.next.emoji} ${rank.next.name}까지 ${rank.next.remaining}종`
    : '최고 칭호 달성!';

  // 수집모드에서는 맨 위 도감 카드에 칭호를 보여주므로 닉네임 아래 칩은 쓰지 않습니다.
  main.classList.add('hidden');
  document.getElementById('heroRankText').textContent = rank.next
    ? `${title} · ${rank.next.emoji}까지 ${rank.next.remaining}종`
    : `${title} · 최고 칭호!`;

  detail.innerHTML = '';
  detail.append(title);
  const next = document.createElement('span');
  next.className = 'rank-next';
  next.textContent = nextText;
  detail.appendChild(next);
  detail.classList.remove('hidden');
}

// ★ 표시: 채운 별 + 빈 별
function renderStars(stars, maxStars){
  return '★'.repeat(stars) + `<span class="off">${'★'.repeat(Math.max(0, maxStars - stars))}</span>`;
}

function syncServerTime(serverTimeStr){
  if (!serverTimeStr) return;
  serverTimeOffset = new Date(serverTimeStr).getTime() - Date.now();
}
function adjustedNow(){
  return new Date(Date.now() + serverTimeOffset);
}
function formatDuration(totalSeconds){
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(totalSeconds % 60)).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// 페이지를 열자마자 저장된 토큰으로 자동 로그인합니다.
// - 토큰이 정말 무효(401·404)일 때만 지우고 로그인 화면을 보여줍니다.
// - 서버가 잠들어 있거나(무료 서버는 한동안 안 쓰면 깨우는 데 30초~1분) 네트워크가 끊긴 경우엔
//   토큰을 지우지 않고 잠시 기다렸다 다시 시도합니다. 그래서 앱을 오랜만에 열어도 로그인이 풀리지 않아요.
// - 성공하면 서버가 유효기간을 늘린 새 토큰을 주므로 저장해 둡니다.
const AUTO_LOGIN_RETRY_DELAYS_MS = [2000, 3000, 5000, 8000, 10000, 10000, 15000, 15000];
// 서버가 깨어나는 동안(최대 1분) 섞어서 돌려 보여주는 문구
const WAITING_LINES = [
  '📦 상자 먼지 닦는 중...',
  '🔑 열쇠 꾸러미 뒤지는 중...',
  '⏳ 모래시계 뒤집는 중...',
  '🧭 신화 지도 펼치는 중...',
  '💰 금화 한 닢씩 세는 중...',
  '🐉 상자 지키는 용 깨우는 중...',
  '🕯 보물 창고에 불 밝히는 중...',
  '🔮 오늘의 신화 점치는 중...',
  '🧹 창고 거미줄 걷어내는 중...',
  '✨ 황금 상자 광내는 중...',
];
(async function tryAutoLogin(){
  if (!authToken) return;
  const box = document.getElementById('autoLoginBox');
  const text = document.getElementById('autoLoginText');
  authScreen.classList.add('auto-login');
  box.classList.remove('hidden');
  // 잠든 서버는 오류 대신 한참 동안 응답을 안 주기도 해서, 3초가 넘으면 기다리는 문구를 돌립니다.
  let funTimer = null;
  const startWaitingFun = () => {
    if (funTimer) return;
    document.getElementById('autoLoginNote').classList.remove('hidden');
    const lines = [...WAITING_LINES].sort(() => Math.random() - 0.5);
    let i = 0;
    const show = () => {
      text.classList.remove('swap');
      void text.offsetWidth; // 문구가 바뀔 때마다 살짝 떠오르는 효과를 다시 재생
      text.textContent = lines[i++ % lines.length];
      text.classList.add('swap');
    };
    show();
    funTimer = setInterval(show, 2600);
  };
  const slowTimer = setTimeout(startWaitingFun, 3000);
  const stop = () => {
    clearTimeout(slowTimer);
    clearInterval(funTimer);
    authScreen.classList.remove('auto-login');
    box.classList.add('hidden');
  };

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await authFetch('/api/auth/me');
      if (res.status === 401 || res.status === 404) {
        localStorage.removeItem('boxGameToken');
        authToken = null;
        stop();
        return;
      }
      if (!res.ok) throw new Error(`서버 응답 ${res.status}`);
      const data = await res.json();
      if (data.token) {
        authToken = data.token;
        localStorage.setItem('boxGameToken', data.token);
      }
      currentUser = data.user;
      stop();
      enterGame();
      return;
    } catch (err) {
      if (attempt >= AUTO_LOGIN_RETRY_DELAYS_MS.length) {
        // 오래 기다려도 안 되면 로그인 화면을 보여주되, 저장된 로그인은 지우지 않습니다(새로고침하면 다시 시도).
        stop();
        showAuthError('서버에 연결하지 못했습니다. 잠시 후 다시 실행해 주세요. (로그인 정보는 유지됩니다)');
        return;
      }
      startWaitingFun();
      await new Promise(resolve => setTimeout(resolve, AUTO_LOGIN_RETRY_DELAYS_MS[attempt]));
    }
  }
})();

function showAuthError(message){
  authError.textContent = message;
  authError.style.display = 'block';
}
function clearAuthError(){ authError.style.display = 'none'; }

document.getElementById('switchToSignup').addEventListener('click', () => {
  document.getElementById('loginForm').classList.add('hidden');
  document.getElementById('signupForm').classList.remove('hidden');
  document.getElementById('switchToSignupLine').classList.add('hidden');
  document.getElementById('switchToLoginLine').classList.remove('hidden');
  clearAuthError();
});
document.getElementById('switchToLogin').addEventListener('click', () => {
  document.getElementById('signupForm').classList.add('hidden');
  document.getElementById('loginForm').classList.remove('hidden');
  document.getElementById('switchToLoginLine').classList.add('hidden');
  document.getElementById('switchToSignupLine').classList.remove('hidden');
  clearAuthError();
});

// 로그인/회원가입 중에는 버튼을 잠그고 "…중" 표시 (서버가 잠들어 있으면 첫 응답이 수십 초 걸릴 수 있어서)
function setAuthBusy(button, busy, busyText){
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = busyText;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
  button.disabled = busy;
}

// 입력칸에서 엔터를 누르면: 마지막 칸이면 바로 제출, 아니면 다음 칸으로 이동
// (대부분의 브라우저는 기본으로 제출하지만, 일부 모바일 키보드/브라우저를 위해 직접 처리합니다)
['loginForm', 'signupForm'].forEach(formId => {
  const form = document.getElementById(formId);
  const inputs = [...form.querySelectorAll('input')];
  inputs.forEach((input, i) => {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      e.preventDefault();
      const next = inputs[i + 1];
      if (next && !input.value) return;
      if (next && !next.value) next.focus();
      else form.requestSubmit();
    });
  });
});

document.getElementById('signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = document.getElementById('signupSubmitBtn');
  if (button.disabled) return;
  clearAuthError();
  setAuthBusy(button, true, '가입 중...');
  const nickname = document.getElementById('signupNickname').value;
  const email = document.getElementById('signupEmail').value;
  const password = document.getElementById('signupPassword').value;
  try {
    const res = await fetch(`${API_BASE}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, nickname }),
    });
    const data = await res.json();
    if (!res.ok) return showAuthError(data.message || '회원가입에 실패했습니다.');
    authToken = data.token;
    localStorage.setItem('boxGameToken', data.token);
    currentUser = data.user;
    enterGame();
  } catch (err) {
    showAuthError('서버에 연결할 수 없습니다.');
  } finally {
    setAuthBusy(button, false);
  }
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = document.getElementById('loginSubmitBtn');
  if (button.disabled) return;
  clearAuthError();
  setAuthBusy(button, true, '로그인 중...');
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;
  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) return showAuthError(data.message || '로그인에 실패했습니다.');
    authToken = data.token;
    localStorage.setItem('boxGameToken', data.token);
    currentUser = data.user;
    enterGame();
  } catch (err) {
    showAuthError('서버에 연결할 수 없습니다.');
  } finally {
    setAuthBusy(button, false);
  }
});

// 계정이 바뀔 때 이전 결과/이펙트 흔적이 남지 않도록 초기화
function resetGameResultUI(){
  document.getElementById('resultBox').style.display = 'none';
  document.getElementById('craftResult').style.display = 'none';
  document.getElementById('chest').classList.remove('open');
  document.getElementById('rankingHistoryList')?.classList.add('hidden');
}

document.getElementById('logoutBtn').addEventListener('click', () => {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('boxGameToken');
  clearInterval(statusInterval);
  clearInterval(resyncInterval);
  goldenBoxAppearAt = null;
  goldenBoxExpireAt = null;
  document.getElementById('goldenBox').classList.add('hidden');
  resetGameResultUI();
  [gameScreen, collectionScreen, upgradeScreen, achievementScreen, rankingScreen, document.getElementById('guestbookScreen')].forEach(el => el.classList.add('hidden'));
  document.body.classList.remove('in-game');
  authScreen.classList.remove('hidden');
});

// 현재 모드에 맞춰 화면 전체를 갱신 (배지, 색상, 기록모드 전용 요소 표시 여부, 문구)
function applyModeUI(mode){
  currentMode = mode;
  const isRecord = mode === 'record';
  document.body.classList.toggle('mode-collection', !isRecord);

  document.getElementById('modeBadge').textContent = isRecord ? '🏁 기록모드' : '📖 수집모드';
  document.getElementById('switchModeBtn').textContent = isRecord ? '📖 수집모드도 해보기' : '🏁 기록모드도 해보기';

  document.getElementById('collectionModeSubtext').textContent = isRecord
    ? '가방은 환생 시 초기화'
    : '도감은 영구 보존';
  // 기록모드에는 도감·업적이 없으므로, 모드를 바꾸면 가방 탭으로 돌아갑니다.
  if (isRecord) showCollectionTab('run');
  if (isRecord && typeof currentTab !== 'undefined' && currentTab === 'dex') goTab('bag');
  // 업적도 수집모드 전용이에요.
  if (isRecord && typeof currentTab !== 'undefined' && currentTab === 'achievement') goTab('home');

  document.getElementById('modeTabRun').textContent = '🎒 가방';
  document.getElementById('runModeHint').textContent = '같은 아이템 3개 → 한 등급 위로 합성 · 🔓 잠그면 재료에서 제외';
}

async function switchMode(targetMode){
  const btn = document.getElementById('switchModeBtn');
  btn.disabled = true;
  try {
    const res = await authFetch('/api/box/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: targetMode }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.message); return; }

    applyModeUI(data.mode);
    resetGameResultUI();
    document.getElementById('craftResult').style.display = 'none';

    // 화면에 남아있던 이전 모드의 잔상(수입, 환생 진행도 등)을 지우고 새로 불러옴
    cachedIncome = null;
    await refreshStatus();
    if (!collectionScreen.classList.contains('hidden')) await loadCollection(true);
  } catch (err) {
    alert('모드를 전환하지 못했습니다.');
  } finally {
    btn.disabled = false;
  }
}

// 모드 선택 창: 두 모드를 나란히 보여주고 고르게 합니다. (모드 칩 · 아래 전환 버튼 · 처음 들어올 때)
const modePickerOverlay = document.getElementById('modePickerOverlay');
function openModePicker(){
  document.querySelectorAll('[data-pick-mode]').forEach(btn => {
    const isCurrent = btn.dataset.pickMode === currentMode;
    btn.classList.toggle('current', isCurrent);
    btn.querySelector('.mode-option-cta').textContent = isCurrent ? '✔ 지금 하는 중' : '이 모드로 하기 →';
  });
  modePickerOverlay.classList.add('show');
}
document.querySelectorAll('[data-pick-mode]').forEach(btn => btn.addEventListener('click', async () => {
  modePickerOverlay.classList.remove('show');
  if (btn.dataset.pickMode !== currentMode) await switchMode(btn.dataset.pickMode);
  maybeStartGuide();
}));
document.getElementById('modePickerCloseBtn').addEventListener('click', () => {
  modePickerOverlay.classList.remove('show');
  maybeStartGuide();
});
document.getElementById('switchModeBtn').addEventListener('click', openModePicker);
document.getElementById('modeBadge').addEventListener('click', openModePicker);
// 계정마다 처음 한 번은 모드 설명을 보여줍니다.
function maybeShowModeIntro(){
  const key = `boxGameModeIntro:${currentUser && currentUser.id}`;
  let seen = false;
  try { seen = Boolean(localStorage.getItem(key)); localStorage.setItem(key, '1'); } catch (e) { seen = true; }
  if (!seen) openModePicker(); // 모드를 고르고 나면 화면 가이드가 이어집니다
  else setTimeout(maybeStartGuide, 1500);
}

// -------------------------------
// 아래 고정 탭 바: 홈 · 가방 · 도감(수집모드) · 강화 · 업적 · 랭킹
// -------------------------------
const TAB_OPENERS = {
  bag: 'openCollectionBtn',
  dex: 'openCollectionBtn',
  upgrade: 'openUpgradeBtn',
  achievement: 'openAchievementBtn',
  ranking: 'openRankingBtn',
};
let currentTab = 'home';
function goTab(tab){
  currentTab = tab;
  document.querySelectorAll('#tabBar .tab-item').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  [gameScreen, collectionScreen, upgradeScreen, achievementScreen, rankingScreen, document.getElementById('guestbookScreen')].forEach(el => el.classList.add('hidden'));
  window.scrollTo(0, 0);
  if (tab === 'home') {
    gameScreen.classList.remove('hidden');
    refreshStatus();
    return;
  }
  // 각 화면을 여는 기존 버튼 동작(데이터 불러오기 포함)을 그대로 씁니다.
  if (tab === 'guestbook') { document.getElementById('guestbookScreen').classList.remove('hidden'); loadGuestbook(); return; }
  document.getElementById(TAB_OPENERS[tab]).click();
  if (tab === 'bag' || tab === 'dex') {
    showCollectionTab(tab === 'dex' ? 'dex' : 'run');
    document.getElementById('collectionTitle').textContent = tab === 'dex' ? '도감' : '가방';
  }
}
document.querySelectorAll('#tabBar .tab-item').forEach(btn => {
  btn.addEventListener('click', () => goTab(btn.dataset.tab));
});

function enterGame(){
  document.getElementById('userNickname').textContent = currentUser.nickname || currentUser.email;
  authScreen.classList.add('hidden');
  document.body.classList.add('in-game');
  armBackGuard();
  goTab('home');
  resetGameResultUI();

  // /me 응답에 담겨온 현재 모드로 즉시 UI를 맞춰서, 첫 상태 조회가 끝나기 전에도
  // 깜빡임 없이 올바른 모드로 보이게 합니다.
  applyModeUI(currentUser.active_mode || 'record');

  refreshStatus();
  maybeShowModeIntro();
  clearInterval(statusInterval);
  statusInterval = setInterval(renderTick, 200);
  clearInterval(resyncInterval);
  resyncInterval = setInterval(refreshStatus, 15000);
}

async function authFetch(path, options = {}){
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), 'Authorization': `Bearer ${authToken}` },
  });
}

// 서버에서 정확한 상태를 받아와 기준값을 갱신
async function refreshStatus(){
  try {
    const res = await authFetch('/api/box/status');
    const data = await res.json();
    if (!res.ok) return;

    syncServerTime(data.serverTime);
    if (data.mode && data.mode !== currentMode) applyModeUI(data.mode);
    lastStatus = data;
    applyIncome(data.income);
    setGold(data.totalTreasure, data.income && data.income.lastCollectedAt);
    if (data.chargeIntervalMs) cachedChargeIntervalMs = data.chargeIntervalMs;
    if (data.boxPrice) cachedBoxPrice = data.boxPrice;
    if (data.boxPricing) cachedBoxPricing = data.boxPricing;
    if (data.rebirthGoldRequired) applyRebirthGoal(data.rebirthGoldRequired);
    renderItemEffects(data.itemEffects);
    applyAutoOpen(data.autoOpen);
    applyChargeInfo(data);
    if (typeof data.pityReduction === 'number') cachedPityReduction = data.pityReduction;
    updatePityUI(data.mythicPity, data.mythicPityLimit);

    renderCollectorRank(data.collectorRank);
    applyChoiceBox(data.choiceBox, data.rankReward);
    applySeason(data.season, data.seasonChange, data.codex);
    renderPace(data.pace, data.seasonBest);
    applySealed(data.sealed);
    renderPrestigeHint(data.prestige);
    applyGoldenBox(data.goldenBox);
    renderAchievementBadge(data.claimableAchievements);
    if (!achievementScreen.classList.contains('hidden')) renderAchievements();
    if (data.awaySummary) showAwaySummary(data.awaySummary, data.autoOpened);
    else handleAutoEvents(data);
    if (!upgradeScreen.classList.contains('hidden')) renderUpgradeScreen();
    if (data.runStartedAt) cachedRunStartedAt = new Date(data.runStartedAt);
    if (typeof data.rebirthCount === 'number') {
      cachedRebirthCount = data.rebirthCount;
      document.getElementById('rebirthCount').textContent = cachedRebirthCount;
    }

    renderTick();
  } catch (err) {
    // 네트워크 문제는 조용히 무시하고 다음 동기화 때 재시도
  }
}

function applyAutoOpen(autoOpen){
  if (!autoOpen) return;
  cachedAutoOpen = autoOpen.enabled && autoOpen.remainingMs > 0;
  cachedAutoOpenEndsAt = cachedAutoOpen ? new Date(adjustedNow().getTime() + autoOpen.remainingMs) : null;
}

function autoOpenRemainingMs(){
  if (!cachedAutoOpenEndsAt) return 0;
  return Math.max(0, cachedAutoOpenEndsAt - adjustedNow());
}

function applyChargeInfo(data){
  if (typeof data.charges !== 'number') return;
  cachedCharges = data.charges;
  cachedMaxCharges = data.maxCharges;
  cachedNextChargeAt = data.nextChargeInMs != null ? new Date(adjustedNow().getTime() + data.nextChargeInMs) : null;
}

// 상자 뚜껑이 열리는 연출 (직접 열 때와 자동 개봉 때 공통)
function playChestOpen(){
  const chest = document.getElementById('chest');
  chest.classList.remove('open');
  void chest.offsetWidth; // 연달아 열려도 애니메이션이 처음부터 다시 나오게
  chest.classList.add('open');
  clearTimeout(playChestOpen.timer);
  playChestOpen.timer = setTimeout(() => chest.classList.remove('open'), 1200);
}

// 정산 중에 자동 개봉이 일어났으면 직접 열 때처럼 상자가 열리고 결과 칸에 보여줍니다.
// 신화 상자 도착·자동 합성은 화면 위 짧은 알림으로 알려줘요.
function handleAutoEvents(data){
  const lines = [];
  if (data.autoOpened && data.autoOpened.count > 0) {
    playChestOpen();
    showOpenResult(`🤖 자동 개봉 ${data.autoOpened.count}개`, data.autoOpened.obtained);
    checkAndTriggerLegendary(data.autoOpened.obtained, data.autoOpened.pityTriggered);
  }
  if (data.autoOpened && data.autoOpened.sealed > 0) {
    lines.push(`🔮 신화 상자 +${data.autoOpened.sealed} 도착! 위 버튼으로 개봉`);
  }
  if (data.autoCrafted && data.autoCrafted.count > 0) {
    lines.push(`⚙️ 자동 합성 ${data.autoCrafted.count}번`);
  }
  // 결과 칸(직접 연 상자 결과)을 덮어쓰지 않도록, 화면 위 짧은 알림으로만 보여줍니다.
  if (lines.length === 0) return;
  showToast(lines.join(' · '));
}

// 자리 비운 동안 일어난 일을 팝업으로 보여줍니다.
function showAwaySummary(summary, autoOpened){
  const minutes = Math.floor(summary.awayMs / 60000);
  const awayText = minutes >= 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : `${minutes}분`;
  document.getElementById('awayTime').textContent = `${awayText} 동안 자리 비움`;
  document.getElementById('awayGold').textContent = `+${formatGold(summary.goldEarned)}G`;

  const details = [];
  if (summary.storageCapped) details.push(`📦 보관 시간 ${summary.storageText}까지만 적립 (강화 → 창고로 확장 가능)`);
  if (summary.autoOpenedCount > 0) details.push(`⏳ 상자 ${formatGold(summary.autoOpenedCount)}개 자동 개봉`);
  if (summary.autoCraftCount > 0) details.push(`⚙️ ${formatGold(summary.autoCraftCount)}번 자동 합성`);
  if (summary.sealedGained > 0) details.push(`🔮 신화 상자 ${summary.sealedGained}개 도착! 확인 후 직접 개봉`);
  summary.notable.forEach(item => details.push({ html: `${itemIconHtml(item.key, 'chip-icon')} ${escapeHtml(item.name)} x${item.count}` }));
  if (summary.autoOpenedCount === 0) details.push('💡 강화에서 자동 개봉 시간을 구매하면 자리 비운 동안에도 상자 자동 개봉');

  const list = document.getElementById('awayDetails');
  list.innerHTML = '';
  details.forEach(entry => {
    const li = document.createElement('li');
    if (typeof entry === 'string') li.textContent = entry;
    else { li.innerHTML = entry.html; li.classList.add('with-icon'); }
    list.appendChild(li);
  });
  document.getElementById('awayOverlay').classList.add('show');
  pendingAwayAutoOpened = autoOpened;
}
let pendingAwayAutoOpened = null;
document.getElementById('awayCloseBtn').addEventListener('click', () => {
  document.getElementById('awayOverlay').classList.remove('show');
  // 자리 비운 동안 신화가 나왔다면 팝업을 닫은 뒤 신화 연출을 보여줍니다.
  if (pendingAwayAutoOpened) checkAndTriggerLegendary(pendingAwayAutoOpened.obtained, pendingAwayAutoOpened.pityTriggered);
  pendingAwayAutoOpened = null;
});

// 환생 조건(골드)을 서버 값으로 맞추고 버튼 문구도 갱신
function applyRebirthGoal(goal){
  REBIRTH_GOLD_REQUIRED = goal;
  const text = `${formatGold(goal)}G`;
  document.getElementById('mainRebirthBtn').textContent = `✨ 환생하기! (${text})`;
  document.getElementById('rebirthBtn').textContent = `✨ 환생하기 (${text})`;
}

// 환생 목표 칸 아래: 환생 포인트 안내 (기록모드 전용)
function renderPrestigeHint(prestige){
  const el = document.getElementById('prestigeHint');
  if (!prestige || !prestige.enabled) { el.textContent = ''; return; }
  el.textContent = prestige.pointsOnRebirth > 0
    ? `✨ 지금 환생하면 특성 포인트 +${prestige.pointsOnRebirth}P`
    : `✨ ${formatGold(prestige.nextPointAt - prestige.runGoldEarned)}G 더 벌면 특성 포인트 +1P`;
}

// 0.2초마다 호출: 네트워크 없이 로컬 계산만으로 화면을 그림
function renderTick(){
  const statusText = document.getElementById('statusText');
  const chest = document.getElementById('chest');

  // 충전 로컬 시뮬레이션: 다음 충전 시각이 지났으면 1개씩 늘려줌
  if (cachedAutoOpen && autoOpenRemainingMs() <= 0) {
    cachedAutoOpen = false; // 자동 개봉 시간이 다 됨 → 이제부터는 충전이 쌓임
    refreshStatus();
  }
  if (cachedAutoOpen) {
    // 자동 개봉 중에는 충전되는 즉시 서버가 열어주므로, 다음 상자까지의 타이머만 돌립니다.
    while (cachedNextChargeAt && adjustedNow() >= cachedNextChargeAt) {
      cachedNextChargeAt = new Date(cachedNextChargeAt.getTime() + cachedChargeIntervalMs);
    }
  } else if (cachedCharges < cachedMaxCharges && cachedNextChargeAt) {
    while (cachedNextChargeAt && adjustedNow() >= cachedNextChargeAt && cachedCharges < cachedMaxCharges) {
      cachedCharges++;
      cachedNextChargeAt = new Date(cachedNextChargeAt.getTime() + cachedChargeIntervalMs);
    }
    if (cachedCharges >= cachedMaxCharges) cachedNextChargeAt = null;
  }

  const canOpen = cachedCharges >= 1 && !cachedAutoOpen;
  // 자동 개봉 중에는 상자가 열리는 모습이 보이도록 흐리게 하지 않습니다.
  chest.style.opacity = (canOpen || cachedAutoOpen) ? '1' : '0.6';
  chest.classList.toggle('ready', canOpen);
  chest.style.pointerEvents = (canOpen && !isOpening) ? 'auto' : 'none';

  if (cachedAutoOpen) {
    statusText.textContent = `⏳ 자동 개봉 중 · ${formatDuration(Math.floor(autoOpenRemainingMs() / 1000))}`;
    statusText.classList.add('ready');
  } else if (canOpen) {
    statusText.textContent = `📦 상자 ${cachedCharges}개 · 눌러서 모두 열기`;
    statusText.classList.add('ready');
  } else {
    statusText.classList.remove('ready');
    statusText.textContent = '상자 충전 중';
  }

  document.getElementById('chargeBarFill').style.width = `${(cachedCharges / cachedMaxCharges) * 100}%`;

  // 다음 충전까지 몇 초 남았는지 표시 (꽉 찼으면 안내 문구로 대체)
  const nextChargeText = document.getElementById('nextChargeText');
  if (!cachedAutoOpen && cachedCharges >= cachedMaxCharges) {
    nextChargeText.textContent = `충전 가득 (${cachedMaxCharges}/${cachedMaxCharges})`;
  } else if (cachedNextChargeAt) {
    const secondsLeft = Math.max(0, Math.ceil((cachedNextChargeAt - adjustedNow()) / 1000));
    nextChargeText.textContent = `충전 ${cachedCharges}/${cachedMaxCharges} · 다음 ${secondsLeft}초`;
  }

  // 플레이타임 (기록모드 레이스 카드의 큰 타이머도 같은 값)
  if (cachedRunStartedAt) {
    const playSeconds = Math.floor((adjustedNow() - cachedRunStartedAt) / 1000);
    document.getElementById('heroRunTimer').textContent = `⏱ ${formatDuration(Math.max(0, playSeconds))}`;
    document.getElementById('playtimeDisplay').textContent = formatDuration(Math.max(0, playSeconds));
  }

  // 골드는 실시간으로 쌓입니다 (받기 버튼 없이 자동 정산)
  renderGold();
  const boostLeft = boostRemainingMs();
  const rateText = boostLeft > 0
    ? `⚡ 분당 +${formatGold(cachedPerMinuteIncome * cachedBoostMultiplier)}G · 수입 ${cachedBoostMultiplier}배 ${formatDuration(Math.floor(boostLeft / 1000)).slice(3)} 남음`
    : `💰 분당 +${formatGold(cachedPerMinuteIncome)}G 자동으로 쌓이는 중`;
  let breakdownText = '';
  if (cachedIncome) {
    const parts = [`기본 ${formatGold(cachedIncome.baseIncome)}`, `아이템 ${formatGold(cachedIncome.itemIncome)}`];
    const bonuses = [];
    if (cachedIncome.upgradeBonusPercent > 0) bonuses.push(`강화 +${cachedIncome.upgradeBonusPercent}%`);
    if (cachedIncome.prestigeBonusPercent > 0) bonuses.push(`환생 +${cachedIncome.prestigeBonusPercent}%`);
    if (cachedIncome.mythicBonusPercent > 0) bonuses.push(`신화 +${cachedIncome.mythicBonusPercent}%`);
    breakdownText = `${parts.join(' + ')}${bonuses.length ? ` · ${bonuses.join(' · ')}` : ''}`;
  }
  document.querySelectorAll('[data-income="pending"]').forEach(el => { el.textContent = rateText; });
  document.getElementById('goldRate').textContent = boostLeft > 0
    ? `⚡ 분당 +${formatGold(cachedPerMinuteIncome * cachedBoostMultiplier)}G (2배)`
    : `분당 +${formatGold(cachedPerMinuteIncome)}G`;
  document.querySelectorAll('[data-income="rate"]').forEach(el => { el.textContent = breakdownText; });

  // 환생 목표 진행바
  const goldNow = liveGold();
  const pct = Math.min(100, (goldNow / REBIRTH_GOLD_REQUIRED) * 100);
  document.getElementById('rebirthGoalText').textContent = `${formatGold(goldNow)} / ${formatGold(REBIRTH_GOLD_REQUIRED)}G`;
  document.getElementById('rebirthGoalBar').style.width = `${pct}%`;

  const goalBox = document.getElementById('rebirthGoalBox');
  const goalReady = goldNow >= REBIRTH_GOLD_REQUIRED;
  goalBox.classList.toggle('ready', goalReady);
  const mainRebirthBtn = document.getElementById('mainRebirthBtn');
  mainRebirthBtn.disabled = !goalReady;
  mainRebirthBtn.classList.toggle('hidden', !goalReady); // 환생 가능할 때만 버튼 노출

  const rebirthProgressText = document.getElementById('rebirthProgressText');
  rebirthProgressText.textContent = `${formatGold(goldNow)} / ${formatGold(REBIRTH_GOLD_REQUIRED)}G`;
  const rebirthBtn = document.getElementById('rebirthBtn');
  rebirthBtn.disabled = !goalReady;
  rebirthBtn.classList.toggle('hidden', !goalReady);

  clampBuyBoxQty();
  if (!upgradeScreen.classList.contains('hidden')) {
    updateUpgradeAffordability();
    renderAutoOpenTimer();
  }
  renderGoldenBox();
  renderSeasonCountdown();
}

// 골드 상자 가격은 수입에 따라 바뀌므로 서버가 알려준 기준값으로 계산합니다 (상태 조회 때마다 갱신)
// 여러 개를 사면 하나씩 산 것처럼 상자마다 가격이 조금씩 올라갑니다 (서버와 같은 계산)
let cachedBoxPrice = 75;
let cachedBoxPricing = null;

function boxPriceAt(k){
  const p = cachedBoxPricing;
  if (!p) return cachedBoxPrice;
  const base = Math.max(p.minPrice, Math.floor((p.income + k * p.step) * p.incomeMinutes));
  return Math.max(1, Math.floor(base * (100 - p.discountPercent) / 100));
}

function boxPurchaseCost(quantity){
  let total = 0;
  for (let k = 0; k < quantity; k++) total += boxPriceAt(k);
  return total;
}
const MAX_GOLD_BOX_PURCHASE = 2000; // 서버의 MAX_GOLD_BOX_PURCHASE와 반드시 일치시켜야 함

function getMaxBuyableQty(){
  const gold = liveGold();
  let total = 0;
  for (let k = 0; k < MAX_GOLD_BOX_PURCHASE; k++) {
    total += boxPriceAt(k);
    if (total > gold) return k;
  }
  return MAX_GOLD_BOX_PURCHASE;
}

function clampBuyBoxQty(){
  const input = document.getElementById('buyBoxQty');
  const max = getMaxBuyableQty();
  let value = parseInt(input.value, 10);
  if (isNaN(value) || value < 1) value = 1;
  if (value > max) value = max;
  input.value = max === 0 ? 0 : value;

  const cost = boxPurchaseCost(Math.max(0, value));
  document.getElementById('buyBoxCostText').textContent =
    `총 ${formatGold(cost)}G · 최대 ${max}개 (개당 ${formatGold(boxPriceAt(0))}G~)`;

  document.getElementById('buyBoxBtn').disabled = max === 0 || value < 1 || isOpening;
  document.getElementById('maxBuyQtyBtn').disabled = max === 0;
}

document.getElementById('buyBoxQty').addEventListener('input', clampBuyBoxQty);

document.getElementById('maxBuyQtyBtn').addEventListener('click', () => {
  document.getElementById('buyBoxQty').value = getMaxBuyableQty();
  clampBuyBoxQty();
});

document.getElementById('buyBoxBtn').addEventListener('click', async function(){
  if (isOpening) return;
  const quantity = parseInt(document.getElementById('buyBoxQty').value, 10);
  if (!quantity || quantity < 1) return;

  isOpening = true;
  this.disabled = true;
  const originalText = this.textContent;
  this.textContent = '구매 중...';

  try {
    const res = await authFetch('/api/box/buy-boxes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity }),
    });
    const data = await res.json();

    if (!res.ok){
      alert(data.message);
      return;
    }

    setGold(data.totalTreasure);
    showOpenResult(`💰 ${data.quantity}개 구매 오픈`, data.obtained);

    updatePityUI(data.mythicPity, data.mythicPityLimit);
    checkAndTriggerLegendary(data.obtained, data.mythicPityTriggered);
    if (data.autoOpened) checkAndTriggerLegendary(data.autoOpened.obtained, data.autoOpened.pityTriggered);
    clampBuyBoxQty();
    refreshStatus();
  } catch (err) {
    // 네트워크 실패 시 별도 처리 없이 다음 시도에 맡김
  } finally {
    isOpening = false;
    this.textContent = originalText;
    clampBuyBoxQty();
  }
});

// -------------------------------
// 전설 아이템 이펙트
// -------------------------------
function triggerLegendaryEffect(){
  const flash = document.getElementById('legendaryFlash');
  flash.classList.remove('play');
  void flash.offsetWidth; // 리플로우 강제 (같은 애니메이션 다시 재생하려고)
  flash.classList.add('play');

  const resultBox = document.getElementById('resultBox');
  resultBox.classList.remove('legendary-glow');
  void resultBox.offsetWidth;
  resultBox.classList.add('legendary-glow');
  setTimeout(() => resultBox.classList.remove('legendary-glow'), 2600);

  const wrap = document.querySelector('.chest-wrap');
  for (let i = 0; i < 6; i++) {
    const sparkle = document.createElement('div');
    sparkle.className = 'legendary-sparkle';
    sparkle.textContent = '✨';
    sparkle.style.left = `${40 + Math.random() * 60}px`;
    sparkle.style.top = `${20 + Math.random() * 40}px`;
    sparkle.style.animationDelay = `${Math.random() * 0.3}s`;
    wrap.appendChild(sparkle);
    setTimeout(() => sparkle.remove(), 1600);
  }
}

// -------------------------------
// 신화 이벤트 화면 (상자에서 신화가 나왔을 때만 풀스크린으로 등장)
// -------------------------------
// 신화 천장 표시 갱신: 남은 개수, 진행바, 확정 임박 시 강조
function updatePityUI(pity, limit){
  if (typeof pity !== 'number' || !limit) return;
  // 자리 비운 동안 자동 개봉 중에 별의 파편을 얻으면 천장이 줄어서 진행도가 천장을 넘을 수 있습니다.
  // 이때도 다음 상자는 신화 확정이므로, 표시는 천장에 맞춰 보여줍니다.
  const shownPity = Math.min(pity, limit);
  const remaining = limit - pity; // 이 개수만큼 더 열면(=마지막 상자가) 신화 확정 (0 이하면 다음 상자 확정)
  document.getElementById('pityText').textContent = `${shownPity.toLocaleString()} / ${limit.toLocaleString()}`;
  document.getElementById('pityBarFill').style.width = `${Math.min(100, (shownPity / limit) * 100)}%`;
  const box = document.getElementById('pityBox');
  const hint = document.getElementById('pityHint');
  const imminent = remaining <= 1;
  box.classList.toggle('imminent', imminent);
  const reductionText = cachedPityReduction > 0 ? ` · ✨ 효과로 천장 -${cachedPityReduction.toLocaleString()}` : '';
  hint.textContent = imminent ? '🔥 다음 상자 확정!' : `${remaining.toLocaleString()}개 남음`;
  hint.title = reductionText ? reductionText.replace(/^ · /, '') : '';
}

// -------------------------------
// 신화 획득 팝업: 2초쯤 떴다가 사라지는 작은 창에 3칸씩 줄줄이 (누르면 바로 닫힘)
// 짧은 시간에 여러 번 얻으면 하나로 모아서 보여줍니다.
// -------------------------------
const MYTHIC_POPUP_MS = 2200;
let mythicPopupTimer = null;
let mythicPopupItems = [];
let mythicPopupPity = false;

function showMythicPopup(mythics, pityTriggered, title){
  // 이미 떠 있으면 합쳐서 다시 그림 (같은 신화는 개수만 더함)
  for (const m of mythics) {
    const same = mythicPopupItems.find(x => x.key === m.key);
    if (same) same.count += m.count || 1;
    else mythicPopupItems.push({ ...m, count: m.count || 1 });
  }
  mythicPopupPity = mythicPopupPity || Boolean(pityTriggered);
  const total = mythicPopupItems.reduce((sum, m) => sum + m.count, 0);
  document.getElementById('mythicPopupTitle').textContent = title
    || `${mythicPopupPity ? '✦ 천장 달성! ' : '✦ '}신화 ${total}개 획득! ✦`;
  // 하나씩 차례로 튀어나오게 (많으면 최대 1.2초 안에 모두 등장)
  const step = Math.min(0.12, 1.2 / Math.max(1, mythicPopupItems.length));
  document.getElementById('mythicPopupGrid').innerHTML = mythicPopupItems.map((m, i) => `
    <div class="mythic-popup-item" style="animation-delay:${(i * step).toFixed(2)}s" title="${escapeHtml(m.effectText || '')}">
      ${itemIconHtml(m.key, 'mythic-popup-icon')}
      <span class="mythic-popup-name">${escapeHtml(m.name)}${m.count > 1 ? ` x${m.count}` : ''}</span>
    </div>`).join('');
  const popup = document.getElementById('mythicPopup');
  popup.classList.remove('show');
  void popup.offsetWidth; // 애니메이션 다시 재생
  popup.classList.add('show');
  if (navigator.vibrate) navigator.vibrate([60, 40, 120]);
  clearTimeout(mythicPopupTimer);
  // 많이 나오면 조금 더 오래 보여줍니다 (최대 +3초)
  mythicPopupTimer = setTimeout(hideMythicPopup, MYTHIC_POPUP_MS + Math.min(3000, (mythicPopupItems.length - 1) * 250));
}
function hideMythicPopup(){
  clearTimeout(mythicPopupTimer);
  document.getElementById('mythicPopup').classList.remove('show');
  mythicPopupItems = [];
  mythicPopupPity = false;
}
document.getElementById('mythicPopup').addEventListener('click', hideMythicPopup);

function checkAndTriggerLegendary(items, pityTriggered){
  // items: 단일 아이템 객체 또는 아이템 배열 둘 다 받을 수 있게
  const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
  const mythics = list.filter(item => item.rarity === 'mythic');

  if (mythics.length > 0) {
    showMythicPopup(mythics, pityTriggered);
  } else if (list.some(item => item.rarity === 'legendary')) {
    triggerLegendaryEffect();
  }
}

// 여러 개를 연 결과: 가장 높은 등급의 아이템만 보여줍니다. (같은 등급이 여러 종류면 그것만 전부)
function showOpenResult(title, obtained){
  const list = obtained || [];
  const top = RARITY_ORDER_UI.find(r => list.some(o => o.rarity === r));
  const best = list.filter(o => o.rarity === top);
  const rarityBadge = document.getElementById('rarityBadge');
  rarityBadge.textContent = top ? `최고 등급 · ${RARITY_LABEL[top]}` : '';
  rarityBadge.className = `rarity-badge ${top || ''}`;
  setResultIcon(best.length === 1 ? best[0].key : null);
  document.getElementById('treasureName').textContent = title;
  document.getElementById('treasureDetail').innerHTML = obtainedChipsHtml(best);
  document.getElementById('resultBox').style.display = 'block';
}

const RARITY_LABEL = { common: '일반', rare: '희귀', epic: '영웅', legendary: '전설', mythic: '신화' };

// 상자를 누르면 충전된 상자를 한 번에 모두 엽니다.
document.getElementById('chest').addEventListener('click', async function(){
  if (cachedCharges < 1 || isOpening || cachedAutoOpen) return;
  isOpening = true;
  this.style.pointerEvents = 'none';

  try {
    const res = await authFetch('/api/box/open-all', { method: 'POST' });
    const data = await res.json();
    if (!res.ok){ refreshStatus(); return; }

    syncServerTime(data.serverTime);
    applyChargeInfo(data);
    setGold(data.totalTreasure);
    playChestOpen();
    showOpenResult(`📦 상자 ${data.quantity}개 오픈`, data.obtained);
    updatePityUI(data.mythicPity, data.mythicPityLimit);
    checkAndTriggerLegendary(data.obtained, data.mythicPityTriggered);
    renderTick();
    refreshStatus();
  } catch (err) {
    refreshStatus();
  } finally {
    isOpening = false;
  }
});

// -------------------------------
// 환생 / 초심으로 돌아가기
// -------------------------------
async function performRebirth(btnEl){
  btnEl.disabled = true;
  const onMainScreen = !gameScreen.classList.contains('hidden');
  try {
    const res = await authFetch('/api/box/rebirth', { method: 'POST' });
    const data = await res.json();

    if (!res.ok) {
      if (onMainScreen) alert(data.message);
      else showToast(data.message, true);
    } else {
      const vsBest = data.previousBestMs == null
        ? '🏁 이번 시즌 첫 기록!'
        : data.isNewBest
          ? `🏆 시즌 최고 기록 경신! (${formatDuration(Math.floor((data.previousBestMs - data.durationMs) / 1000))} 단축)`
          : `최고 기록보다 ${formatDuration(Math.floor((data.durationMs - data.previousBestMs) / 1000))} 느림`;
      const recordText = `기록: ${formatDuration(Math.floor(data.durationMs / 1000))} · ${vsBest} · 환생 포인트 +${data.prestigeGained} (보유 ${data.prestigePoints}개 → 강화의 환생 상점에서 특성 구매 시 다음 판이 더 빨라집니다)`;
      const msg = `✨ ${data.rebirthNumber}번째 환생! ${recordText}`;
      if (onMainScreen) {
        document.getElementById('rarityBadge').textContent = '';
        setResultIcon(null);
        document.getElementById('treasureName').textContent = `✨ ${data.rebirthNumber}번째 환생 달성!`;
        document.getElementById('treasureDetail').textContent = recordText;
        document.getElementById('resultBox').style.display = 'block';
      } else {
        showToast(msg);
      }
      cachedRunStartedAt = new Date(data.runStartedAt);
      cachedRebirthCount = data.rebirthNumber;
      document.getElementById('rebirthCount').textContent = cachedRebirthCount;
      setGold(data.totalTreasure);
    }
    if (!collectionScreen.classList.contains('hidden')) await loadCollection(false, false);
    await refreshStatus();
  } finally {
    btnEl.disabled = false;
  }
}
document.getElementById('rebirthBtn').addEventListener('click', function(){ performRebirth(this); });
document.getElementById('mainRebirthBtn').addEventListener('click', function(){ performRebirth(this); });

document.getElementById('resetRunBtn').addEventListener('click', async function(){
  const confirmed = confirm('초심으로 돌아가시겠습니까?\n지금 모은 골드·아이템·강화·자동화가 모두 사라지고 2000골드부터 다시 시작합니다.\n(환생이 아니므로 기록·환생 포인트는 생기지 않으며, 보유한 환생 포인트는 유지됩니다)');
  if (!confirmed) return;

  this.disabled = true;
  try {
    const res = await authFetch('/api/box/reset-run', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { alert(data.message); return; }

    cachedRunStartedAt = new Date(data.runStartedAt);
    setGold(data.totalTreasure);
    document.getElementById('resultBox').style.display = 'none';
    renderTick();
    await refreshStatus();
  } finally {
    this.disabled = false;
  }
});

// -------------------------------
// 도감 화면
// -------------------------------
document.getElementById('openCollectionBtn').addEventListener('click', async () => {
  gameScreen.classList.add('hidden');
  collectionScreen.classList.remove('hidden');
  document.getElementById('craftResult').style.display = 'none';
  showBagTab(); // 열 때마다 기본 화면은 가방
  await loadCollection();
});

document.getElementById('backToGameBtn').addEventListener('click', () => {
  goTab('home');
});

async function loadCollection(showLoadingText = true){
  const collectionGrid = document.getElementById('collectionGrid');
  const runGrid = document.getElementById('runInventoryGrid');
  if (showLoadingText) {
    collectionGrid.innerHTML = '<p style="color:var(--ink-dim); font-size:13px;">불러오는 중...</p>';
    runGrid.innerHTML = '';
  }

  try {
    const res = await authFetch('/api/box/collection');
    const data = await res.json();
    if (!res.ok) return;

    if (data.mode && data.mode !== currentMode) applyModeUI(data.mode);
    applyIncome(data.income);
    setGold(data.totalTreasure, data.income && data.income.lastCollectedAt);
    renderCollectorRank(data.collectorRank);
    if (data.itemEffects) renderItemEffects(data.itemEffects);
    renderTick();

    // ── 도감(수집모드): 일반~전설 발견 기록 (신화 100종은 loadCodex가 위쪽에 따로 그림) ──
    collectionGrid.innerHTML = '';
    data.collection.filter(item => item.rarity !== 'mythic').forEach(item => {
      const card = document.createElement('div');
      card.className = `item-card ${item.rarity} ${item.obtained ? '' : 'locked'}`;
      card.title = item.obtained
        ? (item.firstDiscoveredAt ? `${item.flavor} (${new Date(item.firstDiscoveredAt).toLocaleDateString()} 발견)` : item.flavor)
        : '아직 발견하지 못한 아이템입니다';

      card.innerHTML = `
        ${itemIconHtml(item.key, 'item-icon', !item.obtained)}
        <div class="item-name">${item.obtained ? item.name : '???'}</div>
        ${item.obtained ? `
          <div class="item-stars">${renderStars(item.stars, item.maxStars)}</div>
          <div class="item-next-star">${item.nextStarAt ? `다음 ★ ${item.count}/${item.nextStarAt}` : '★ 최대'}</div>
          ${item.effect ? `<div class="item-effect">1개당 ${escapeHtml(item.effect.per)}<br>최대 ${escapeHtml(item.effect.max.replace(/^.*?([+-][^ ]+)$/, '$1'))} (${item.effect.maxCount}개)</div>` : ''}
        ` : ''}
      `;
      collectionGrid.appendChild(card);
    });

    // ── 가방 그리드: 모든 아이템을 항상 같은 순서·같은 칸에 보여줍니다 ──
    // (자동 합성 등으로 0개가 돼도 칸이 사라지지 않아서, 누르려던 버튼 위치가 바뀌지 않음)
    {
      runGrid.innerHTML = '';
      data.collection.forEach(item => {
        const card = document.createElement('div');
        const isEmpty = item.count === 0;
        const known = item.obtained || item.count > 0; // 한 번도 발견 못 한 아이템은 이름을 가립니다
        card.className = `item-card ${item.rarity} ${isEmpty ? 'is-empty' : ''} ${item.inSeasonDex ? '' : 'past-season'}`;
        card.title = known ? item.flavor : '아직 발견하지 못한 아이템입니다';

        // 신화는 상자에서만 나오므로 전설도 합성 재료가 될 수 없음 (일반/희귀/영웅만 합성 가능)
        const isMaxRarity = item.rarity === 'mythic';
        const isCraftLocked = item.rarity === 'legendary' || isMaxRarity;
        const canCraft = item.count >= CRAFT_COST && !isCraftLocked && !item.locked;
        const craftLabel = isMaxRarity ? '최고 등급' : (isCraftLocked ? '합성 불가' : (item.locked ? '🔒 잠김' : `합성(-${CRAFT_COST})`));
        if (item.locked) card.classList.add('is-locked');

        // 개수와 상관없이 줄 구성을 똑같이 유지해서 카드 높이가 바뀌지 않게 합니다
        card.innerHTML = `
          ${known ? `<button class="lock-btn ${item.locked ? 'on' : ''}" data-lock="${item.key}" data-locked="${item.locked}"
            title="${item.locked ? '잠금 해제' : '잠그면 합성 재료에서 제외'}">${item.locked ? '🔒' : '🔓'}</button>` : ''}
          ${itemIconHtml(item.key, 'item-icon', !known)}
          <div class="item-name">${known ? item.name : '???'}</div>
          <div class="item-count">x${item.count}</div>
          <div class="item-stars">${renderStars(item.stars, item.maxStars)}</div>
          <div class="item-income">분당 +${formatGold(item.incomePerMinute || 0)}G</div>
          ${item.effect ? `<div class="item-effect">${known ? escapeHtml(item.effect.now || item.effect.per) : '???'}</div>` : ''}
          <button class="craft-btn" data-key="${item.key}" ${canCraft ? '' : 'disabled'}>${craftLabel}</button>
        `;
        runGrid.appendChild(card);
      });
    }

    runGrid.querySelectorAll('[data-lock]').forEach(btn => {
      btn.addEventListener('click', () => toggleItemLock(btn.dataset.lock, btn.dataset.locked !== 'true', btn));
    });
    runGrid.querySelectorAll('.craft-btn').forEach(btn => {
      btn.addEventListener('click', () => craftItem(btn.dataset.key, btn));
    });
  } catch (err) {
    collectionGrid.innerHTML = '<p style="color:var(--danger); font-size:13px;">불러오지 못했습니다.</p>';
  }
}

// 아이템 잠금 켜기/끄기
async function toggleItemLock(itemKey, locked, btn){
  btn.disabled = true;
  try {
    const res = await authFetch('/api/box/lock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemKey, locked }),
    });
    const data = await res.json();
    showToast(data.message, !res.ok);
  } catch (err) {
    showToast('서버에 연결할 수 없습니다.', true);
  } finally {
    await loadCollection(false);
  }
}

// 가방·도감 화면 위쪽: 지금 적용 중인 아이템 효과 요약
function renderItemEffects(effects){
  const box = document.getElementById('itemEffectsBox');
  if (!box) return;
  if (!effects || effects.length === 0) {
    box.innerHTML = '<span class="item-effects-empty">✨ 신화(와 별의 파편·시간의 모래) 보유 시 효과 발동 · 수입·행운·할인·천장 등 9가지</span>';
    return;
  }
  box.innerHTML = effects
    .map(e => `<span class="item-effect-chip ${e.maxed ? 'maxed' : ''}" title="${escapeHtml(e.sources.join(', '))} · 최대 ${escapeHtml(e.maxText)}">${e.emoji} ${escapeHtml(e.text)}${e.maxed ? ' (최대)' : ''}</span>`)
    .join('');
}

// 가방 / 시즌 도감 / 신화 도감 탭 전환 (기본은 가방)
const COLLECTION_TABS = {
  run: ['modeTabRun', 'runModeView'],
  dex: ['modeTabCollection', 'collectionModeView'],
};
function showCollectionTab(which){
  for (const [name, [tabId, viewId]] of Object.entries(COLLECTION_TABS)) {
    document.getElementById(tabId).classList.toggle('active', name === which);
    document.getElementById(viewId).classList.toggle('hidden', name !== which);
  }
  if (which === 'dex') loadCodex();
}
function showBagTab(){ showCollectionTab('run'); }

// 가방·도감 화면 탭 전환
document.getElementById('modeTabRun').addEventListener('click', () => showCollectionTab('run'));
document.getElementById('modeTabCollection').addEventListener('click', () => showCollectionTab('dex'));

document.getElementById('craftAllBtn').addEventListener('click', async function(){
  this.disabled = true;
  const originalText = this.textContent;
  this.textContent = '합성 중...';
  try {
    const res = await authFetch('/api/box/craft-all', { method: 'POST' });
    const data = await res.json();
    // 결과는 화면 위 짧은 알림으로 (가방 칸이 밀리지 않도록)
    if (!res.ok || data.totalCrafts === 0) {
      showToast(data.message, !res.ok);
    } else {
      const summary = data.results.map(r => {
        const obtainedText = r.obtained.map(o => `${o.emoji}${o.name}${o.count > 1 ? `x${o.count}` : ''}`).join(', ');
        return `${r.consumedName} ${r.craftCount}세트 → ${obtainedText}`;
      }).join(' / ');
      showToast(`⚡ 총 ${data.totalCrafts}번 합성! (${summary})`);
    }
    await loadCollection(false);
  } finally {
    this.disabled = false;
    this.textContent = originalText;
  }
});

async function craftItem(itemKey, btnEl){
  btnEl.disabled = true;
  btnEl.textContent = '합성 중...';
  try {
    const res = await authFetch('/api/box/craft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemKey }),
    });
    const data = await res.json();
    // 결과는 화면 위 짧은 알림으로 (연달아 눌러도 가방 칸이 밀리지 않도록)
    showToast(res.ok
      ? `${data.consumed.name} x${data.consumed.amount} → ${data.result.emoji} ${data.result.name} 획득!`
      : data.message, !res.ok);
    await loadCollection(false);
  } finally {
    btnEl.disabled = false;
  }
}

document.getElementById('toggleRebirthHistoryBtn').addEventListener('click', async () => {
  const listEl = document.getElementById('rebirthHistoryList');
  if (!listEl.classList.contains('hidden')) { listEl.classList.add('hidden'); return; }

  listEl.classList.remove('hidden');
  listEl.textContent = '불러오는 중...';
  try {
    const res = await authFetch('/api/box/rebirth/history');
    const data = await res.json();
    if (!res.ok || data.history.length === 0) {
      listEl.textContent = '아직 환생 기록이 없습니다.';
      return;
    }
    listEl.innerHTML = data.history.map(h => {
      const date = new Date(h.completedAt).toLocaleString();
      const seasonTag = h.season && h.season !== data.season ? ` · 시즌${h.season}` : '';
      return `<div style="padding:4px 0; border-bottom:1px solid #22335C;">#${h.rebirthNumber} — ${formatDuration(Math.floor(h.durationMs / 1000))} (${date}${seasonTag})</div>`;
    }).join('');
  } catch (err) {
    listEl.textContent = '불러오지 못했습니다.';
  }
});

// -------------------------------
// 강화 화면 (업그레이드 · 자동화 · 환생 포인트)
// -------------------------------
document.getElementById('openUpgradeBtn').addEventListener('click', async () => {
  gameScreen.classList.add('hidden');
  upgradeScreen.classList.remove('hidden');
  document.getElementById('upgradeResult').style.display = 'none';
  renderUpgradeScreen();
  await refreshStatus();
});
document.getElementById('backFromUpgradeBtn').addEventListener('click', () => {
  goTab('home');
});

function renderUpgradeScreen(){
  if (!lastStatus || !lastStatus.upgrades) return;

  const upgradeList = document.getElementById('upgradeList');
  upgradeList.innerHTML = '';
  lastStatus.upgrades.forEach(u => {
    const row = document.createElement('div');
    row.className = 'shop-row';
    const isMax = u.cost === null;
    row.innerHTML = `
      <div class="shop-info">
        <div class="shop-title">${u.emoji} ${u.name} <span class="shop-level">Lv.${u.level}/${u.maxLevel}</span></div>
        <div class="shop-desc">${isMax ? `${u.effect} · 최대 레벨` : `${u.effect} → <strong>${u.nextEffect}</strong>`}</div>
      </div>
      <button class="shop-btn" data-upgrade="${u.key}" data-cost="${isMax ? '' : u.cost}" ${isMax ? 'disabled' : ''}>${isMax ? 'MAX' : `${formatGold(u.cost)}G`}</button>
    `;
    upgradeList.appendChild(row);
  });
  if (lastStatus.upgradeDiscountPercent > 0) {
    upgradeList.insertAdjacentHTML('afterbegin', `<p class="discount-note">🔨 신화 효과로 강화 비용 -${lastStatus.upgradeDiscountPercent}% 적용 중</p>`);
  }

  const autoList = document.getElementById('automationList');
  autoList.innerHTML = '';
  if (lastStatus.autoOpen && lastStatus.autoOpen.discountPercent > 0) {
    autoList.insertAdjacentHTML('afterbegin', `<p class="discount-note">⏳ 신화 효과로 자동 개봉 가격 -${lastStatus.autoOpen.discountPercent}% 적용 중</p>`);
  }

  // 자동 개봉 시간: 남은 시간 / 최대(보관 시간), +1시간 · 가득 채우기 · 켜기/끄기
  const ao = lastStatus.autoOpen;
  const remainingMs = ao.enabled ? autoOpenRemainingMs() : ao.remainingMs;
  const spaceMs = Math.max(0, ao.maxMs - remainingMs);
  const fillCost = Math.ceil(ao.costPerHour * spaceMs / 3600000);
  const autoOpenRow = document.createElement('div');
  autoOpenRow.className = 'shop-row shop-row-wide';
  autoOpenRow.innerHTML = `
    <div class="shop-info">
      <div class="shop-title">⏳ 자동 개봉 시간 <span class="shop-level" id="autoOpenRemainingText"></span></div>
      <div class="shop-desc">구매한 시간 동안 충전되는 상자 자동 개봉 · 최대 ${formatHoursText(ao.maxMs)}(보관 시간)까지</div>
      <div class="time-bar-wrap"><div class="time-bar-fill" id="autoOpenBar"></div></div>
    </div>
    <div class="shop-actions">
      <button class="shop-btn shop-btn-stack" data-autoopen="1" data-cost="${spaceMs >= 3600000 ? ao.costPerHour : ''}" ${spaceMs >= 3600000 ? '' : 'disabled'}>
        <span>+1시간</span><small>${formatGold(ao.costPerHour)}G</small>
      </button>
      <button class="shop-btn shop-btn-stack" data-autoopen="max" data-cost="${spaceMs > 0 ? fillCost : ''}" ${spaceMs > 0 ? '' : 'disabled'}>
        <span>가득 채우기</span><small>${spaceMs > 0 ? `${formatGold(fillCost)}G` : '가득 참'}</small>
      </button>
      <button class="shop-btn shop-btn-stack shop-toggle ${ao.enabled ? 'on' : 'off'}" data-autoopen-toggle="${ao.enabled}">
        <span>${ao.enabled ? '켜짐' : '꺼짐'}</span><small>${ao.enabled ? '누르면 끄기' : '누르면 켜기'}</small>
      </button>
    </div>
  `;
  autoList.appendChild(autoOpenRow);

  // 자동 합성: 한 번 해금 후 켜기/끄기
  const ac = lastStatus.autoCraft;
  const craftRow = document.createElement('div');
  craftRow.className = 'shop-row';
  craftRow.innerHTML = `
    <div class="shop-info">
      <div class="shop-title">${ac.emoji} ${ac.name}</div>
      <div class="shop-desc">${ac.desc}</div>
    </div>
    <button class="shop-btn ${ac.unlocked ? (ac.enabled ? 'on' : 'off') : ''}" data-autocraft="1"
      data-cost="${ac.unlocked ? '' : ac.cost}" data-enabled="${ac.enabled}">${!ac.unlocked ? `${formatGold(ac.cost)}G` : (ac.enabled ? '켜짐' : '꺼짐')}</button>
  `;
  autoList.appendChild(craftRow);
  renderAutoOpenTimer();

  // 환생 상점 (기록모드 전용)
  const prestigeBox = document.getElementById('prestigeBox');
  const p = lastStatus.prestige;
  prestigeBox.classList.toggle('hidden', !p || !p.enabled);
  if (p && p.enabled) {
    document.getElementById('prestigeInfo').textContent = `보유 포인트 ${p.points}개`;
    document.getElementById('prestigeNext').textContent = p.pointsOnRebirth > 0
      ? `지금 환생하면 +${p.pointsOnRebirth}개 · 이번 판 ${formatGold(p.runGoldEarned)}G 획득`
      : `이번 판 ${formatGold(p.runGoldEarned)} / ${formatGold(p.nextPointAt)}G 달성 시 첫 포인트`;
    const perkList = document.getElementById('perkList');
    perkList.innerHTML = '';
    p.perks.forEach(perk => {
      const isMax = perk.level >= perk.maxLevel;
      const row = document.createElement('div');
      row.className = 'shop-row';
      row.innerHTML = `
        <div class="shop-info">
          <div class="shop-title">${perk.emoji} ${perk.name} <span class="shop-level">Lv.${perk.level}/${perk.maxLevel}</span></div>
          <div class="shop-desc">${perk.desc}${perk.maxLevel > 1 ? ' (레벨당)' : ''}</div>
        </div>
        <button class="shop-btn perk-btn" data-perk="${perk.key}" data-points="${isMax ? '' : perk.cost}" ${isMax || p.points < perk.cost ? 'disabled' : ''}>${isMax ? 'MAX' : `✨ ${perk.cost}`}</button>
      `;
      perkList.appendChild(row);
    });
    perkList.querySelectorAll('[data-perk]').forEach(btn => {
      btn.addEventListener('click', () => postShopAction('/api/box/prestige-shop', { key: btn.dataset.perk }, btn));
    });
  }

  upgradeList.querySelectorAll('[data-upgrade]').forEach(btn => {
    btn.addEventListener('click', () => buyUpgrade(btn.dataset.upgrade, btn));
  });
  autoList.querySelectorAll('[data-autoopen]').forEach(btn => {
    btn.addEventListener('click', () => {
      const hours = btn.dataset.autoopen === 'max' ? 'max' : 1;
      postShopAction('/api/box/auto-open', { hours }, btn);
    });
  });
  autoList.querySelectorAll('[data-autoopen-toggle]').forEach(btn => {
    btn.addEventListener('click', () => postShopAction('/api/box/auto-open', { enabled: btn.dataset.autoopenToggle !== 'true' }, btn));
  });
  autoList.querySelectorAll('[data-autocraft]').forEach(btn => {
    btn.addEventListener('click', () => postShopAction('/api/box/auto-craft', { enabled: btn.dataset.enabled !== 'true' }, btn));
  });
  updateUpgradeAffordability();
}

function formatHoursText(ms){
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}분`;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

// 강화 화면의 자동 개봉 남은 시간 표시 (매 틱마다 갱신)
function renderAutoOpenTimer(){
  const textEl = document.getElementById('autoOpenRemainingText');
  if (!textEl || !lastStatus || !lastStatus.autoOpen) return;
  const ao = lastStatus.autoOpen;
  const remainingMs = ao.enabled ? autoOpenRemainingMs() : ao.remainingMs;
  textEl.textContent = `${formatDuration(Math.floor(remainingMs / 1000))} 남음`;
  document.getElementById('autoOpenBar').style.width = `${Math.min(100, (remainingMs / ao.maxMs) * 100)}%`;
}

// 골드가 실시간으로 늘어나므로, 살 수 있게 되는 순간 버튼을 켜줍니다.
function updateUpgradeAffordability(){
  const gold = liveGold();
  upgradeScreen.querySelectorAll('.shop-btn[data-cost]').forEach(btn => {
    if (btn.dataset.busy) return;
    const cost = btn.dataset.cost;
    // 가격이 없는 버튼: 최대 레벨/더 채울 수 없는 상태는 계속 잠그고, 해금된 자동 합성 켜기·끄기만 열어둡니다.
    if (cost === '') { btn.disabled = !btn.dataset.autocraft; return; }
    btn.disabled = gold < Number(cost);
  });
}

function showUpgradeResult(message, isError){
  const el = document.getElementById('upgradeResult');
  el.style.display = 'block';
  el.style.color = isError ? 'var(--danger)' : 'var(--gold)';
  el.textContent = message;
}

async function postShopAction(path, body, btn){
  btn.dataset.busy = '1';
  btn.disabled = true;
  try {
    const res = await authFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    showUpgradeResult(data.message, !res.ok);
    if (res.ok && typeof data.totalTreasure === 'number') setGold(data.totalTreasure);
  } catch (err) {
    showUpgradeResult('서버에 연결할 수 없습니다.', true);
  } finally {
    delete btn.dataset.busy;
    await refreshStatus();
  }
}

function buyUpgrade(key, btn){
  return postShopAction('/api/box/upgrade', { key }, btn);
}


// -------------------------------
// 짧은 알림 (화면 위쪽에 잠깐 떴다 사라짐)
// -------------------------------
let toastTimer = null;
function showToast(message, isError){
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.toggle('error', Boolean(isError));
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

// -------------------------------
// 황금 상자
// -------------------------------
let goldenBoxInfo = null;
function applyGoldenBox(box){
  if (!box) return;
  if (box.info) goldenBoxInfo = box.info;
  const now = adjustedNow().getTime();
  if (box.available) {
    goldenBoxAppearAt = new Date(now);
    goldenBoxExpireAt = new Date(now + box.expiresInMs);
  } else if (box.appearsInMs != null) {
    goldenBoxAppearAt = new Date(now + box.appearsInMs);
    goldenBoxExpireAt = new Date(now + box.expiresInMs);
  }
}

function renderGoldenBox(){
  const el = document.getElementById('goldenBox');
  const loggedIn = authScreen.classList.contains('hidden');
  const now = adjustedNow();
  const visible = loggedIn && goldenBoxAppearAt && now >= goldenBoxAppearAt && now < goldenBoxExpireAt;
  el.classList.toggle('hidden', !visible);
  if (visible) {
    const secondsLeft = Math.ceil((goldenBoxExpireAt - now) / 1000);
    document.getElementById('goldenBoxTimer').textContent = `${secondsLeft}초 안에 터치!`;
  }
}

// 보유 골드 옆 ? : 분당 수입이 어떻게 계산되는지 보여줍니다.
function renderIncomeHelp(){
  const inc = cachedIncome;
  if (!inc) return;
  const boostLeft = boostRemainingMs();
  document.getElementById('incomeHelpRate').textContent = `분당 +${formatGold(inc.perMinuteIncome)}G`;
  const rows = [];
  rows.push(['기본 수입', `${formatGold(inc.baseIncome)}G`]);
  const items = [...(inc.items || [])].sort((a, b) => b.incomePerMinute - a.incomePerMinute);
  rows.push([`아이템 ${items.length}종`, `+${formatGold(inc.itemIncome)}G`]);
  items.slice(0, 3).forEach(it => rows.push([`　└ ${it.name} x${formatGold(it.count)}${it.stars ? ` ★${it.stars}` : ''}`, `+${formatGold(it.incomePerMinute)}G`]));
  if (inc.upgradeBonusPercent > 0) rows.push(['🛠 수입 강화', `×${(100 + inc.upgradeBonusPercent) / 100}`]);
  if (inc.prestigeBonusPercent > 0) rows.push(['✨ 환생 특성', `×${(100 + inc.prestigeBonusPercent) / 100}`]);
  if (inc.mythicBonusPercent > 0) rows.push(['🌟 아이템 효과·오늘의 규칙', `×${(100 + inc.mythicBonusPercent) / 100}`]);
  if (boostLeft > 0) rows.push([`⚡ 수입 2배 (${formatDuration(Math.floor(boostLeft / 1000)).slice(3)} 남음)`, `×${cachedBoostMultiplier}`]);
  const list = document.getElementById('incomeHelpList');
  list.innerHTML = rows.map(([k, v]) => `<li><span>${escapeHtml(k)}</span><span class="golden-chance">${escapeHtml(v)}</span></li>`).join('');
  const storage = lastStatus && lastStatus.storageMs ? formatHoursText(lastStatus.storageMs) : '';
  document.getElementById('incomeHelpNote').textContent =
    `(기본 + 아이템) × 배율 = 분당 수입. 아이템은 등급이 높을수록, ★(같은 아이템 10·30·100·300개)가 붙을수록 수입 증가.`
    + (storage ? ` 접속하지 않아도 최대 ${storage}까지 적립(강화의 창고로 확장).` : '');
}
document.getElementById('incomeHelpBtn').addEventListener('click', () => {
  renderIncomeHelp();
  document.getElementById('incomeOverlay').classList.add('show');
});
document.getElementById('incomeHelpCloseBtn').addEventListener('click', () => {
  document.getElementById('incomeOverlay').classList.remove('show');
});

// 황금 상자 안내 팝업 (골드 설명 안의 "황금 상자란?")
document.getElementById('goldenHintBtn').addEventListener('click', () => {
  document.getElementById('incomeOverlay').classList.remove('show');
  const info = goldenBoxInfo;
  document.getElementById('goldenInfoTiming').textContent = info
    ? `접속해 있는 동안 ${info.minGapMinutes}~${info.maxGapMinutes}분마다 등장. 등장 후 ${info.windowSeconds}초 안에 터치!`
    : '접속 중 가끔 등장. 금방 사라지니 빠르게 터치!';
  const list = document.getElementById('goldenInfoRewards');
  list.innerHTML = '';
  (info ? info.rewards : []).forEach(r => {
    const li = document.createElement('li');
    li.innerHTML = `<span></span><span class="golden-chance">${r.chancePercent}%</span>`;
    li.firstChild.textContent = r.text;
    list.appendChild(li);
  });
  document.getElementById('goldenInfoOverlay').classList.add('show');
});
document.getElementById('goldenInfoCloseBtn').addEventListener('click', () => {
  document.getElementById('goldenInfoOverlay').classList.remove('show');
});

document.getElementById('goldenBox').addEventListener('click', async function(){
  this.disabled = true;
  try {
    const res = await authFetch('/api/box/golden-box', { method: 'POST' });
    const data = await res.json();
    showToast(data.message, !res.ok);
    goldenBoxAppearAt = null;
    goldenBoxExpireAt = null;
    renderGoldenBox();
    if (res.ok) {
      setGold(data.totalTreasure);
      if (data.boostUntil) cachedBoostUntil = new Date(data.boostUntil);
      if (data.obtained) checkAndTriggerLegendary(data.obtained, data.mythicPityTriggered);
      else triggerLegendaryEffect();
    }
  } catch (err) {
    showToast('서버에 연결할 수 없습니다.', true);
  } finally {
    this.disabled = false;
    refreshStatus();
  }
});

// -------------------------------
// 업적 화면
// -------------------------------
function renderAchievementBadge(count){
  const badge = document.getElementById('achievementBadge');
  badge.textContent = count > 0 ? count : '';
  badge.classList.toggle('hidden', !(count > 0));
}

document.getElementById('openAchievementBtn').addEventListener('click', async () => {
  gameScreen.classList.add('hidden');
  achievementScreen.classList.remove('hidden');
  document.getElementById('achievementResult').style.display = 'none';
  renderAchievements();
  await refreshStatus();
});
document.getElementById('backFromAchievementBtn').addEventListener('click', () => {
  goTab('home');
});

const STAT_UNIT = { boxes: '개', crafts: '번', legendary: '개', mythic: '개', golden: '번', bestIncome: 'G/분', rebirths: '번' };

function renderAchievements(){
  if (!lastStatus || !lastStatus.achievements) return;
  const list = document.getElementById('achievementList');
  // 종류(stat)별로 묶어서, 받을 수 있는 단계 + 지금 도전 중인 단계 하나만 보여줍니다.
  const groups = {};
  lastStatus.achievements.forEach(a => { (groups[a.stat] = groups[a.stat] || []).push(a); });
  const visible = [];
  Object.values(groups).forEach(tiers => {
    const claimable = tiers.filter(a => a.claimable);
    const next = tiers.find(a => !a.claimed && !a.claimable);
    const doneCount = tiers.filter(a => a.claimed).length;
    claimable.forEach(a => visible.push({ ...a, tierText: `${tiers.indexOf(a) + 1}/${tiers.length}단계` }));
    if (next && claimable.length === 0) visible.push({ ...next, tierText: `${tiers.indexOf(next) + 1}/${tiers.length}단계` });
    if (!next && claimable.length === 0) visible.push({ ...tiers[tiers.length - 1], tierText: `${doneCount}/${tiers.length}단계 모두 완료` });
  });
  // 받을 수 있는 것 → 진행 중 → 완료 순서
  const order = a => (a.claimable ? 0 : a.claimed ? 2 : 1);
  visible.sort((a, b) => order(a) - order(b));
  list.innerHTML = '';
  visible.forEach(a => {
    const row = document.createElement('div');
    row.className = `achievement-row ${a.claimable ? 'claimable' : ''} ${a.claimed ? 'done' : ''}`;
    const pct = Math.min(100, (a.progress / a.goal) * 100);
    const unit = STAT_UNIT[a.stat] || '';
    row.innerHTML = `
      <span class="achievement-emoji">${a.emoji}</span>
      <div class="achievement-info">
        <div class="achievement-title">${a.name} <span class="shop-level">${a.tierText}</span></div>
        <div class="achievement-goal">${formatGold(a.progress)} / ${formatGold(a.goal)}${unit} · 보상 ${a.rewardText}</div>
        <div class="time-bar-wrap"><div class="time-bar-fill" style="width:${pct}%"></div></div>
      </div>
      ${a.claimable
        ? `<button class="shop-btn achievement-btn" data-achievement="${a.key}">받기</button>`
        : `<span class="achievement-state">${a.claimed ? '✔ 완료' : '진행 중'}</span>`}
    `;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-achievement]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const res = await authFetch('/api/box/achievement', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: btn.dataset.achievement }),
        });
        const data = await res.json();
        showToast(data.message, !res.ok);
        if (res.ok) setGold(data.totalTreasure);
      } catch (err) {
        showToast('서버에 연결할 수 없습니다.', true);
      } finally {
        await refreshStatus();
      }
    });
  });
}

// -------------------------------
// 랭킹 화면
// -------------------------------
document.getElementById('openRankingBtn').addEventListener('click', async () => {
  gameScreen.classList.add('hidden');
  rankingScreen.classList.remove('hidden');
  // 지금 모드의 랭킹만 보여줍니다.
  setRankType(currentMode === 'collection' ? 'collection' : 'record');
});
document.getElementById('backFromRankingBtn').addEventListener('click', () => {
  goTab('home');
});
document.getElementById('rankPrevBtn').addEventListener('click', async () => {
  if (currentRankPage > 1) { currentRankPage--; await loadRanking(); }
});
document.getElementById('rankNextBtn').addEventListener('click', async () => {
  currentRankPage++;
  await loadRanking();
});

// 랭킹 시즌 선택 (드롭다운: 시즌이 늘어나도 한 줄로 유지, 현재 시즌이 맨 위·기본값)
// 시즌은 칩으로 나열해서 눌러서 바로 바꿉니다 (최신 시즌이 맨 앞).
function renderSeasonTabs(currentSeason, shownSeason){
  const wrap = document.getElementById('seasonPicker');
  wrap.innerHTML = '';
  for (let s = currentSeason; s >= 1; s--) {
    const chip = document.createElement('button');
    chip.className = `season-chip${s === shownSeason ? ' active' : ''}`;
    chip.textContent = s === currentSeason ? `시즌 ${s} · 지금` : `시즌 ${s}`;
    chip.addEventListener('click', () => {
      if (s === shownSeason) return;
      currentRankSeason = s === currentSeason ? null : s;
      currentRankPage = 1;
      loadRanking();
    });
    wrap.appendChild(chip);
  }
}

// -------------------------------
// 아이템 아이콘
// -------------------------------
const RARITY_ORDER_UI = ['mythic', 'legendary', 'epic', 'rare', 'common'];
function iconSrc(key){ return `icons/items/${key}.svg`; }
// unknown: 아직 발견하지 못한 아이템 → 실루엣으로 표시
function itemIconHtml(key, cls = 'item-icon', unknown = false){
  return `<img class="${cls}${unknown ? ' unknown' : ''}" src="${iconSrc(key)}" alt="" loading="lazy" draggable="false">`;
}
// 얻은 아이템 묶음을 아이콘 칩으로 (등급 높은 것부터)
function obtainedChipsHtml(list){
  return [...(list || [])]
    .sort((a, b) => RARITY_ORDER_UI.indexOf(a.rarity) - RARITY_ORDER_UI.indexOf(b.rarity))
    .map(o => `<span class="obtained-chip ${o.rarity || ''}">${itemIconHtml(o.key, 'chip-icon')}${escapeHtml(o.name)} x${formatGold(o.count)}</span>`)
    .join('');
}
// 결과 칸 위쪽 큰 아이콘 (key가 없으면 숨김)
function setResultIcon(key){
  const img = document.getElementById('treasureIcon');
  if (!key) { img.classList.add('hidden'); return; }
  img.src = iconSrc(key);
  img.classList.remove('hidden');
}

// -------------------------------
// 시즌(매주 목요일) · 오늘의 신화와 규칙(매일) — 둘 다 오전 9시에 바뀜
// -------------------------------
let cachedSeasonEndsAt = null;   // 오늘의 신화·규칙이 바뀌는 시각 (배너 카운트다운)
let lastSeasonInfo = null;

function formatRemaining(ms){
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}일 ${hours}시간`;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  return `${minutes}분`;
}
function formatSeasonDate(iso){
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}(${'일월화수목금토'[d.getDay()]})`;
}

function seasonIconsHtml(mythics, cls){
  return mythics.map(m => `<span class="${cls} ${m.have ? 'have' : ''}" title="${escapeHtml(m.have ? m.name : '아직 없는 신화')} · ${escapeHtml(m.effect)}">${itemIconHtml(m.key, 'season-icon', !m.have)}</span>`).join('');
}

function applySeason(season, seasonChange, codex){
  if (!season) return;
  if (codex) {
    document.getElementById('heroCodexCount').textContent = codex.obtained;
    document.getElementById('heroCodexBar').style.width = `${(codex.obtained / codex.total) * 100}%`;
    document.getElementById('heroTodayMythic').textContent = `오늘 ${season.haveCount}/${season.mythics.length}`;
  }
  lastSeasonInfo = season;
  cachedSeasonEndsAt = season.dayEndsAt ? new Date(season.dayEndsAt) : null;
  document.getElementById('seasonBannerNo').textContent = `시즌 ${season.number}`;
  document.getElementById('seasonRule').textContent = season.rule
    ? `📜 오늘의 규칙 ${season.rule.emoji} ${season.rule.name}: ${season.rule.text}` : '';
  document.getElementById('seasonBannerIcons').innerHTML = seasonIconsHtml(season.mythics, 'season-slot');
  const seasonLeft = season.endsAt ? ` · 시즌 종료 ${formatRemaining(new Date(season.endsAt) - adjustedNow())}` : '';
  document.getElementById('seasonBannerSub').textContent = codex
    ? `오늘의 신화 ${season.haveCount}/${season.mythics.length} · 신화 도감 ${codex.obtained}/${codex.total} ›`
    : `이번 판 신화 ${season.haveCount}/${season.mythics.length}${seasonLeft} ›`;
  document.getElementById('seasonBanner').classList.remove('hidden');
  renderSeasonCountdown();
  maybeShowSeasonOverlay(season, seasonChange);
}

function renderSeasonCountdown(){
  const el = document.getElementById('seasonCountdown');
  if (!el) return;
  el.textContent = cachedSeasonEndsAt ? `⏰ ${formatRemaining(cachedSeasonEndsAt - adjustedNow())}` : '';
  // 오늘의 신화가 바뀌는 순간 서버에서 새 정보를 받아옵니다 (중복 호출 방지)
  if (cachedSeasonEndsAt && adjustedNow() >= cachedSeasonEndsAt) {
    cachedSeasonEndsAt = null;
    setTimeout(refreshStatus, 1500);
  }
}

// 새 시즌 / 새로운 날을 처음 볼 때 한 번 안내합니다. (모드별로 따로 기억)
function seasonSeenKey(){
  return `boxGameDaySeen:${currentUser && currentUser.id}:${currentMode}`;
}
function maybeShowSeasonOverlay(season, seasonChange){
  let seen = null;
  try { seen = JSON.parse(localStorage.getItem(seasonSeenKey())); } catch (e) { /* 저장소를 못 쓰면 무시 */ }
  const newSeason = Boolean(seasonChange) || (seen && seen.season < season.number);
  const newDay = newSeason || (seen && seen.day < season.day);
  try { localStorage.setItem(seasonSeenKey(), JSON.stringify({ season: season.number, day: season.day })); } catch (e) { /* 무시 */ }
  if (!newDay) return;

  const ruleText = season.rule ? ` 오늘의 규칙은 ${season.rule.emoji} ${season.rule.name}(${season.rule.text})!` : '';
  let title;
  let text;
  if (newSeason) {
    const reset = seasonChange ? seasonChange.reset : currentMode === 'record';
    title = `🎉 시즌 ${season.number} 시작!`;
    text = reset
      ? '기록모드 초기화! 모두 같은 출발선에서 이번 시즌 랭킹에 도전하세요. (지난 시즌 기록은 랭킹에서 확인 가능)'
      : '수집모드 진행과 신화 도감은 그대로 유지됩니다.';
  } else {
    title = '☀️ 오늘의 신화 교체';
    text = '오늘만 등장하는 신화 10종. 놓치면 10일 뒤 재등장.';
  }
  document.getElementById('seasonOverlayTitle').textContent = title;
  document.getElementById('seasonOverlayText').textContent = text + ruleText;
  document.getElementById('seasonOverlayIcons').innerHTML = season.mythics.map(m => `
    <div class="season-overlay-item ${m.have ? 'have' : ''}">
      ${itemIconHtml(m.key, 'season-icon', !m.have)}
      <small>${escapeHtml(m.effect)}</small>
    </div>`).join('');
  document.getElementById('seasonOverlay').classList.add('show');
}
document.getElementById('seasonOverlayCloseBtn').addEventListener('click', () => {
  document.getElementById('seasonOverlay').classList.remove('show');
});

// 시즌 배너를 누르면 수집모드는 도감, 기록모드는 가방으로
document.getElementById('seasonBanner').addEventListener('click', () => {
  goTab(currentMode === 'collection' ? 'dex' : 'bag');
});

// -------------------------------
// 기록모드 페이스 (시즌 최고 기록과 구간 비교)
// -------------------------------
function signedDuration(ms){
  const sign = ms < 0 ? '-' : '+';
  const total = Math.floor(Math.abs(ms) / 1000);
  const m = Math.floor(total / 60);
  const sec = String(total % 60).padStart(2, '0');
  return `${sign}${m}:${sec}`;
}
function renderPace(pace, seasonBest){
  const line = document.getElementById('paceLine');
  const bestLine = document.getElementById('seasonBestLine');
  if (!pace) { line.classList.add('hidden'); bestLine.textContent = ''; return; }

  bestLine.textContent = seasonBest
    ? `🏆 최고 ${formatDuration(Math.floor(seasonBest.bestDurationMs / 1000))} · ${seasonBest.rank}위`
    : '첫 기록에 도전!';

  if (pace.bestRunMs == null) {
    line.textContent = pace.reached > 0
      ? `🏁 구간 기록 ${pace.reached * 10}% 지점 통과 · ${formatDuration(Math.floor(pace.lastSplitMs / 1000))}`
      : '🏁 목표의 10%마다 구간 기록 저장 · 첫 환생 후부터 최고 기록과 비교';
    line.className = 'pace-line';
    return;
  }
  if (pace.deltaMs == null) {
    line.textContent = `🏁 최고 기록 페이스: ${pace.nextSplitBestMs != null ? `10% 지점을 ${formatDuration(Math.floor(pace.nextSplitBestMs / 1000))}에 통과` : '비교 중'}`;
    line.className = 'pace-line';
    return;
  }
  const faster = pace.deltaMs <= 0;
  line.textContent = `🏁 ${pace.reached * 10}% 지점 · 최고 기록보다 ${signedDuration(pace.deltaMs).slice(1)} ${faster ? '빠름' : '느림'}`;
  line.className = `pace-line ${faster ? 'ahead' : 'behind'}`;
}

// -------------------------------
// 신화 도감 (계정 전체 · 영구)
// -------------------------------
async function loadCodex(){
  const groupsEl = document.getElementById('codexGroups');
  const headEl = document.getElementById('codexHead');
  if (!groupsEl.children.length) groupsEl.innerHTML = '<p style="color:var(--ink-dim); font-size:13px;">불러오는 중...</p>';
  try {
    const res = await authFetch('/api/box/codex');
    const data = await res.json();
    if (!res.ok) { groupsEl.innerHTML = `<p style="color:var(--danger); font-size:13px;">${escapeHtml(data.message || '불러오지 못했습니다.')}</p>`; return; }

    const pct = Math.round(data.obtained / data.total * 100);
    const rank = data.collectorRank;
    const nextText = rank.next ? `다음 칭호 ${rank.next.emoji} ${rank.next.name}까지 ${rank.next.remaining}종` : '최고 칭호 달성!';
    headEl.innerHTML = `
      <div class="codex-progress"><span>🌟 신화 도감 <strong>${data.obtained}</strong> / ${data.total}</span><span class="codex-bonus">${rank.emoji} ${escapeHtml(rank.name)}</span></div>
      <div class="goal-bar-wrap"><div class="goal-bar-fill codex-bar" style="width:${pct}%"></div></div>
      <p class="codex-rule">${nextText} · 칭호는 랭킹에서 닉네임 옆에 표시<br>
      매일 오전 9시 신화 10종 교체 · 놓치면 10일 뒤 재등장 · 천장은 아직 없는 신화부터 지급</p>`;

    groupsEl.innerHTML = data.groups.map(g => {
      const have = g.items.filter(i => i.obtained).length;
      const when = g.isCurrent
        ? `<span class="codex-when now">오늘 등장 중 · 교체까지 ${formatRemaining(new Date(data.dayEndsAt) - adjustedNow())}</span>`
        : `<span class="codex-when">${g.daysUntil === 1 ? '내일' : `${g.daysUntil}일 뒤`} · ${formatSeasonDate(g.nextStartsAt)} 오전 9시 등장</span>`;
      const cards = g.items.map(i => `
        <div class="codex-card ${i.obtained ? 'have' : ''}" title="${escapeHtml(i.obtained ? `${i.flavor} (${new Date(i.firstObtainedAt).toLocaleDateString()} 획득)` : '아직 얻지 못한 신화')}">
          <span class="tier-badge">${'Ⅰ Ⅱ Ⅲ Ⅳ'.split(' ')[i.tier - 1]}</span>
          ${itemIconHtml(i.key, 'codex-icon', !i.obtained)}
          <div class="codex-name">${i.obtained ? escapeHtml(i.name) : '???'}</div>
          <div class="codex-effect">${escapeHtml(i.effect.per)}</div>
        </div>`).join('');
      return `<section class="codex-group ${g.isCurrent ? 'current' : ''}">
        <div class="codex-group-head"><strong>${have}/${g.items.length}</strong>${when}</div>
        <div class="codex-grid">${cards}</div>
      </section>`;
    }).join('');
  } catch (err) {
    groupsEl.innerHTML = '<p style="color:var(--danger); font-size:13px;">불러오지 못했습니다.</p>';
  }
}

// -------------------------------
// 방명록
// -------------------------------
const guestbookInput = document.getElementById('guestbookInput');
let guestbookOldestId = null;

function formatTimeAgo(iso){
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return '방금';
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}일 전`;
  const d = new Date(iso);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}
function renderGuestbookEntry(e){
  const title = e.title ? `<span class="rank-title" title="${escapeHtml(e.title.name)}">${e.title.emoji}</span>` : '';
  const action = e.isMine
    ? `<button class="link-btn" data-gb-delete="${e.id}">삭제</button>`
    : `<button class="link-btn" data-gb-report="${e.id}">신고</button>`;
  return `
    <div class="guestbook-entry${e.isMine ? ' mine' : ''}">
      <div class="guestbook-meta"><strong>${title}${escapeHtml(e.nickname)}</strong><small>${formatTimeAgo(e.createdAt)}</small>${action}</div>
      <p class="guestbook-text">${escapeHtml(e.message)}</p>
    </div>`;
}
async function loadGuestbook(more = false){
  const listEl = document.getElementById('guestbookList');
  const moreBtn = document.getElementById('guestbookMoreBtn');
  // 이미 글이 보이고 있으면 지우지 않고 새 목록이 오면 한 번에 바꿉니다(깜빡임 방지).
  if (!more && !listEl.querySelector('.guestbook-entry')) listEl.innerHTML = '<p class="guestbook-empty">불러오는 중...</p>';
  try {
    const res = await authFetch(`/api/guestbook${more && guestbookOldestId ? `?before=${guestbookOldestId}` : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.message);
    const html = data.entries.map(renderGuestbookEntry).join('');
    if (more) listEl.insertAdjacentHTML('beforeend', html);
    else listEl.innerHTML = html || '<p class="guestbook-empty">아직 글이 없습니다. 첫 인사를 남겨 보세요!</p>';
    if (data.entries.length) guestbookOldestId = data.entries[data.entries.length - 1].id;
    moreBtn.classList.toggle('hidden', !data.hasMore);
  } catch (err) {
    if (!more && !listEl.querySelector('.guestbook-entry')) listEl.innerHTML = '<p class="guestbook-empty">방명록을 불러오지 못했습니다.</p>';
  }
}
guestbookInput.addEventListener('input', () => {
  document.getElementById('guestbookCount').textContent = `${[...guestbookInput.value].length} / 200`;
});
document.getElementById('guestbookForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('guestbookSubmitBtn');
  if (!guestbookInput.value.trim()) return;
  btn.disabled = true;
  try {
    const res = await authFetch('/api/guestbook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: guestbookInput.value }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.message, true); return; }
    guestbookInput.value = '';
    document.getElementById('guestbookCount').textContent = '0 / 200';
    // 목록을 다시 불러오지 않고 방금 쓴 글만 맨 위에 추가합니다.
    const listEl = document.getElementById('guestbookList');
    listEl.querySelector('.guestbook-empty')?.remove();
    listEl.insertAdjacentHTML('afterbegin', renderGuestbookEntry(data.entry));
    listEl.firstElementChild.classList.add('just-added');
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('guestbookMoreBtn').addEventListener('click', () => loadGuestbook(true));
document.getElementById('guestbookList').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-gb-delete]');
  const rep = e.target.closest('[data-gb-report]');
  if (!del && !rep) return;
  if (del && !confirm('이 글을 삭제하시겠습니까?')) return;
  if (rep && !confirm('이 글을 신고하시겠습니까? 신고한 글은 즉시 숨겨집니다.')) return;
  const id = (del || rep).dataset[del ? 'gbDelete' : 'gbReport'];
  const res = await authFetch(del ? `/api/guestbook/${id}` : `/api/guestbook/${id}/report`, { method: del ? 'DELETE' : 'POST' });
  const data = await res.json();
  showToast(data.message, !res.ok);
  if (res.ok) (del || rep).closest('.guestbook-entry').remove();
});

// -------------------------------
// 신화 선택 상자 (수집모드): 칭호 달성·큰 업적 보상. 아직 도감에 없는 신화 중 1종을 골라 받습니다.
// -------------------------------
const choiceOverlay = document.getElementById('choiceOverlay');
let choiceBoxCount = 0;
let pickedChoiceKey = null;
function applyChoiceBox(choiceBox, rankReward){
  if (rankReward) showToast(`${rankReward.rank.emoji} ${rankReward.rank.name} 달성! 🎁 신화 선택 상자 +${rankReward.count}`);
  choiceBoxCount = choiceBox ? choiceBox.count : 0;
  const usable = choiceBox && choiceBox.count > 0 && choiceBox.remainingMythics > 0;
  document.getElementById('choiceBoxCount').textContent = choiceBoxCount;
  document.getElementById('choiceBoxBtn').classList.toggle('hidden', !usable);
}
async function openChoiceBox(){
  pickedChoiceKey = null;
  const grid = document.getElementById('choiceGrid');
  const confirmBtn = document.getElementById('choiceConfirmBtn');
  confirmBtn.disabled = true;
  document.getElementById('choicePicked').textContent = '받을 신화를 선택하세요';
  document.getElementById('choiceSub').textContent = `아직 없는 신화 중 1종 선택 · 보유 ${choiceBoxCount}개`;
  grid.innerHTML = '<p class="guestbook-empty">불러오는 중...</p>';
  choiceOverlay.classList.add('show');
  try {
    const res = await authFetch('/api/box/codex');
    const data = await res.json();
    if (!res.ok) throw new Error(data.message);
    // 오늘 등장 중인 묶음이 맨 앞 (서버가 이미 그 순서로 줌)
    const missing = data.groups.flatMap(g => g.items.filter(i => !i.obtained).map(i => ({ ...i, isToday: g.isCurrent })));
    grid.innerHTML = missing.map(i => `
      <button class="codex-card choice-option" data-choice="${i.key}" data-effect="${escapeHtml(i.effect.per)}">
        <span class="tier-badge">${'Ⅰ Ⅱ Ⅲ Ⅳ'.split(' ')[i.tier - 1]}</span>
        ${i.isToday ? '<span class="choice-today">오늘</span>' : ''}
        ${itemIconHtml(i.key, 'codex-icon', true)}
        <div class="codex-effect">${escapeHtml(i.effect.per)}</div>
      </button>`).join('') || '<p class="guestbook-empty">도감을 모두 채웠습니다!</p>';
  } catch (err) {
    grid.innerHTML = '<p class="guestbook-empty">불러오지 못했습니다.</p>';
  }
}
document.getElementById('choiceBoxBtn').addEventListener('click', openChoiceBox);
document.getElementById('choiceCloseBtn').addEventListener('click', () => choiceOverlay.classList.remove('show'));
document.getElementById('choiceGrid').addEventListener('click', (e) => {
  const card = e.target.closest('[data-choice]');
  if (!card) return;
  pickedChoiceKey = card.dataset.choice;
  document.querySelectorAll('#choiceGrid [data-choice]').forEach(el => el.classList.toggle('picked', el === card));
  document.getElementById('choicePicked').textContent = `선택: ${card.dataset.effect} 효과의 신화`;
  document.getElementById('choiceConfirmBtn').disabled = false;
});
document.getElementById('choiceConfirmBtn').addEventListener('click', async function(){
  if (!pickedChoiceKey) return;
  this.disabled = true;
  try {
    const res = await authFetch('/api/box/choose-mythic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: pickedChoiceKey }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.message, true); this.disabled = false; return; }
    choiceOverlay.classList.remove('show');
    showMythicPopup(data.obtained, false, '🎁 신화 선택 상자 ✦');
    await refreshStatus();
    if (currentTab === 'dex') loadCodex();
  } catch (err) {
    this.disabled = false;
  }
});

// -------------------------------
// 뒤로가기 (안드로이드 뒤로 버튼 · 브라우저 뒤로)
// 게임에 들어오면 history에 "보호용" 기록을 하나 쌓아 두고, 뒤로가기가 그 기록을 지우면(popstate) 직접 처리합니다.
//   1) 창(오버레이)이 열려 있으면 → 그 창만 닫기
//   2) 홈이 아닌 탭이면 → 홈으로
//   3) 홈이면 → "종료하시겠습니까?" 창. 이때는 보호용 기록을 다시 쌓지 않으므로 뒤로가기를 한 번 더 누르면 그대로 종료됩니다.
// -------------------------------
const exitOverlay = document.getElementById('exitOverlay');
const OVERLAY_CLOSE_BUTTONS = {
  awayOverlay: 'awayCloseBtn', goldenInfoOverlay: 'goldenInfoCloseBtn', seasonOverlay: 'seasonOverlayCloseBtn',
  incomeOverlay: 'incomeHelpCloseBtn', settingsOverlay: 'settingsCloseBtn', modePickerOverlay: 'modePickerCloseBtn',
  choiceOverlay: 'choiceCloseBtn', deleteAccountOverlay: 'deleteAccountCancelBtn',
};
function armBackGuard(){
  if (!history.state || !history.state.boxGameGuard) history.pushState({ boxGameGuard: true }, '');
}
window.addEventListener('popstate', () => {
  if (!document.body.classList.contains('in-game')) return; // 로그인 화면에서는 기본 동작(종료)
  if (exitOverlay.classList.contains('show')) return; // 종료 창에서 한 번 더 누름 → 이미 앱 밖으로 나가는 중
  if (!guideLayer.classList.contains('hidden')) { endGuide(); armBackGuard(); return; }
  const openOverlay = Object.keys(OVERLAY_CLOSE_BUTTONS).find(id => document.getElementById(id).classList.contains('show'));
  if (openOverlay) {
    document.getElementById(OVERLAY_CLOSE_BUTTONS[openOverlay]).click();
    armBackGuard();
    return;
  }
  if (currentTab !== 'home') {
    goTab('home');
    armBackGuard();
    return;
  }
  exitOverlay.classList.add('show'); // 보호용 기록 없이 띄움: 다음 뒤로가기는 종료
});
document.getElementById('exitStayBtn').addEventListener('click', () => {
  exitOverlay.classList.remove('show');
  armBackGuard();
});
document.getElementById('exitQuitBtn').addEventListener('click', () => {
  // 앱(TWA·설치 앱)에서는 첫 화면에서 뒤로 가면 종료됩니다. 안 되는 환경이면 창 닫기를 시도하고, 그래도 남아 있으면 안내.
  history.back();
  setTimeout(() => { window.close(); }, 150);
  setTimeout(() => { if (!document.hidden) showToast('뒤로가기를 한 번 더 누르면 종료됩니다'); }, 600);
});

// -------------------------------
// 처음 하는 사람을 위한 화면 가이드 (계정마다 한 번 · 설정 → 게임 가이드로 다시 보기)
// 실제 화면의 해당 부분을 밝게 비추고(나머지는 어둡게) 설명 말풍선을 띄웁니다.
// -------------------------------
const GUIDE_STEPS = [
  { target: '#chest', title: '📦 상자 열기', text: '상자는 시간이 지나면 저절로 충전됩니다. 상자를 누르면 쌓인 상자가 한 번에 열립니다.' },
  { target: '.gold-row', title: '💰 골드 수입', text: '모은 아이템이 매 분 골드를 벌어 줍니다. 접속하지 않아도 쌓입니다. ? 를 누르면 수입 계산을 볼 수 있습니다.' },
  { target: () => currentMode === 'collection' ? '#collectionHero' : '#rebirthGoalBox',
    title: () => currentMode === 'collection' ? '📖 수집모드 목표' : '🏁 기록모드 목표',
    text: () => currentMode === 'collection'
      ? '신화 100종 도감을 채우는 모드. 도감이 늘어날수록 칭호가 오르고, 칭호마다 원하는 신화를 고르는 선택 상자를 받습니다.'
      : '30만 골드를 최대한 빨리 모으는 레이스. 다 모으면 환생하고 기록이 랭킹에 올라갑니다. 환생할수록 특성이 쌓여 더 빨라집니다.' },
  { target: '#pityBox', title: '🌸 신화 천장', text: '상자를 열 때마다 게이지가 찹니다. 가득 차면 아직 없는 신화가 확정으로 나옵니다.' },
  { target: '#seasonBanner', title: '🗓 오늘의 신화', text: '매일 오전 9시에 신화 10종이 바뀝니다. 오늘 놓친 신화는 10일 뒤 다시 등장합니다.' },
  { target: '#tabBar [data-tab="bag"]', title: '🎒 가방 · 합성', text: '같은 아이템 3개를 모으면 한 등급 위로 합성할 수 있습니다. 등급이 높을수록 골드를 더 많이 법니다.' },
  { target: '#tabBar [data-tab="upgrade"]', title: '🛠 강화', text: '골드로 수입·충전 속도·창고·행운을 올립니다. 자동 개봉을 사 두면 자리를 비운 동안에도 상자가 열립니다.' },
  { target: '#modeBadge', title: '🎮 모드 전환', text: '기록모드와 수집모드는 따로 저장됩니다. 여기를 눌러 언제든 오갈 수 있습니다. 즐거운 수집 되세요!' },
];
const guideLayer = document.getElementById('guideLayer');
let guideSteps = [];
let guideIndex = 0;
const guideValue = (v) => (typeof v === 'function' ? v() : v);
function guideKey(){ return `boxGameGuide:${currentUser && currentUser.id}`; }
function maybeStartGuide(){
  let seen = true;
  try { seen = Boolean(localStorage.getItem(guideKey())); } catch (e) { /* 저장소를 못 쓰면 띄우지 않음 */ }
  if (!seen) setTimeout(startGuide, 500);
}
function startGuide(){
  if (currentTab !== 'home') goTab('home');
  try { localStorage.setItem(guideKey(), '1'); } catch (e) { /* 무시 */ }
  // 지금 화면에 보이는 대상만 안내합니다 (예: 기록모드엔 도감 카드가 없음)
  guideSteps = GUIDE_STEPS.filter(step => {
    const el = document.querySelector(guideValue(step.target));
    return el && el.offsetParent !== null;
  });
  if (guideSteps.length === 0) return;
  guideIndex = 0;
  guideLayer.classList.remove('hidden');
  showGuideStep();
}
function endGuide(){
  guideLayer.classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function showGuideStep(){
  const step = guideSteps[guideIndex];
  const el = document.querySelector(guideValue(step.target));
  if (!el) { nextGuideStep(); return; }
  document.getElementById('guideStep').textContent = `${guideIndex + 1} / ${guideSteps.length}`;
  document.getElementById('guideTitle').textContent = guideValue(step.title);
  document.getElementById('guideText').textContent = guideValue(step.text);
  document.getElementById('guideNextBtn').textContent = guideIndex === guideSteps.length - 1 ? '시작하기' : '다음';
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(placeGuide, 350); // 스크롤이 끝난 뒤 위치를 잡습니다
}
function placeGuide(){
  if (guideLayer.classList.contains('hidden')) return;
  const step = guideSteps[guideIndex];
  const el = document.querySelector(guideValue(step.target));
  if (!el) return;
  const r = el.getBoundingClientRect();
  const pad = 6;
  const spot = document.getElementById('guideSpot');
  spot.style.left = `${r.left - pad}px`;
  spot.style.top = `${r.top - pad}px`;
  spot.style.width = `${r.width + pad * 2}px`;
  spot.style.height = `${r.height + pad * 2}px`;
  // 대상이 화면 아래쪽이면 말풍선을 위에, 위쪽이면 아래에 띄웁니다.
  const tip = document.getElementById('guideTip');
  const below = r.top + r.height / 2 < window.innerHeight / 2;
  tip.style.top = below ? `${Math.min(r.bottom + 14, window.innerHeight - tip.offsetHeight - 12)}px` : '';
  tip.style.bottom = below ? '' : `${Math.max(window.innerHeight - r.top + 14, 12)}px`;
}
function nextGuideStep(){
  guideIndex++;
  if (guideIndex >= guideSteps.length) endGuide();
  else showGuideStep();
}
document.getElementById('guideNextBtn').addEventListener('click', nextGuideStep);
document.getElementById('guideSkipBtn').addEventListener('click', endGuide);
window.addEventListener('resize', placeGuide);
document.getElementById('openGuideBtn').addEventListener('click', () => {
  settingsOverlay.classList.remove('show');
  setTimeout(startGuide, 200);
});

// -------------------------------
// 설정 (상단 ⚙️): 초심으로 돌아가기, 로그아웃, 개인정보처리방침, 계정 삭제
// -------------------------------
const settingsOverlay = document.getElementById('settingsOverlay');
document.getElementById('settingsBtn').addEventListener('click', () => {
  document.getElementById('settingsNickname').textContent = currentUser ? currentUser.nickname : '';
  document.getElementById('settingsEmail').textContent = currentUser ? currentUser.email : '';
  settingsOverlay.classList.add('show');
});
document.getElementById('settingsCloseBtn').addEventListener('click', () => settingsOverlay.classList.remove('show'));
// 설정 안의 버튼을 누르면 창을 닫고 진행합니다(확인창·계정 삭제 창이 그 위에 뜨도록).
['installAppBtn', 'resetRunBtn', 'logoutBtn', 'openDeleteAccountBtn'].forEach(id =>
  document.getElementById(id).addEventListener('click', () => settingsOverlay.classList.remove('show'), true));

// -------------------------------
// 앱으로 설치 (설정 안 버튼)
// - 안드로이드 크롬 등: 브라우저가 "설치 가능"을 알려줄 때(beforeinstallprompt)만 버튼을 보여주고, 누르면 설치 창을 띄웁니다.
// - 아이폰 사파리: 설치 창을 띄울 수 없어서 "홈 화면에 추가" 방법을 안내합니다.
// - 이미 앱으로 실행 중이면 버튼을 숨깁니다.
// -------------------------------
const installAppBtn = document.getElementById('installAppBtn');
let deferredInstallPrompt = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIosSafari = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios|kakaotalk|naver/i.test(navigator.userAgent);
function updateInstallButton(){
  installAppBtn.classList.toggle('hidden', isStandalone() || !(deferredInstallPrompt || isIosSafari()));
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // 크롬 기본 안내 대신 설정의 버튼으로 설치합니다.
  deferredInstallPrompt = e;
  updateInstallButton();
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  updateInstallButton();
  showToast('📲 앱 설치 완료! 홈 화면에서 실행하세요');
});
installAppBtn.addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice.catch(() => null);
    deferredInstallPrompt = null; // 한 번 쓴 설치 창은 다시 쓸 수 없어요.
    updateInstallButton();
  } else if (isIosSafari()) {
    alert('아이폰: 아래 공유 버튼(□↑) → "홈 화면에 추가"를 선택하면 앱처럼 설치됩니다.');
  }
});
updateInstallButton();

// -------------------------------
// 계정 삭제 (스토어 정책: 앱 안에서 계정을 지울 수 있어야 함)
// -------------------------------
document.getElementById('openDeleteAccountBtn').addEventListener('click', () => {
  document.getElementById('deleteAccountPassword').value = '';
  document.getElementById('deleteAccountError').style.display = 'none';
  document.getElementById('deleteAccountOverlay').classList.add('show');
});
document.getElementById('deleteAccountCancelBtn').addEventListener('click', () => {
  document.getElementById('deleteAccountOverlay').classList.remove('show');
});
document.getElementById('deleteAccountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('deleteAccountSubmitBtn');
  const errorEl = document.getElementById('deleteAccountError');
  if (!confirm('정말 계정을 삭제하시겠습니까? 복구할 수 없습니다.')) return;
  btn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/auth/delete-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: currentUser.email, password: document.getElementById('deleteAccountPassword').value }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.message;
      errorEl.style.display = 'block';
      return;
    }
    document.getElementById('deleteAccountOverlay').classList.remove('show');
    alert(data.message);
    document.getElementById('logoutBtn').click();
  } catch (err) {
    errorEl.textContent = '서버에 연결할 수 없습니다.';
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
});

// -------------------------------
// 🔮 신화 상자 (자동 개봉 중에 나온 신화. 내용물은 이미 정해져 있고, 유효기간 없음)
// -------------------------------
function applySealed(sealed){
  const btn = document.getElementById('sealedBtn');
  if (!sealed || sealed.count === 0) { btn.classList.add('hidden'); return; }
  document.getElementById('sealedCount').textContent = sealed.count;
  const since = sealed.since ? new Date(sealed.since) : null;
  document.getElementById('sealedSince').textContent = since
    ? `${since.getMonth() + 1}/${since.getDate()} ${String(since.getHours()).padStart(2, '0')}:${String(since.getMinutes()).padStart(2, '0')}부터 자동 개봉으로 획득`
    : '자리 비운 사이 도착';
  btn.classList.remove('hidden');
}

document.getElementById('sealedBtn').addEventListener('click', async function(){
  if (this.disabled) return;
  this.disabled = true;
  try {
    const res = await authFetch('/api/box/open-sealed', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { showToast(data.message, true); return; }
    this.classList.add('hidden');
    showOpenResult(`🔮 신화 상자 ${data.quantity}개 오픈`, data.obtained);
    showMythicPopup(data.obtained, data.pityTriggered, `🔮 신화 상자에서 신화 ${data.quantity}개! ✦`);
    refreshStatus();
  } catch (err) {
    showToast('서버에 연결할 수 없습니다.', true);
  } finally {
    this.disabled = false;
  }
});

// 서버에서 받은 문자열(닉네임 등)을 innerHTML에 넣을 때는 반드시 이스케이프합니다. (저장형 XSS 방지)
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// value: 기록 랭킹은 걸린 시간, 수집 랭킹은 "신화 N종"
function renderRankRow(rank, nickname, value, isMe, title){
  const titleHtml = title ? `<span class="rank-title" title="${escapeHtml(title.name)}">${title.emoji}</span>` : '';
  return `
    <div class="rank-row ${isMe ? 'me' : ''}">
      <span class="rank-num">#${rank}</span>
      <span class="rank-name">${titleHtml}${escapeHtml(nickname)}${isMe ? ' (나)' : ''}</span>
      <span class="rank-time">${value}</span>
    </div>
  `;
}
function rankValue(type, r){
  return type === 'collection' ? `신화 ${r.count}종` : formatDuration(Math.floor(r.bestDurationMs / 1000));
}

// 랭킹은 모드별로 따로: 기록모드 = 시즌 환생 기록 랭킹, 수집모드 = 신화 수집 랭킹
let currentRankType = 'record';
function setRankType(type){
  currentRankType = type;
  currentRankPage = 1;
  currentRankSeason = null;
  document.querySelectorAll('[data-rank-type]').forEach(btn => btn.classList.toggle('active', btn.dataset.rankType === type));
  document.getElementById('seasonPicker').classList.toggle('hidden', type !== 'record');
  loadRanking();
}
document.querySelectorAll('[data-rank-type]').forEach(btn =>
  btn.addEventListener('click', () => { if (btn.dataset.rankType !== currentRankType) setRankType(btn.dataset.rankType); }));
function renderEmptyRankRow(type){
  return `<div class="rank-row empty"><span class="rank-num"></span><span class="rank-name">-</span><span class="rank-time">${type === 'collection' ? '-' : '--:--:--'}</span></div>`;
}

async function loadRanking(){
  const listEl = document.getElementById('rankingList');
  const footerEl = document.getElementById('myRankFooter');
  const paginationEl = document.getElementById('rankPagination');
  listEl.innerHTML = '<p style="color:var(--ink-dim); font-size:13px;">불러오는 중...</p>';
  footerEl.classList.add('hidden');
  paginationEl.classList.add('hidden');

  try {
    const typeQuery = currentRankType === 'collection' ? '&type=collection' : '';
    const seasonQuery = currentRankSeason ? `&season=${currentRankSeason}` : '';
    const res = await authFetch(`/api/box/leaderboard?page=${currentRankPage}${typeQuery}${seasonQuery}`);
    const data = await res.json();
    if (data.type === 'collection') {
      document.getElementById('rankingSubtitle').textContent =
        `수집모드 신화 도감(${data.total}종)을 가장 많이 모은 순위 · 동률이면 먼저 모은 순`;
    } else if (data.season) {
      const isCurrent = data.season === data.currentSeason;
      const period = data.seasonStartsAt && data.seasonEndsAt
        ? ` (${formatSeasonDate(data.seasonStartsAt)} ~ ${formatSeasonDate(data.seasonEndsAt)} 오전 9시)` : '';
      const ruleText = data.rule ? ` · 규칙 ${data.rule.emoji} ${data.rule.name}` : '';
      document.getElementById('rankingSubtitle').textContent =
        `시즌 ${data.season}${isCurrent ? '' : ' (지난 시즌)'}${period}${ruleText} · ${(data.goldRequired / 10000).toLocaleString()}만 골드까지 가장 빨리 도달한 환생 기록입니다`;
      renderSeasonTabs(data.currentSeason, data.season);
    }
    if (!res.ok) {
      listEl.innerHTML = '<p style="color:var(--danger); font-size:13px;">불러오지 못했습니다.</p>';
      return;
    }

    if (data.totalPlayers === 0) {
      listEl.innerHTML = `<p style="color:var(--ink-dim); font-size:13px; text-align:center; padding:20px 0;">${data.type === 'collection'
        ? '아직 신화를 모은 사람이 없습니다.<br>수집모드에서 첫 신화를 찾아보세요!'
        : '아직 환생 기록이 없습니다.<br>첫 기록의 주인공이 되어보세요!'}</p>`;
      return;
    }

    // 항상 RANK_PAGE_SIZE칸의 틀을 유지: 부족한 줄은 빈 자리로 채움
    let html = data.leaderboard.map(r => renderRankRow(r.rank, r.nickname, rankValue(data.type, r), r.isMe, r.title)).join('');
    for (let i = data.leaderboard.length; i < RANK_PAGE_SIZE; i++) {
      html += renderEmptyRankRow(data.type);
    }
    listEl.innerHTML = html;

    // 페이지네이션
    if (data.totalPages > 1) {
      paginationEl.classList.remove('hidden');
      document.getElementById('rankPageText').textContent = `${data.page} / ${data.totalPages}`;
      document.getElementById('rankPrevBtn').disabled = data.page <= 1;
      document.getElementById('rankNextBtn').disabled = data.page >= data.totalPages;
    }

    // 내가 이 페이지에 없으면 하단에 고정 표시
    if (data.myRank && data.myRank.outsideCurrentPage) {
      footerEl.classList.remove('hidden');
      footerEl.innerHTML = `<p style="font-size:11px; color:var(--ink-dim); margin:0 0 6px; text-align:center;">내 순위</p>` +
        renderRankRow(data.myRank.rank, '나', rankValue(data.type, data.myRank), true);
    } else if (!data.myRank) {
      footerEl.classList.remove('hidden');
      const noRecordText = data.type === 'collection'
        ? '수집모드에서 신화를 얻으면 순위에 등록됩니다.'
        : data.season === data.currentSeason
        ? '아직 환생 기록이 없어 순위에 없습니다.'
        : `시즌 ${data.season}에는 내 기록이 없습니다.`;
      footerEl.innerHTML = `<p style="text-align:center; font-size:12px; color:var(--ink-dim);">${noRecordText}</p>`;
    }
  } catch (err) {
    listEl.innerHTML = '<p style="color:var(--danger); font-size:13px;">불러오지 못했습니다.</p>';
  }
}
