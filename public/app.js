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
const lobbyScreen = document.getElementById('lobbyScreen');
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
        showAuthError('서버에 연결하지 못했습니다. 잠시 후 다시 실행해 주십시오. (로그인 정보는 유지됩니다)');
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

// 비밀번호 찾기는 단계마다 보이는 칸이 달라서, 지금 보이는 칸만 기준으로 다음 칸·제출
document.getElementById('forgotForm').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing || e.target.tagName !== 'INPUT') return;
  e.preventDefault();
  const inputs = [...e.currentTarget.querySelectorAll('input')].filter(el => el.offsetParent !== null);
  const i = inputs.indexOf(e.target);
  const next = inputs[i + 1];
  if (next && !e.target.value) return;
  if (next && !next.value) next.focus();
  else e.currentTarget.requestSubmit();
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

// -------------------------------
// 비밀번호 찾기: ① 이메일로 인증 코드 받기 → ② 코드 + 새 비밀번호 → 바로 로그인
// -------------------------------
const forgotForm = document.getElementById('forgotForm');
let forgotStep = 1;
function setForgotStep(step){
  forgotStep = step;
  document.getElementById('forgotStep2').classList.toggle('hidden', step !== 2);
  document.getElementById('forgotResendBtn').classList.toggle('hidden', step !== 2);
  document.getElementById('forgotSubmitBtn').textContent = step === 2 ? '비밀번호 바꾸기' : '인증 코드 받기';
  document.getElementById('forgotDesc').textContent = step === 2
    ? '메일로 받은 6자리 코드와 새 비밀번호를 입력해 주십시오. (메일이 안 보이면 스팸함도 확인해 주십시오)'
    : '가입한 이메일로 6자리 인증 코드를 보내 드립니다.';
}
function showForgot(open){
  clearAuthError();
  forgotForm.classList.toggle('hidden', !open);
  document.getElementById('loginForm').classList.toggle('hidden', open);
  document.querySelector('#authScreen .switch-line').classList.toggle('hidden', open);
  if (open) {
    setForgotStep(1);
    document.getElementById('forgotEmail').value = document.getElementById('loginEmail').value;
  }
}
document.getElementById('openForgotBtn').addEventListener('click', () => showForgot(true));
document.getElementById('closeForgotBtn').addEventListener('click', () => showForgot(false));
async function requestResetCode(){
  const email = document.getElementById('forgotEmail').value.trim();
  if (!email) return showAuthError('이메일을 입력해 주십시오.');
  const res = await fetch(`${API_BASE}/api/auth/forgot`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return showAuthError(data.message || '인증 코드를 보내지 못했습니다.');
  showToast(data.message);
  setForgotStep(2);
  document.getElementById('forgotCode').focus();
}
document.getElementById('forgotResendBtn').addEventListener('click', async function(){
  this.disabled = true;
  clearAuthError();
  try { await requestResetCode(); } catch (e) { showAuthError('서버에 연결할 수 없습니다.'); }
  finally { setTimeout(() => { this.disabled = false; }, 30000); } // 다시 받기는 30초 뒤부터
});
forgotForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = document.getElementById('forgotSubmitBtn');
  if (button.disabled) return;
  clearAuthError();
  setAuthBusy(button, true, forgotStep === 2 ? '바꾸는 중...' : '보내는 중...');
  try {
    if (forgotStep === 1) { await requestResetCode(); return; }
    const res = await fetch(`${API_BASE}/api/auth/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('forgotEmail').value.trim(),
        code: document.getElementById('forgotCode').value.trim(),
        newPassword: document.getElementById('forgotNewPassword').value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showAuthError(data.message || '비밀번호를 바꾸지 못했습니다.');
    authToken = data.token;
    localStorage.setItem('boxGameToken', data.token);
    currentUser = data.user;
    showToast(data.message);
    resetAuthForms();
    enterGame();
  } catch (err) {
    showAuthError('서버에 연결할 수 없습니다.');
  } finally {
    setAuthBusy(button, false);
    setForgotStep(forgotStep); // 단계가 바뀌었으면 버튼 문구도 그 단계에 맞게
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
  setStatusFailed(false);
  goldenBoxAppearAt = null;
  goldenBoxExpireAt = null;
  document.getElementById('goldenBox').classList.add('hidden');
  resetGameResultUI();
  [gameScreen, collectionScreen, upgradeScreen, lobbyScreen, rankingScreen, document.getElementById('guestbookScreen')].forEach(el => el.classList.add('hidden'));
  document.body.classList.remove('in-game');
  // 광장에 있었다면 실시간 연결도 끊고, 이 계정의 차단 목록도 비웁니다.
  lobbyDisconnect();
  blockedIds = new Set();
  resetAuthForms();
  authScreen.classList.remove('hidden');
});

// 로그인 화면을 처음 상태로: 로그인 창을 보여주고, 입력칸(특히 비밀번호)을 모두 비웁니다.
// (회원가입 직후 로그아웃하면 회원가입 창과 입력값이 그대로 남아 있었습니다)
function resetAuthForms(){
  ['loginEmail', 'loginPassword', 'signupNickname', 'signupEmail', 'signupPassword',
    'forgotEmail', 'forgotCode', 'forgotNewPassword'].forEach(id => {
    document.getElementById(id).value = '';
  });
  setForgotStep(1);
  document.getElementById('forgotForm').classList.add('hidden');
  document.getElementById('signupForm').classList.add('hidden');
  document.getElementById('loginForm').classList.remove('hidden');
  document.getElementById('switchToLoginLine').classList.add('hidden');
  document.getElementById('switchToSignupLine').classList.remove('hidden');
  clearAuthError();
}

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
    if (!res.ok) { showToast(data.message, true); return; }

    applyModeUI(data.mode);
    resetGameResultUI();
    document.getElementById('craftResult').style.display = 'none';

    // 화면에 남아있던 이전 모드의 잔상(수입, 환생 진행도 등)을 지우고 새로 불러옴
    cachedIncome = null;
    await refreshStatus();
    if (!collectionScreen.classList.contains('hidden')) await loadCollection(true);
  } catch (err) {
    showToast('모드를 전환하지 못했습니다.', true);
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
  ranking: 'openRankingBtn',
};
let currentTab = 'home';
function goTab(tab){
  if (tab !== 'lobby') lobbyDisconnect(); // 광장을 떠나면 실시간 연결을 닫아 배터리·데이터를 아낍니다
  currentTab = tab;
  document.body.dataset.tab = tab;
  document.querySelectorAll('#tabBar .tab-item').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  [gameScreen, collectionScreen, upgradeScreen, lobbyScreen, rankingScreen, document.getElementById('guestbookScreen')].forEach(el => el.classList.add('hidden'));
  window.scrollTo(0, 0);
  if (tab === 'home') {
    gameScreen.classList.remove('hidden');
    refreshStatus();
    return;
  }
  // 각 화면을 여는 기존 버튼 동작(데이터 불러오기 포함)을 그대로 씁니다.
  if (tab === 'guestbook') { document.getElementById('guestbookScreen').classList.remove('hidden'); loadGuestbook(); return; }
  if (tab === 'lobby') { lobbyScreen.classList.remove('hidden'); requestAnimationFrame(relayoutLobby); lobbyConnect(); return; }
  document.getElementById(TAB_OPENERS[tab]).click();
  if (tab === 'bag' || tab === 'dex') {
    showCollectionTab(tab === 'dex' ? 'dex' : 'run');
    document.getElementById('collectionTitle').textContent = tab === 'dex' ? '도감' : '가방';
  }
}
document.querySelectorAll('#tabBar .tab-item').forEach(btn => {
  btn.addEventListener('click', () => goTab(btn.dataset.tab));
});

function renderMyNickname(){
  document.getElementById('userNickname').innerHTML =
    escapeHtml(currentUser.nickname || currentUser.email) + transcendBadgeHtml(currentUser.transcend_count);
}
function enterGame(){
  renderMyNickname();
  renderEmailState();
  loadBlocks();
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

// 화면에서 난 오류를 서버(Render 로그)로 보내 둡니다. 사용자가 캡처해 주지 않아도 원인을 볼 수 있게.
// 같은 오류는 한 번만, 한 번 접속에 최대 5번까지만 보냅니다. 보내기에 실패해도 게임에는 영향이 없습니다.
const reportedClientErrors = new Set();
function reportClientError(where, err){
  try {
    const message = String(err && err.message || err).slice(0, 300);
    const dedupeKey = `${where}|${message}`;
    if (reportedClientErrors.has(dedupeKey) || reportedClientErrors.size >= 5) return;
    reportedClientErrors.add(dedupeKey);
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    fetch(`${API_BASE}/api/client-error`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ where, message, stack: String(err && err.stack || '').slice(0, 600) }),
      keepalive: true,
    }).catch(() => {});
  } catch (e) { /* 보고 자체가 실패해도 무시 */ }
}
// 네트워크 끊김(요청 실패·시간 초과)은 화면 오류가 아니라 연결 문제라 보내지 않습니다. (연결 안내 배너가 따로 뜸)
const isNetworkError = (err) => err && (err.name === 'AbortError' || /Failed to fetch|NetworkError|Load failed/i.test(err.message || ''));
window.addEventListener('error', (event) => {
  if (!event.error && !event.message) return; // 이미지 등 파일을 못 불러온 경우
  reportClientError('window', event.error || event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  if (!isNetworkError(event.reason)) reportClientError('promise', event.reason);
});

// 서버에서 정확한 상태를 받아와 기준값을 갱신
// 상태를 못 받아오면(서버 재시작·요청 제한·네트워크) 화면이 멈춘 것처럼 보이므로
// 위에 안내를 띄우고, 15초 주기를 기다리지 않고 몇 초 뒤 다시 시도합니다.
const connBanner = document.getElementById('connBanner');
let statusRetryTimer = null;
// reason: 안내 뒤에 붙는 짧은 원인 (응답 코드 · 응답 없음 · 네트워크) — 문제 제보용
function setStatusFailed(failed, reason, title = '서버 연결이 원활하지 않습니다'){
  connBanner.textContent = `${title} · 다시 시도 중${reason ? ` (${reason})` : ''}`;
  connBanner.classList.toggle('show', failed);
  clearTimeout(statusRetryTimer);
  statusRetryTimer = failed ? setTimeout(() => { if (authToken) refreshStatus(); }, 4000) : null;
}

const STATUS_TIMEOUT_MS = 12000;
async function refreshStatus(){
  // 응답이 오지 않고 멈춰 있으면 기다리지 않고 실패로 처리합니다.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  let res, data;
  try {
    res = await authFetch('/api/box/status', { signal: controller.signal });
    data = await res.json().catch(() => ({}));
  } catch (err) {
    setStatusFailed(true, err.name === 'AbortError' ? '응답 없음' : '네트워크');
    return;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // 429: 짧은 시간에 요청이 몰려 서버가 잠시 막은 것 (잠시 뒤 자동으로 다시 시도)
    if (res.status === 429) setStatusFailed(true, '요청이 너무 많음', '요청이 잠시 많습니다');
    else setStatusFailed(true, res.status);
    return;
  }
  setStatusFailed(false);

  try {
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
    applySkills(data.skills);
    if (data.dailyGrant) {
      const parts = [];
      if (data.dailyGrant.autoOpenMs) parts.push(`⏳ 자동 개봉 +${Math.round(data.dailyGrant.autoOpenMs / 3600000)}시간`);
      if (data.dailyGrant.shards) parts.push(`💎 +${data.dailyGrant.shards}`);
      if (parts.length) showToast(`📖 도감 보상 · ${parts.join(' · ')}`);
    }
    applySeason(data.season, data.seasonChange, data.codex);
    renderPace(data.pace, data.seasonBest);
    applySealed(data.sealed);
    renderPrestigeHint(data.prestige);
    applyGoldenBox(data.goldenBox);
    renderAchievementBadge((data.claimableAchievements || 0) + (data.collection ? data.collection.missions.claimable : 0));
    renderHomeMissions();
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
    // 받은 값을 화면에 그리다 오류가 난 경우: 원인을 짧게 보여줘서 제보받을 수 있게 합니다.
    console.error(err);
    reportClientError('refreshStatus', err);
    setStatusFailed(true, String(err && err.message || err).slice(0, 60), '화면을 그리지 못했습니다');
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
  const mythicText = prestige.mythicBonus > 0 ? ` (신화 ${prestige.mythicBonus}종 +${prestige.mythicBonus}P 포함)` : ' · 신화 1종마다 +1P';
  el.textContent = prestige.pointsOnRebirth > 0
    ? `✨ 지금 환생하면 특성 포인트 +${prestige.pointsOnRebirth}P${mythicText}`
    : `✨ ${formatGold(prestige.nextPointAt - prestige.runGoldEarned)}G 더 벌면 특성 포인트 +1P${mythicText}`;
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
  renderSkillTimers();
}

// 골드 상자 가격은 수입에 따라 바뀌므로 서버가 알려준 기준값으로 계산합니다 (상태 조회 때마다 갱신)
// 여러 개를 사면 하나씩 산 것처럼 상자마다 가격이 조금씩 올라갑니다 (서버와 같은 계산)
let cachedBoxPrice = 75;
let cachedBoxPricing = null;

function boxPriceAt(k){
  const p = cachedBoxPricing;
  if (!p) return cachedBoxPrice;
  // 서버(game/logic.js getBoxPrice)와 같은 공식: 최소 가격 × (수입 ÷ 기준 수입)^지수
  const scaled = p.minPrice * Math.pow(Math.max(0, p.income + k * p.step) / p.refIncome, p.exponent);
  const base = Math.max(p.minPrice, Math.floor(scaled));
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
  // 최대 개수로 사는 경우: 그 사이 가격이 조금 올라도 서버가 살 수 있는 만큼으로 맞춰서 삽니다.
  const upTo = quantity >= getMaxBuyableQty();

  isOpening = true;
  this.disabled = true;
  const originalText = this.textContent;
  this.textContent = '구매 중...';

  try {
    const res = await authFetch('/api/box/buy-boxes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity, upTo }),
    });
    const data = await res.json();

    if (!res.ok){
      showToast(data.message, true);
      return;
    }
    if (data.quantity < quantity) showToast(`가격이 올라 ${data.quantity}개만 구매했습니다`);

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

let mythicPopupAddTimers = [];
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
  // 카드를 등장 순서에 맞춰 실제로 하나씩 넣습니다. 한 번에 다 넣으면 아이콘 20개를 첫 프레임에
  // 몰아서 그리느라 팝업이 뜨는 순간 0.4초가량 멈췄습니다.
  const grid = document.getElementById('mythicPopupGrid');
  const stepMs = Math.min(120, 1200 / Math.max(1, mythicPopupItems.length));
  mythicPopupAddTimers.forEach(clearTimeout);
  mythicPopupAddTimers = [];
  grid.innerHTML = '';
  mythicPopupItems.forEach((m, i) => {
    const add = () => grid.insertAdjacentHTML('beforeend', `
      <div class="mythic-popup-item" title="${escapeHtml(m.effectText || '')}">
        ${itemIconHtml(m.key, 'mythic-popup-icon', false, 'eager')}
        <span class="mythic-popup-name">${escapeHtml(m.name)}${m.count > 1 ? ` x${m.count}` : ''}</span>
      </div>`);
    if (i === 0) add();
    else mythicPopupAddTimers.push(setTimeout(add, Math.round(i * stepMs)));
  });
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
  mythicPopupAddTimers.forEach(clearTimeout);
  mythicPopupAddTimers = [];
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
      showToast(data.message, true);
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
  const confirmed = await askConfirm({
    title: '🔄 초심으로 돌아가기',
    text: '골드·아이템·강화·자동화가 모두 사라지고 2,000G부터 다시 시작합니다.\n이번 판은 기록되지 않고, 가진 환생 포인트는 그대로 남습니다.',
    ok: '처음부터', danger: true,
  });
  if (!confirmed) return;

  this.disabled = true;
  try {
    const res = await authFetch('/api/box/reset-run', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { showToast(data.message, true); return; }

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

    // ── 가방: 게임 인벤토리처럼 아이콘 칸만 (이름·설명은 칸을 누르면 툴팁으로) ──
    // 모든 아이템을 항상 같은 순서·같은 칸에 둡니다. (0개가 돼도 칸이 사라지지 않아 위치가 바뀌지 않음)
    bagItems = new Map(data.collection.map(item => [item.key, item]));
    runGrid.innerHTML = data.collection.map(item => {
      const known = item.obtained || item.count > 0; // 한 번도 발견 못 한 아이템은 가립니다
      const canCraft = item.count >= CRAFT_COST && isCraftable(item) && !item.locked;
      const cls = [
        'inv-slot', item.rarity,
        item.count === 0 ? 'is-empty' : '',
        item.locked ? 'is-locked' : '',
        canCraft ? 'can-craft' : '',
        item.key === openTipKey ? 'selected' : '',
      ].join(' ');
      return `<button class="${cls}" data-slot="${item.key}" aria-label="${escapeHtml(known ? item.name : '미발견 아이템')}">
        ${itemIconHtml(item.key, 'inv-icon', !known)}
        ${item.count > 0 ? `<span class="inv-count">${formatGold(item.count)}</span>` : ''}
        ${item.stars > 0 ? `<span class="inv-stars">${'★'.repeat(item.stars)}</span>` : ''}
        ${item.locked ? '<span class="inv-lock">🔒</span>' : ''}
        ${canCraft ? '<span class="inv-up" title="합성 가능">▲</span>' : ''}
      </button>`;
    }).join('');
    if (openTipKey && bagItems.has(openTipKey)) showItemTip(openTipKey);
    else hideItemTip();
  } catch (err) {
    collectionGrid.innerHTML = '<p style="color:var(--danger); font-size:13px;">불러오지 못했습니다.</p>';
  }
}

// -------------------------------
// 가방 툴팁: 칸을 누르면 그 칸 바로 위(공간이 없으면 아래)에 설명과 합성·잠금 버튼
// -------------------------------
let bagItems = new Map();
let openTipKey = null;
// 신화는 상자에서만 나오므로 전설도 합성 재료가 될 수 없음 (일반/희귀/영웅만 합성 가능)
function isCraftable(item){ return item.rarity !== 'legendary' && item.rarity !== 'mythic'; }

function showItemTip(key){
  const item = bagItems.get(key);
  const slot = document.querySelector(`#runInventoryGrid [data-slot="${key}"]`);
  const tip = document.getElementById('itemTip');
  if (!item || !slot) { hideItemTip(); return; }
  openTipKey = key;
  document.querySelectorAll('#runInventoryGrid .inv-slot.selected').forEach(el => el.classList.remove('selected'));
  slot.classList.add('selected');

  const known = item.obtained || item.count > 0;
  if (!known) {
    tip.innerHTML = `<div class="tip-name">???</div><p class="tip-flavor">아직 발견하지 못한 아이템입니다</p>`;
  } else {
    const canCraft = item.count >= CRAFT_COST && isCraftable(item) && !item.locked;
    const craftLabel = !isCraftable(item) ? (item.rarity === 'mythic' ? '최고 등급' : '합성 불가')
      : item.locked ? '🔒 잠김' : `⚒ 합성 (${CRAFT_COST}개 → 1개)`;
    const lines = [
      `<span>보유</span><strong>${formatGold(item.count)}개</strong>`,
      `<span>분당 수입</span><strong>+${formatGold(item.incomePerMinute || 0)}G</strong>`,
    ];
    if (item.effect) lines.push(`<span>효과</span><strong>${escapeHtml(item.effect.now || item.effect.per)}</strong>`);
    tip.innerHTML = `
      <div class="tip-head">
        <span class="tip-name ${item.rarity}">${escapeHtml(item.name)}</span>
        <span class="tip-rarity ${item.rarity}">${RARITY_LABEL[item.rarity] || ''}</span>
      </div>
      <div class="tip-stars">${renderStars(item.stars, item.maxStars)}${item.nextStarAt ? `<small> 다음 ★ ${formatGold(item.count)}/${formatGold(item.nextStarAt)}</small>` : ''}</div>
      <div class="tip-lines">${lines.map(l => `<div>${l}</div>`).join('')}</div>
      ${item.effect ? `<p class="tip-sub">1개당 ${escapeHtml(item.effect.per)} · 최대 ${item.effect.maxCount}개까지 겹침</p>` : ''}
      <p class="tip-flavor">${escapeHtml(item.flavor || '')}</p>
      <div class="tip-actions">
        <button class="tip-lock" data-tip-lock="${item.locked ? 'off' : 'on'}">${item.locked ? '🔓 잠금 해제' : '🔒 잠금'}</button>
        <button class="tip-craft" data-tip-craft ${canCraft ? '' : 'disabled'}>${craftLabel}</button>
      </div>`;
  }
  // 칸 기준으로 위치 잡기 (가방 화면 기준 좌표)
  tip.classList.remove('hidden', 'below');
  const host = tip.offsetParent || document.body;
  const hostRect = host.getBoundingClientRect();
  const r = slot.getBoundingClientRect();
  const tipW = tip.offsetWidth;
  const tipH = tip.offsetHeight;
  let left = r.left + r.width / 2 - tipW / 2 - hostRect.left;
  left = Math.max(4, Math.min(left, hostRect.width - tipW - 4));
  let top = r.top - hostRect.top - tipH - 8;
  if (r.top - tipH - 8 < 60) { top = r.bottom - hostRect.top + 8; tip.classList.add('below'); }
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.style.setProperty('--arrow-x', `${r.left + r.width / 2 - hostRect.left - left}px`);
}
function hideItemTip(){
  openTipKey = null;
  document.getElementById('itemTip').classList.add('hidden');
  document.querySelectorAll('#runInventoryGrid .inv-slot.selected').forEach(el => el.classList.remove('selected'));
}
document.getElementById('runInventoryGrid').addEventListener('click', (e) => {
  const slot = e.target.closest('[data-slot]');
  if (!slot) return;
  if (openTipKey === slot.dataset.slot) hideItemTip();
  else showItemTip(slot.dataset.slot);
});
document.getElementById('itemTip').addEventListener('click', (e) => {
  const key = openTipKey;
  if (!key) return;
  const lockBtn = e.target.closest('[data-tip-lock]');
  const craftBtn = e.target.closest('[data-tip-craft]');
  if (lockBtn) toggleItemLock(key, lockBtn.dataset.tipLock === 'on', lockBtn);
  if (craftBtn) craftItem(key, craftBtn);
});
// 툴팁 바깥을 누르면 닫기
document.addEventListener('click', (e) => {
  if (!openTipKey) return;
  if (e.target.closest('#itemTip') || e.target.closest('#runInventoryGrid [data-slot]')) return;
  hideItemTip();
});
window.addEventListener('resize', () => { if (openTipKey) showItemTip(openTipKey); });

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

// 강화 가격 버튼: '장인의 손'이 걸려 있으면 원래 가격에 줄을 긋고 할인가(또는 무료)를 보여줍니다
function upgradePriceHtml(u, isMax){
  if (isMax) return 'MAX';
  if (u.baseCost && u.cost < u.baseCost) {
    return `<s class="price-was">${formatGold(u.baseCost)}G</s><span>${u.cost === 0 ? '무료' : `${formatGold(u.cost)}G`}</span>`;
  }
  return `${formatGold(u.cost)}G`;
}
function renderUpgradeScreen(){
  if (!lastStatus || !lastStatus.upgrades) return;
  renderEnhancePanel();

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
      <button class="shop-btn${!isMax && u.cost < u.baseCost ? ' skill-sale' : ''}" data-upgrade="${u.key}" data-cost="${isMax ? '' : u.cost}" ${isMax ? 'disabled' : ''}>${upgradePriceHtml(u, isMax)}</button>
    `;
    upgradeList.appendChild(row);
  });
  if (lastStatus.upgradeDiscountPercent > 0) {
    upgradeList.insertAdjacentHTML('afterbegin', `<p class="discount-note">🔨 신화 효과로 강화 비용 -${lastStatus.upgradeDiscountPercent}% 적용 중</p>`);
  }
  // 신화 스킬 '장인의 손': 다음 강화 1회 할인·무료 (수집가의 연구 제외)
  const skillSale = lastStatus.skills && lastStatus.skills.active && lastStatus.skills.active.upgradeDiscount;
  if (skillSale > 0) {
    upgradeList.insertAdjacentHTML('afterbegin', `<p class="discount-note skill-note">✨ 장인의 손: 다음 강화 1회 ${skillSale >= 100 ? '<strong>무료</strong>' : `<strong>-${skillSale}%</strong>`} · 하나 사면 사라집니다 (수집가의 연구 제외)</p>`);
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
    // 강화는 바뀐 목록이 응답에 같이 와서 바로 다시 그립니다 (연타해도 요청이 클릭당 1번)
    if (res.ok && data.upgrades && lastStatus) {
      lastStatus.upgrades = data.upgrades;
      if (typeof data.totalTreasure === 'number') lastStatus.totalTreasure = data.totalTreasure;
      renderUpgradeScreen();
    }
  } catch (err) {
    showUpgradeResult('서버에 연결할 수 없습니다.', true);
  } finally {
    delete btn.dataset.busy;
    scheduleShopRefresh();
  }
}
// 상점 버튼을 연달아 누르면 상태 전체 새로고침은 마지막 클릭 뒤 한 번만 합니다
let shopRefreshTimer = null;
function scheduleShopRefresh(){
  clearTimeout(shopRefreshTimer);
  shopRefreshTimer = setTimeout(refreshStatus, 700);
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
// 상자 가격 설명: 가격은 분당 수입에 비례 → 수입이 오를수록(아이템이 늘수록) 비싸집니다.
function renderBoxPriceHelp(){
  const p = cachedBoxPricing;
  document.getElementById('boxPriceNow').textContent = `지금 1개 ${formatGold(boxPriceAt(0))}G`;
  const rows = [];
  if (p) {
    rows.push(['기준', `분당 수입 ${formatGold(p.refIncome)}G까지 최소 가격`]);
    rows.push(['내 분당 수입', `${formatGold(p.income)}G`]);
    rows.push(['최소 가격 (할인 전)', `${formatGold(p.minPrice)}G`]);
    if (p.discountPercent > 0) rows.push(['🏷 할인 (아이템 효과·오늘의 규칙)', `-${p.discountPercent}%`]);
    const ten = boxPurchaseCost(10);
    rows.push(['10개 한 번에', `${formatGold(ten)}G (개당 평균 ${formatGold(Math.round(ten / 10))}G)`]);
  }
  document.getElementById('boxPriceList').innerHTML =
    rows.map(([k, v]) => `<li><span>${escapeHtml(k)}</span><span class="golden-chance">${escapeHtml(v)}</span></li>`).join('');
  document.getElementById('boxPriceNote').textContent =
    `상자 가격은 분당 수입에 따라 오르지만 수입보다 완만하게 오릅니다(수입 10배 → 가격 약 ${Math.round(Math.pow(10, p ? p.exponent : 0.75) * 10) / 10}배). 성장할수록 같은 시간에 더 많은 상자를 살 수 있습니다. `
    + '여러 개를 한 번에 사면 뒤의 상자일수록 조금씩 비싸집니다(앞 상자로 오를 수입만큼). '
    + '자동 개봉 중에는 수입이 계속 올라 가격도 수시로 바뀝니다. 충전된 상자는 공짜이니 먼저 여는 것이 이득!';
}
document.getElementById('boxPriceHelpBtn').addEventListener('click', () => {
  renderBoxPriceHelp();
  document.getElementById('boxPriceOverlay').classList.add('show');
});
document.getElementById('boxPriceCloseBtn').addEventListener('click', () => {
  document.getElementById('boxPriceOverlay').classList.remove('show');
});
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
// 받을 미션·업적 보상 수: 홈 탭 아이콘에 점으로 표시 (미션은 홈에서 받음)
function renderAchievementBadge(count){
  const homeTab = document.querySelector('#tabBar [data-tab="home"]');
  let badge = homeTab.querySelector('.nav-badge');
  if (!badge) { badge = document.createElement('span'); badge.className = 'nav-badge hidden'; homeTab.appendChild(badge); }
  badge.textContent = count > 0 ? count : '';
  badge.classList.toggle('hidden', !(count > 0));
}

// 홈의 "오늘의 미션 · 업적" 접이식 칸: 접혀 있을 때는 받을 보상 수만, 펴면 목록 전체
let homeMissionsOpen = false;
function renderHomeMissions(){
  const c = lastStatus && lastStatus.collection;
  const claimable = (lastStatus && lastStatus.claimableAchievements || 0) + (c ? c.missions.claimable : 0);
  const summary = document.getElementById('homeMissionsSummary');
  if (claimable > 0) summary.innerHTML = `<span class="home-missions-claim">🎁 받을 보상 ${claimable}</span>`;
  else if (c) {
    const done = c.missions.list.filter(m => m.claimed).length;
    summary.textContent = `오늘 ${done}/${c.missions.list.length}`;
  } else summary.textContent = '';
  document.getElementById('homeMissions').classList.toggle('has-claim', claimable > 0);
  if (homeMissionsOpen) renderAchievements();
}
document.getElementById('homeMissionsToggle').addEventListener('click', function(){
  homeMissionsOpen = !homeMissionsOpen;
  this.setAttribute('aria-expanded', String(homeMissionsOpen));
  document.getElementById('homeMissions').classList.toggle('open', homeMissionsOpen);
  document.getElementById('homeMissionsBody').classList.toggle('hidden', !homeMissionsOpen);
  if (homeMissionsOpen) { document.getElementById('achievementResult').style.display = 'none'; renderAchievements(); }
});

const STAT_UNIT = { boxes: '개', crafts: '번', legendary: '개', mythic: '개', golden: '번', bestIncome: 'G/분', rebirths: '번' };

function renderAchievements(){
  if (!lastStatus || !lastStatus.achievements) return;
  renderMissions();
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
// loading: 목록은 'lazy'(화면에 보일 때 불러옴), 바로 보여줄 팝업은 'eager'
function itemIconHtml(key, cls = 'item-icon', unknown = false, loading = 'lazy'){
  return `<img class="${cls}${unknown ? ' unknown' : ''}" src="${iconSrc(key)}" alt="" loading="${loading}" decoding="async" draggable="false">`;
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
      ? '기록모드 초기화! 모두 같은 출발선에서 이번 시즌 랭킹에 도전하십시오. (지난 시즌 기록은 랭킹에서 확인 가능)'
        + (seasonChange && seasonChange.convertedShards
          ? ` 남은 환생 포인트 ${seasonChange.leftoverPoints}개는 수집모드 신화 조각 💎${seasonChange.convertedShards}개로 바뀌었습니다.`
          : '')
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

    lastCodex = data;
    renderShardBar();
    renderSetPanel(data);
    groupsEl.innerHTML = data.groups.map(g => {
      const have = g.items.filter(i => i.obtained).length;
      const when = g.isCurrent
        ? `<span class="codex-when now">오늘 등장 중 · 교체까지 ${formatRemaining(new Date(data.dayEndsAt) - adjustedNow())}</span>`
        : `<span class="codex-when">${g.daysUntil === 1 ? '내일' : `${g.daysUntil}일 뒤`} · ${formatSeasonDate(g.nextStartsAt)} 오전 9시 등장</span>`;
      const cards = g.items.map(i => `
        <div class="codex-card ${i.obtained ? 'have' : ''} ${i.awaken ? `awaken-${i.awaken}` : ''}" ${i.obtained ? `data-awaken-key="${i.key}"` : ''} title="${escapeHtml(i.obtained ? `${i.flavor} (${new Date(i.firstObtainedAt).toLocaleDateString()} 획득)` : '아직 얻지 못한 신화')}">
          <span class="tier-badge">${'Ⅰ Ⅱ Ⅲ Ⅳ'.split(' ')[i.tier - 1]}</span>
          ${i.awaken ? `<span class="awaken-badge">★${i.awaken}</span>` : ''}
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
// 수집모드 성장: 오늘의 미션 · 신화 조각(분해·상점) · 세트 효과 · 각성
// -------------------------------
let lastCodex = null;
function collectionPost(path, body){
  return authFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(async res => ({ ok: res.ok, data: await res.json() }));
}

function renderMissions(){
  const box = document.getElementById('missionBox');
  const c = lastStatus && lastStatus.collection;
  if (!c) { box.innerHTML = ''; return; }
  const m = c.missions;
  const rows = m.list.map(x => {
    const pct = Math.min(100, x.progress / x.goal * 100);
    const action = x.claimable
      ? `<button class="shop-btn achievement-btn" data-mission="${x.key}">받기</button>`
      : `<span class="achievement-state">${x.claimed ? '✔ 완료' : `${x.progress}/${x.goal}`}</span>`;
    return `<div class="achievement-row ${x.claimable ? 'claimable' : ''} ${x.claimed ? 'done' : ''}">
      <span class="achievement-emoji">${x.emoji}</span>
      <div class="achievement-info">
        <div class="achievement-title">${escapeHtml(x.text)}</div>
        <div class="achievement-goal">보상 💎 ${x.shards}</div>
        <div class="time-bar-wrap"><div class="time-bar-fill" style="width:${pct}%"></div></div>
      </div>${action}</div>`;
  }).join('');
  const all = m.allClear;
  const allAction = all.claimable
    ? `<button class="shop-btn achievement-btn" data-mission="allClear">받기</button>`
    : `<span class="achievement-state">${all.claimed ? '✔ 완료' : '보너스'}</span>`;
  box.innerHTML = `
    <div class="mission-head"><span>📅 오늘의 미션</span><span class="mission-shards">💎 ${formatGold(c.shards)}</span></div>
    <p class="mission-sub">교체까지 ${formatRemaining(new Date(m.resetsAt) - adjustedNow())} · 자리 비운 동안의 자동 개봉·합성은 집계되지 않음</p>
    ${rows}
    <div class="achievement-row mission-all ${all.claimable ? 'claimable' : ''} ${all.claimed ? 'done' : ''}">
      <span class="achievement-emoji">🏆</span>
      <div class="achievement-info"><div class="achievement-title">오늘의 미션 모두 완료</div><div class="achievement-goal">보상 💎 ${all.shards}</div></div>
      ${allAction}</div>`;
}
document.getElementById('missionBox').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-mission]');
  if (!btn) return;
  btn.disabled = true;
  const { ok, data } = await collectionPost('/api/box/mission', { key: btn.dataset.mission });
  showToast(data.message, !ok);
  await refreshStatus();
  renderAchievements();
});

function renderShardBar(){
  const bar = document.getElementById('shardBar');
  const c = lastStatus && lastStatus.collection;
  if (!c) { bar.innerHTML = ''; return; }
  bar.innerHTML = `
    <div class="shard-top"><span>💎 신화 조각 <strong>${formatGold(c.shards)}</strong></span><span class="shard-stars">각성 ★${c.stars}</span></div>
    <div class="shard-actions">
      <button class="shard-btn" id="dismantleBtn" ${c.dismantle.count ? '' : 'disabled'}>🔨 중복 분해${c.dismantle.count ? ` (${c.dismantle.count}개 → 💎${c.dismantle.shards})` : ''}</button>
      <button class="shard-btn" id="shardShopBtn" ${c.shards >= c.choiceBoxPrice ? '' : 'disabled'}>🎁 선택 상자 (💎${c.choiceBoxPrice})</button>
    </div>
    <p class="shard-hint">신화는 3개까지 효과가 겹칩니다. 넘는 중복은 분해해서 조각으로 · 조각은 미션 보상으로도 획득</p>`;
}
document.getElementById('shardBar').addEventListener('click', async (e) => {
  const btn = e.target.closest('#dismantleBtn, #shardShopBtn');
  if (!btn || btn.disabled) return;
  if (btn.id === 'dismantleBtn') {
    const d = lastStatus.collection.dismantle;
    const ok = await askConfirm({
      title: '🔨 중복 신화 분해',
      text: `3개를 넘는 신화 ${d.count}개 → 💎 ${formatGold(d.shards)}\n효과는 그대로 유지되고, 분해한 만큼 수입만 조금 줄어듭니다.`,
      ok: '분해',
    });
    if (!ok) return;
  }
  btn.disabled = true;
  const { ok, data } = btn.id === 'dismantleBtn'
    ? await collectionPost('/api/box/dismantle')
    : await collectionPost('/api/box/shard-shop', { item: 'choiceBox' });
  showToast(data.message, !ok);
  await refreshStatus();
  renderShardBar();
});

function renderSetPanel(data){
  const panel = document.getElementById('setPanel');
  const sets = data.sets;
  if (!sets) { panel.innerHTML = ''; return; }
  const motifDone = sets.motifs.filter(m => m.complete).length;
  const themeChips = sets.themes.map(t => `
    <div class="set-chip ${t.complete ? 'done' : ''}">
      <span class="set-chip-name">${t.emoji} ${escapeHtml(t.name)} <small>${t.have}/${t.total}</small></span>
      <span class="set-chip-bonus">${escapeHtml(t.bonusText)}</span>
    </div>`).join('');
  const motifChips = sets.motifs.map(m => `<span class="motif-chip ${m.complete ? 'done' : ''}" title="${escapeHtml(m.name)}">${m.emoji}<small>${m.have}/${m.total}</small></span>`).join('');
  const milestones = (data.milestones || []).map(m => `
    <div class="milestone ${m.reached ? 'done' : ''}">
      <span class="milestone-count">${m.count}종</span>
      <span class="milestone-text">${m.emoji} ${escapeHtml(m.text)}</span>
      <span class="milestone-state">${m.reached ? '✔' : `${Math.max(0, m.count - data.obtained)}종 남음`}</span>
    </div>`).join('');
  panel.innerHTML = `
    <h3 class="dex-heading">🏁 도감 마일스톤</h3>
    <div class="milestone-list">${milestones}</div>
    <h3 class="dex-heading">🧩 세트 효과</h3>
    <div class="set-section">
      <p class="set-title">테마 세트 <small>같은 색 테마를 모두 모으면 보너스</small></p>
      <div class="set-chips">${themeChips}</div>
      <p class="set-title">모양 세트 <strong>${motifDone}/${sets.motifs.length}</strong> <small>같은 모양 4종 완성마다 전체 수입 +${sets.motifBonusPercent}%</small></p>
      <div class="motif-chips">${motifChips}</div>
    </div>`;
}

// 각성 창
let awakenKey = null;
function openAwaken(key){
  if (!lastCodex) return;
  const item = lastCodex.groups.flatMap(g => g.items).find(i => i.key === key);
  if (!item) return;
  awakenKey = key;
  const level = item.awaken || 0;
  const max = lastCodex.awakenMax;
  const shards = lastStatus && lastStatus.collection ? lastStatus.collection.shards : lastCodex.shards;
  document.getElementById('awakenIcon').innerHTML = itemIconHtml(key, 'awaken-icon');
  document.getElementById('awakenName').textContent = item.name;
  document.getElementById('awakenStars').innerHTML = `${'★'.repeat(level)}<span class="off">${'★'.repeat(max - level)}</span>`;
  document.getElementById('awakenEffect').textContent = `${item.effect.per} · 각성 ★마다 전체 수입 +${lastCodex.awakenIncomePercent}%`;
  const btn = document.getElementById('awakenBtn');
  if (level >= max) {
    document.getElementById('awakenCost').textContent = '최고 단계 달성!';
    btn.disabled = true;
  } else {
    const cost = lastCodex.awakenCosts[level];
    document.getElementById('awakenCost').textContent = `★${level + 1} 각성: 💎 ${cost} (보유 ${formatGold(shards)})`;
    btn.disabled = shards < cost;
  }
  document.getElementById('awakenOverlay').classList.add('show');
}
document.getElementById('codexGroups').addEventListener('click', (e) => {
  const card = e.target.closest('[data-awaken-key]');
  if (card) openAwaken(card.dataset.awakenKey);
});
document.getElementById('awakenCloseBtn').addEventListener('click', () => document.getElementById('awakenOverlay').classList.remove('show'));
document.getElementById('awakenBtn').addEventListener('click', async function(){
  if (!awakenKey) return;
  this.disabled = true;
  const { ok, data } = await collectionPost('/api/box/awaken', { key: awakenKey });
  showToast(data.message, !ok);
  await refreshStatus();
  await loadCodex();
  openAwaken(awakenKey);
});

// -------------------------------
// 신화 스킬 (홈 화면 스킬 줄)
// 효과 종류별 신화를 가지면 열리고, 누르면 사용 → 대기시간. 높은 단계 신화일수록 강함.
// -------------------------------
let cachedSkills = [];
let skillReadyAt = {};
let skillBuffEnds = {};
const TIER_MARKS = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ'];
function applySkills(skills){
  if (!skills) return;
  cachedSkills = skills.list;
  const now = adjustedNow().getTime();
  skillReadyAt = Object.fromEntries(skills.list.map(s => [s.type, now + s.remainingMs]));
  skillBuffEnds = {
    luck: skills.active.luck ? { value: skills.active.luck.value, until: new Date(skills.active.luck.until).getTime() } : null,
    boxDiscount: skills.active.boxDiscount ? { value: skills.active.boxDiscount.value, until: new Date(skills.active.boxDiscount.until).getTime() } : null,
    upgradeDiscount: skills.active.upgradeDiscount,
  };
  document.getElementById('skillRow').innerHTML = skills.list.map(s => `
    <button class="skill-btn ${s.unlocked ? '' : 'locked'}" data-skill="${s.type}" aria-label="${escapeHtml(s.name)}">
      <span class="skill-emoji">${s.unlocked ? s.emoji : '🔒'}</span>
      ${s.unlocked ? `<span class="skill-tier">${TIER_MARKS[s.tier - 1]}</span>` : ''}
      <span class="skill-cd" data-skill-cd="${s.type}"></span>
    </button>`).join('');
  renderSkillTimers();
}
function renderSkillTimers(){
  if (!cachedSkills.length) return;
  const now = adjustedNow().getTime();
  for (const s of cachedSkills) {
    const el = document.querySelector(`[data-skill-cd="${s.type}"]`);
    if (!el) continue;
    const left = s.unlocked ? Math.max(0, skillReadyAt[s.type] - now) : 0;
    el.textContent = left <= 0 ? ''
      : left >= 3600000 ? `${Math.floor(left / 3600000)}h${String(Math.floor(left % 3600000 / 60000)).padStart(2, '0')}`
      : `${Math.ceil(left / 60000)}분`;
    el.parentElement.classList.toggle('cooling', left > 0);
    el.parentElement.classList.toggle('ready', s.unlocked && left === 0);
  }
  const buffs = [];
  const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms % 60000 / 1000)).padStart(2, '0')}`;
  if (skillBuffEnds.luck && skillBuffEnds.luck.until > now) buffs.push(`🍀 +${skillBuffEnds.luck.value}% ${clock(skillBuffEnds.luck.until - now)}`);
  if (skillBuffEnds.boxDiscount && skillBuffEnds.boxDiscount.until > now) buffs.push(`🏷️ -${skillBuffEnds.boxDiscount.value}% ${clock(skillBuffEnds.boxDiscount.until - now)}`);
  if (skillBuffEnds.upgradeDiscount) buffs.push(skillBuffEnds.upgradeDiscount >= 100 ? '🔨 다음 강화 무료' : `🔨 다음 강화 -${skillBuffEnds.upgradeDiscount}%`);
  document.getElementById('skillBuffs').textContent = buffs.join(' · ');
}
document.getElementById('skillRow').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-skill]');
  if (!btn) return;
  const s = cachedSkills.find(x => x.type === btn.dataset.skill);
  if (!s) return;
  if (!s.unlocked) {
    askConfirm({ title: `🔒 ${s.name}`, text: `${s.desc}\n이 종류의 신화를 하나라도 가지면 열립니다.\n높은 단계(Ⅰ~Ⅳ) 신화일수록 강해집니다.`, ok: '확인', cancel: null });
    return;
  }
  const left = Math.max(0, skillReadyAt[s.type] - adjustedNow().getTime());
  if (left > 0) {
    showToast(`${s.emoji} ${s.name}: ${Math.ceil(left / 60000)}분 뒤 사용 가능`);
    return;
  }
  const hours = Math.floor(s.cooldownMs / 3600000);
  const mins = Math.round(s.cooldownMs % 3600000 / 60000);
  const cdText = `${hours ? `${hours}시간` : ''}${hours && mins ? ' ' : ''}${mins ? `${mins}분` : ''}`;
  const ok = await askConfirm({
    title: `${s.emoji} ${s.name} ${TIER_MARKS[s.tier - 1]}`,
    text: `${s.desc}\n사용 후 대기시간 ${cdText}${s.stars ? ` (각성 ★${s.stars} 단축)` : ''}`,
    ok: '사용',
  });
  if (!ok) return;
  const { ok: done, data } = await collectionPost('/api/box/skill', { type: s.type });
  showToast(data.message, !done);
  if (done && data.totalTreasure != null) setGold(data.totalTreasure);
  await refreshStatus();
});

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
    : `<button class="link-btn" data-gb-report="${e.id}">신고</button><button class="link-btn" data-gb-block="${e.authorId}" data-gb-name="${escapeHtml(e.nickname)}">차단</button>`;
  return `
    <div class="guestbook-entry${e.isMine ? ' mine' : ''}">
      <div class="guestbook-meta"><strong>${title}${escapeHtml(e.nickname)}${transcendBadgeHtml(e.title && e.title.transcend)}</strong><small>${formatTimeAgo(e.createdAt)}</small>${action}</div>
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
    else listEl.innerHTML = html || '<p class="guestbook-empty">아직 글이 없습니다. 첫 인사를 남겨 보십시오!</p>';
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
  const block = e.target.closest('[data-gb-block]');
  if (block) { blockUser(Number(block.dataset.gbBlock), block.dataset.gbName); return; }
  const del = e.target.closest('[data-gb-delete]');
  const rep = e.target.closest('[data-gb-report]');
  if (!del && !rep) return;
  const ok = del
    ? await askConfirm({ title: '글 삭제', text: '삭제한 글은 되돌릴 수 없습니다.', ok: '삭제', danger: true })
    : await askConfirm({ title: '🚩 글 신고', text: '신고한 글은 바로 숨겨지고, 여러 명이 신고하면 모두에게 숨겨집니다.', ok: '신고', danger: true });
  if (!ok) return;
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
  document.getElementById('choicePicked').textContent = '받을 신화를 선택하십시오';
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
// 게임 안 확인창: askConfirm({ title, text, ok, cancel, danger }) → 확인하면 true
// (브라우저 기본 confirm/alert 창은 쓰지 않습니다. cancel: null 이면 확인 버튼만)
// -------------------------------
const confirmOverlay = document.getElementById('confirmOverlay');
let confirmResolve = null;
function askConfirm({ title, text, ok = '확인', cancel = '취소', danger = false }){
  if (confirmResolve) confirmResolve(false);
  document.getElementById('confirmTitle').textContent = title || '';
  document.getElementById('confirmText').textContent = text || '';
  const okBtn = document.getElementById('confirmOkBtn');
  const cancelBtn = document.getElementById('confirmCancelBtn');
  okBtn.textContent = ok;
  okBtn.classList.toggle('danger', danger);
  cancelBtn.textContent = cancel || '';
  cancelBtn.classList.toggle('hidden', !cancel);
  confirmOverlay.classList.add('show');
  return new Promise(resolve => { confirmResolve = resolve; });
}
function closeConfirm(result){
  confirmOverlay.classList.remove('show');
  if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(result); }
}
document.getElementById('confirmOkBtn').addEventListener('click', () => closeConfirm(true));
document.getElementById('confirmCancelBtn').addEventListener('click', () => closeConfirm(false));
confirmOverlay.addEventListener('click', (e) => { if (e.target === confirmOverlay) closeConfirm(false); });

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
  choiceOverlay: 'choiceCloseBtn', deleteAccountOverlay: 'deleteAccountCancelBtn', boxPriceOverlay: 'boxPriceCloseBtn',
  awakenOverlay: 'awakenCloseBtn', userActionOverlay: 'userActionCloseBtn', blockListOverlay: 'blockListCloseBtn',
  emailOverlay: 'emailCloseBtn',
};
function armBackGuard(){
  if (!history.state || !history.state.boxGameGuard) history.pushState({ boxGameGuard: true }, '');
}
window.addEventListener('popstate', () => {
  if (!document.body.classList.contains('in-game')) return; // 로그인 화면에서는 기본 동작(종료)
  if (exitOverlay.classList.contains('show')) return; // 종료 창에서 한 번 더 누름 → 이미 앱 밖으로 나가는 중
  if (!guideLayer.classList.contains('hidden')) { endGuide(); armBackGuard(); return; }
  if (confirmOverlay.classList.contains('show')) { closeConfirm(false); armBackGuard(); return; }
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
  { target: '#skillBar', title: '✨ 신화 스킬', text: '신화를 모으면 종류별 스킬이 열립니다. 누르면 바로 사용, 쓰고 나면 대기시간. 높은 단계 신화일수록 강해집니다.' },
  { target: '#pityBox', title: '🌸 신화 천장', text: '상자를 열 때마다 게이지가 찹니다. 가득 차면 아직 없는 신화가 확정으로 나옵니다.' },
  { target: '#seasonBanner', title: '🗓 오늘의 신화', text: '매일 오전 9시에 신화 10종이 바뀝니다. 오늘 놓친 신화는 10일 뒤 다시 등장합니다.' },
  { target: '#tabBar [data-tab="bag"]', title: '🎒 가방 · 합성', text: '같은 아이템 3개를 모으면 한 등급 위로 합성할 수 있습니다. 등급이 높을수록 골드를 더 많이 법니다.' },
  { target: '#tabBar [data-tab="upgrade"]', title: '🛠 강화', text: '골드로 수입·충전 속도·창고·행운을 올립니다. 자동 개봉을 사 두면 자리를 비운 동안에도 상자가 열립니다.' },
  { target: '#modeBadge', title: '🎮 모드 전환', text: '기록모드와 수집모드는 따로 저장됩니다. 여기를 눌러 언제든 오갈 수 있습니다. 즐거운 수집 되십시오!' },
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
  // 스크롤이 길면 350ms 안에 안 끝나서, 스크롤 중에는 scroll 이벤트로 계속 따라가고 끝난 뒤 한 번 더 맞춥니다.
  placeGuide();
  setTimeout(placeGuide, 350);
  setTimeout(placeGuide, 800);
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
let guideScrollFrame = 0;
window.addEventListener('scroll', () => {
  if (guideLayer.classList.contains('hidden') || guideScrollFrame) return;
  guideScrollFrame = requestAnimationFrame(() => { guideScrollFrame = 0; placeGuide(); });
}, { passive: true });
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
  renderEmailState();
  settingsOverlay.classList.add('show');
});
document.getElementById('settingsCloseBtn').addEventListener('click', () => settingsOverlay.classList.remove('show'));
// 설정 안의 버튼을 누르면 창을 닫고 진행합니다(확인창·계정 삭제 창이 그 위에 뜨도록).
['installAppBtn', 'resetRunBtn', 'logoutBtn', 'openDeleteAccountBtn', 'openBlockListBtn', 'openEmailVerifyBtn', 'openEmailChangeBtn'].forEach(id =>
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
  showToast('📲 앱 설치 완료! 홈 화면에서 실행하십시오');
});
installAppBtn.addEventListener('click', async () => {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice.catch(() => null);
    deferredInstallPrompt = null; // 한 번 쓴 설치 창은 다시 쓸 수 없습니다.
    updateInstallButton();
  } else if (isIosSafari()) {
    askConfirm({ title: '📲 홈 화면에 추가', text: 'Safari 아래쪽 공유 버튼(□↑)\n→ "홈 화면에 추가"', ok: '확인', cancel: null });
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
  const sure = await askConfirm({ title: '⚠️ 계정 삭제', text: '모든 기록이 즉시 삭제되고 복구할 수 없습니다.', ok: '영구 삭제', danger: true });
  if (!sure) return;
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
    showToast(data.message);
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
      <span class="rank-name">${titleHtml}${escapeHtml(nickname)}${transcendBadgeHtml(title && title.transcend)}${isMe ? ' (나)' : ''}</span>
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
        ? '아직 신화를 모은 사람이 없습니다.<br>수집모드에서 첫 신화를 찾아보십시오!'
        : '아직 환생 기록이 없습니다.<br>첫 기록의 주인공이 되어 보십시오!'}</p>`;
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

// -------------------------------
// 초월 배지: 이름 옆 ✦N (초월 횟수가 많을수록 화려하게 · game/transcend.js 의 TRANSCEND_TIERS 와 같은 기준)
// -------------------------------
const TRANSCEND_TIERS = [1, 3, 5, 10, 20];
function transcendTier(count){
  let tier = 0;
  TRANSCEND_TIERS.forEach((min, i) => { if (count >= min) tier = i + 1; });
  return tier;
}
function transcendBadgeHtml(count){
  const n = Number(count) || 0;
  if (n <= 0) return '';
  return `<span class="tr-badge tr-${transcendTier(n)}" title="초월 ${n}회">✦${n}</span>`;
}

// -------------------------------
// (광장과 방명록은 아래 탭에서 따로 엽니다)
// -------------------------------

// -------------------------------
// 광장: 넓은 지형 위를 상자 캐릭터로 돌아다니며 채팅 (서버 lib/lobby.js 와 WebSocket으로 주고받음)
// - 내 상자는 항상 화면 가운데, 지형(lobbyWorld)이 반대로 움직입니다. (카메라)
// - 위치는 0~1 비율. 지형 크기·걷는 속도는 서버와 같아야 합니다.
// - 이동은 CSS transform 전환으로만 (배치 재계산 없음). 내 이동과 카메라 이동은 같은 시간·같은 속도라
//   걷는 동안에도 내 상자가 가운데에 머뭅니다.
// -------------------------------
const lobbyStage = document.getElementById('lobbyStage');
const lobbyLogEl = document.getElementById('lobbyLog');
const lobbyStatusEl = document.getElementById('lobbyStatus');
let LOBBY_WORLD_W = 1500;
let LOBBY_WORLD_H = 1100;
let LOBBY_WALK_PX_PER_SEC = 160;
const LOBBY_BUBBLE_MS = 5000;
const LOBBY_TAP_RANGE_PX = 120;   // 이 거리 안이면 "톡톡!" (서버 판정은 조금 더 넉넉함) + 초월 사거리 혜택
let lobbyPerks = { speedPct: 0, rangePx: 0, damage: 1, raidRangeBonusPx: 60 };
const lobbyTapRange = (isRaid) => LOBBY_TAP_RANGE_PX + lobbyPerks.rangePx + (isRaid ? lobbyPerks.raidRangeBonusPx : 0);
const LOBBY_WALK = { minX: 0.05, maxX: 0.95, minY: 0.07, maxY: 0.95 };
let lobbyWs = null;
let lobbyWanted = false;
let lobbyMe = null;
let lobbyRetry = 0;
let lobbyRetryTimer = null;
const lobbyPlayers = new Map(); // id → { p: { x, y }, el, motion }
let lobbyWorld = null;
let lobbyGolden = null;        // { id, el, motion, hp, maxHp }
let lobbyRaid = null;          // 거대 황금 상자 레이드 { id, el, motion, hp, maxHp, endsAt, party, myDmg }
let lobbyNearTimer = null;
let lobbyMarker = null;
let lobbyRoomNo = null;        // 지금 들어가 있는 방 (목록에서 대기 중이면 null)
let lobbyRoomList = [];

// 움직임 { x0, y0, x1, y1, t0, dur } 에서 지금 위치 (서버 posAt 과 같은 계산)
function lobbyPosAt(m, now = performance.now()){
  if (!m || !m.dur) return m ? { x: m.x1, y: m.y1 } : { x: 0.5, y: 0.5 };
  const k = Math.min(1, Math.max(0, (now - m.t0) / m.dur));
  return { x: m.x0 + (m.x1 - m.x0) * k, y: m.y0 + (m.y1 - m.y0) * k };
}
function lobbyDistPx(a, b){ return Math.hypot((a.x - b.x) * LOBBY_WORLD_W, (a.y - b.y) * LOBBY_WORLD_H); }

// ── 지형: 섬 · 길 · 가운데 분수 광장 · 연못 · 나무 · 꽃 (한 번만 그리는 정지 그림) ──
function buildLobbyWorld(){
  lobbyStage.innerHTML = '';
  const world = document.createElement('div');
  world.className = 'lobby-world';
  world.style.width = `${LOBBY_WORLD_W}px`;
  world.style.height = `${LOBBY_WORLD_H}px`;
  // 항상 같은 모양이 나오도록 고정 씨앗으로 흩뿌립니다
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const W = LOBBY_WORLD_W, H = LOBBY_WORLD_H;
  const cx = W / 2, cy = H * 0.55;
  const pond = { x: W * 0.22, y: H * 0.3, rx: 120, ry: 80 };
  const nearPath = (x, y) => Math.abs(x - cx) < 70 || Math.abs(y - cy) < 70
    || Math.hypot(x - cx, y - cy) < 190 || Math.hypot((x - pond.x) / (pond.rx + 40), (y - pond.y) / (pond.ry + 40)) < 1;
  const parts = [
    '<div class="lw-island"></div>',
    `<div class="lw-path lw-path-h" style="top:${cy - 34}px"></div>`,
    `<div class="lw-path lw-path-v" style="left:${cx - 34}px"></div>`,
    `<div class="lw-plaza" style="left:${cx - 150}px; top:${cy - 150}px"></div>`,
    `<div class="lw-deco lw-fountain" style="left:${cx}px; top:${cy}px">⛲</div>`,
    `<div class="lw-pond" style="left:${pond.x - pond.rx}px; top:${pond.y - pond.ry}px; width:${pond.rx * 2}px; height:${pond.ry * 2}px"></div>`,
    `<div class="lw-deco" style="left:${pond.x + 30}px; top:${pond.y - 10}px; font-size:26px">🦆</div>`,
    `<div class="lw-deco" style="left:${pond.x - 50}px; top:${pond.y + 20}px; font-size:22px">🪷</div>`,
    `<div class="lw-sign" style="left:${cx + 80}px; top:${cy - 190}px">🎪 상자 광장</div>`,
    `<div class="lw-deco" style="left:${W * 0.8}px; top:${H * 0.25}px; font-size:56px">🎡</div>`,
    `<div class="lw-deco" style="left:${W * 0.78}px; top:${H * 0.8}px; font-size:44px">⛺</div>`,
    `<div class="lw-deco" style="left:${W * 0.2}px; top:${H * 0.82}px; font-size:40px">🏕️</div>`,
  ];
  const trees = ['🌳', '🌲', '🌴', '🌳', '🌲'];
  const small = ['🌼', '🌷', '🍄', '🌸', '🪨', '🌿', '🌻'];
  for (let i = 0; i < 46; i++) {
    const x = 60 + rnd() * (W - 120), y = 70 + rnd() * (H - 140);
    if (nearPath(x, y)) continue;
    parts.push(`<div class="lw-deco lw-tree" style="left:${x.toFixed(0)}px; top:${y.toFixed(0)}px; font-size:${(34 + rnd() * 18).toFixed(0)}px">${trees[i % trees.length]}</div>`);
  }
  for (let i = 0; i < 60; i++) {
    const x = 50 + rnd() * (W - 100), y = 60 + rnd() * (H - 120);
    if (nearPath(x, y)) continue;
    parts.push(`<div class="lw-deco" style="left:${x.toFixed(0)}px; top:${y.toFixed(0)}px; font-size:${(14 + rnd() * 8).toFixed(0)}px">${small[i % small.length]}</div>`);
  }
  world.innerHTML = parts.join('');
  lobbyStage.appendChild(world);
  lobbyWorld = world;

  // 화면 가장자리 화살표: 황금 상자가 화면 밖에 있을 때 방향을 알려줌
  const arrow = document.createElement('div');
  arrow.className = 'lobby-golden-arrow hidden';
  arrow.id = 'lobbyGoldenArrow';
  arrow.innerHTML = '<span class="lga-icon">🎁</span><span class="lga-arrow">➤</span>';
  lobbyStage.appendChild(arrow);

  // 레이드 공용 체력바 (화면 위쪽 고정) · 결과창
  const hud = document.createElement('div');
  hud.className = 'lobby-raid-hud hidden';
  hud.id = 'lobbyRaidHud';
  hud.innerHTML = `
    <div class="lrh-top"><strong>🐉 거대 황금 상자</strong><span class="lrh-party"></span><span class="lrh-mine"></span><span class="lrh-time"></span></div>
    <div class="lrh-bar"><div class="lrh-fill"></div><span class="lrh-hp"></span></div>`;
  lobbyStage.appendChild(hud);
  const result = document.createElement('div');
  result.className = 'lobby-raid-result hidden';
  result.id = 'lobbyRaidResult';
  lobbyStage.appendChild(result);
  result.addEventListener('click', (e) => { e.stopPropagation(); result.classList.add('hidden'); });
}

// ── 카메라: 내 위치가 화면 가운데에 오도록 지형을 옮깁니다 ──
// 전체 화면 광장에서 위쪽 정보 층과 아래 채팅 층을 뺀 "보이는 가운데" 높이 (내 상자를 여기에 둠)
function lobbyFocusY(){
  const top = document.querySelector('#lobbyView .lobby-top');
  const chat = document.getElementById('lobbyChat');
  const h = lobbyStage.clientHeight;
  const visTop = top ? top.offsetTop + top.offsetHeight : 0;
  const visBottom = chat && chat.offsetParent ? chat.offsetTop : h;
  if (visBottom - visTop < 120) return h / 2;
  return (visTop + visBottom) / 2;
}
function lobbyCameraTo(x, y, durationMs){
  if (!lobbyWorld) return;
  const tx = lobbyStage.clientWidth / 2 - x * LOBBY_WORLD_W;
  const ty = lobbyFocusY() - y * LOBBY_WORLD_H;
  lobbyWorld.style.transitionDuration = `${durationMs}ms`;
  lobbyWorld.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
}
// 지금 화면에 보이는 카메라 중심 (비율)
function lobbyCameraCenter(){
  const me = lobbyPlayers.get(lobbyMe);
  return me ? lobbyPosAt(me.motion) : { x: 0.5, y: 0.5 };
}

function lobbyConnect(){
  lobbyWanted = true;
  if (lobbyWs || !authToken) return;
  clearTimeout(lobbyRetryTimer);
  lobbyStatusEl.textContent = lobbyRetry ? '다시 연결 중...' : '연결 중...';
  const ws = new WebSocket(`${API_BASE.replace(/^http/, 'ws')}/lobby?token=${encodeURIComponent(authToken)}`);
  lobbyWs = ws;
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    handleLobbyMessage(msg);
  };
  ws.onclose = (event) => {
    if (lobbyWs !== ws) return;
    lobbyWs = null;
    clearLobbyStage();
    if (!lobbyWanted) return;
    if (event.code === 4004) { lobbyStatusEl.textContent = '다른 창에서 광장에 들어갔습니다'; lobbyWanted = false; return; }
    if (event.code === 4003) { lobbyStatusEl.textContent = '광장이 가득 찼습니다 · 잠시 후 다시 시도합니다'; }
    else if (event.code === 4001) { lobbyStatusEl.textContent = '로그인이 필요합니다'; lobbyWanted = false; return; }
    else lobbyStatusEl.textContent = '연결이 끊겼습니다 · 다시 연결 중...';
    lobbyRetry++;
    lobbyRetryTimer = setTimeout(lobbyConnect, Math.min(15000, 1500 * 2 ** Math.min(lobbyRetry, 4)));
  };
}
function lobbyDisconnect(){
  lobbyWanted = false;
  lobbyRoomNo = null;
  lobbyRoomsBtn.classList.add('hidden');
  setLobbyRoomsOpen(false);
  lobbyStage.classList.remove('hidden');
  clearTimeout(lobbyRetryTimer);
  if (lobbyWs) { const ws = lobbyWs; lobbyWs = null; ws.close(1000); }
  clearLobbyStage();
}
function lobbySend(data){
  if (lobbyWs && lobbyWs.readyState === WebSocket.OPEN) lobbyWs.send(JSON.stringify(data));
}
// 앱을 내려두면 연결을 닫고, 다시 보면 이어 붙입니다.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (lobbyWs) { const keep = lobbyWanted; lobbyDisconnect(); lobbyWanted = keep; } }
  else if (lobbyWanted && currentTab === 'lobby') lobbyConnect();
});

function clearLobbyStage(){
  lobbyPlayers.forEach(entry => { clearTimeout(entry.bubbleTimer); clearTimeout(entry.walkTimer); });
  lobbyPlayers.clear();
  removeLobbyGolden();
  removeLobbyRaid();
  clearInterval(lobbyNearTimer);
  lobbyNearTimer = null;
  lobbyMarker = null;
  lobbyStage.innerHTML = '';
  lobbyWorld = null;
}
function updateLobbyCount(){
  if (!lobbyRoomNo) return;
  const info = lobbyRoomList.find(r => r.no === lobbyRoomNo);
  lobbyStatusEl.textContent = `🟢 ${lobbyRoomNo}번방 · ${lobbyPlayers.size}/${info ? info.max : '?'}명`;
}

// ── 방 목록 (1~9번방) ──
const lobbyRoomsEl = document.getElementById('lobbyRooms');
const lobbyRoomsBtn = document.getElementById('lobbyRoomsBtn');
function renderLobbyRooms(){
  const grid = document.getElementById('lobbyRoomsGrid');
  grid.innerHTML = lobbyRoomList.map(r => {
    const full = r.count >= r.max;
    const current = r.no === lobbyRoomNo;
    const level = full ? 'full' : r.count >= r.max * 0.7 ? 'busy' : r.count > 0 ? 'some' : 'empty';
    return `<button class="lobby-room ${level}${current ? ' current' : ''}" data-room="${r.no}" ${full && !current ? 'disabled' : ''}>
      <strong>${r.no}번방</strong>
      <span class="lr-count">${r.count}/${r.max}</span>
      <span class="lr-state">${current ? '지금 여기' : full ? '가득 참' : '들어가기'}</span>
      <span class="lr-bar"><span style="width:${Math.round(r.count / r.max * 100)}%"></span></span>
    </button>`;
  }).join('');
  const msg = document.getElementById('lobbyRoomsMsg');
  msg.textContent = lobbyRoomNo
    ? '다른 방으로 옮기면 그 방의 광장 한가운데에서 시작합니다'
    : '모든 방이 가득 찼습니다 · 자리가 나면 눌러서 들어갈 수 있습니다';
}
function setLobbyRoomsOpen(open){
  lobbyRoomsEl.classList.toggle('hidden', !open);
  lobbyRoomsBtn.setAttribute('aria-expanded', String(open));
  lobbyRoomsBtn.classList.toggle('active', open);
  if (open) renderLobbyRooms();
}
lobbyRoomsBtn.addEventListener('click', () => setLobbyRoomsOpen(lobbyRoomsEl.classList.contains('hidden')));
document.getElementById('lobbyRoomsGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-room]');
  if (!btn || btn.disabled) return;
  const no = Number(btn.dataset.room);
  if (no === lobbyRoomNo) { setLobbyRoomsOpen(false); return; }
  lobbyStatusEl.textContent = `${no}번방으로 가는 중...`;
  lobbySend({ t: 'room', no });
});

function handleLobbyMessage(msg){
  if (msg.t === 'rooms') {
    lobbyRoomList = msg.rooms;
    if (!lobbyRoomsEl.classList.contains('hidden')) renderLobbyRooms();
    updateLobbyCount();
  } else if (msg.t === 'allfull') {
    // 모든 방이 가득: 지형 대신 목록만 보여주고 기다림
    lobbyRetry = 0;
    lobbyRoomNo = null;
    clearLobbyStage();
    lobbyStage.classList.add('hidden');
    document.getElementById('lobbyView').classList.add('waiting');
    lobbyRoomsBtn.classList.add('hidden');
    lobbyStatusEl.textContent = '⏳ 모든 방이 가득 찼습니다';
    setLobbyRoomsOpen(true);
  } else if (msg.t === 'init') {
    lobbyRetry = 0;
    lobbyMe = msg.me;
    lobbyRoomNo = msg.room;
    lobbyStage.classList.remove('hidden');
    document.getElementById('lobbyView').classList.remove('waiting');
    lobbyRoomsBtn.classList.remove('hidden');
    setLobbyRoomsOpen(false);
    if (msg.world) { LOBBY_WORLD_W = msg.world.w; LOBBY_WORLD_H = msg.world.h; LOBBY_WALK_PX_PER_SEC = msg.world.speed; }
    clearLobbyStage();
    buildLobbyWorld();
    msg.players.forEach(addLobbyPlayer);
    const me = lobbyPlayers.get(lobbyMe);
    if (me) lobbyCameraTo(me.p.x, me.p.y, 0);
    requestAnimationFrame(relayoutLobby);
    lobbyLogEl.innerHTML = '';
    msg.chats.forEach(c => appendLobbyChat(c, false));
    if (msg.golden) addLobbyGolden(msg.golden);
    if (msg.perks) { lobbyPerks = msg.perks; renderLobbyPerks(); }
    if (msg.raid) addLobbyRaid(msg.raid);
    lobbyNearTimer = setInterval(updateLobbyGoldenHint, 250);
    updateLobbyCount();
  } else if (msg.t === 'join') {
    addLobbyPlayer(msg.p);
    updateLobbyCount();
  } else if (msg.t === 'leave') {
    const entry = lobbyPlayers.get(msg.id);
    if (entry) { clearTimeout(entry.bubbleTimer); entry.el.remove(); lobbyPlayers.delete(msg.id); }
    updateLobbyCount();
  } else if (msg.t === 'update') {
    const entry = lobbyPlayers.get(msg.p.id);
    if (entry) { entry.el.remove(); lobbyPlayers.delete(msg.p.id); }
    addLobbyPlayer(msg.p);
    if (msg.p.id === lobbyMe && currentUser) { currentUser.transcend_count = msg.p.transcend; renderMyNickname(); }
  } else if (msg.t === 'move') {
    if (msg.id !== lobbyMe) walkLobbyPlayer(msg.id, msg.x, msg.y, msg.dur);
  } else if (msg.t === 'chat') {
    appendLobbyChat(msg.c, true);
  } else if (msg.t === 'notice') {
    showToast(msg.text, !msg.ok);
  } else if (msg.t === 'gspawn') {
    addLobbyGolden(msg.g);
    showToast('✨ 광장 어딘가에 황금 상자가 나타났습니다! 🎁 를 따라가 톡톡 두드려 보십시오');
  } else if (msg.t === 'gmove') {
    if (lobbyGolden) {
      const cur = lobbyPosAt(lobbyGolden.motion);
      lobbyGolden.motion = { x0: cur.x, y0: cur.y, x1: msg.x, y1: msg.y, t0: performance.now(), dur: msg.dur };
      placeLobbyEl(lobbyGolden.el, msg.x, msg.y, msg.dur);
    }
  } else if (msg.t === 'ghit') {
    if (lobbyGolden) {
      lobbyGolden.hp = msg.hp;
      renderGoldenHp();
      const body = lobbyGolden.el.querySelector('.lg-body');
      body.classList.remove('hit'); void body.offsetWidth; body.classList.add('hit');
    }
  } else if (msg.t === 'gfar') {
    showToast('조금 더 가까이 가서 두드리십시오!', true);
  } else if (msg.t === 'gopen') {
    if (lobbyGolden) {
      const el = lobbyGolden.el;
      el.classList.add('opened');
      el.querySelector('.lg-hint').textContent = msg.by.includes(lobbyMe) ? '🎉 열렸다!' : '다른 사람이 열었습니다';
      lobbyGolden = null;
      setTimeout(() => el.remove(), 1400);
    }
    document.getElementById('lobbyGoldenArrow')?.classList.add('hidden');
  } else if (msg.t === 'ggone') {
    removeLobbyGolden();
    showToast('황금 상자가 사라졌습니다… 다음에 또 나타납니다');
  } else if (msg.t === 'perks') {
    lobbyPerks = msg.perks;
    renderLobbyPerks();
  } else if (msg.t === 'rspawn') {
    addLobbyRaid(msg.r);
    showToast('🐉 거대 황금 상자 출현! 다 같이 두드려서 90초 안에 여십시오!');
    if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
  } else if (msg.t === 'rhit') {
    onLobbyRaidHit(msg);
  } else if (msg.t === 'rmove') {
    if (lobbyRaid) {
      const cur = lobbyPosAt(lobbyRaid.motion);
      lobbyRaid.motion = { x0: cur.x, y0: cur.y, x1: msg.x, y1: msg.y, t0: performance.now(), dur: msg.dur };
      lobbyRaid.el.classList.remove('jumping'); void lobbyRaid.el.offsetWidth; lobbyRaid.el.classList.add('jumping');
      placeLobbyEl(lobbyRaid.el, msg.x, msg.y, msg.dur);
      if (msg.jump) showToast('💨 거대 상자가 도망쳤습니다! 🐉 를 따라가십시오');
    }
  } else if (msg.t === 'rend') {
    onLobbyRaidEnd(msg);
  } else if (msg.t === 'rreward') {
    onLobbyRaidReward(msg);
  } else if (msg.t === 'greward') {
    showToast(`🎁 황금 상자 보상! +${formatGold(msg.gold)}G${msg.shards ? ` · 💎 +${msg.shards}` : ''}`);
    if (typeof msg.totalTreasure === 'number') setGold(msg.totalTreasure);
  }
}

function lobbyNameHtml(p){
  const title = p.title ? `<span class="rank-title" title="${escapeHtml(p.title.name)}">${p.title.emoji}</span>` : '';
  return `${title}<span class="lp-nick">${escapeHtml(p.nickname)}</span>${transcendBadgeHtml(p.transcend)}`;
}
// 지형 위 (x, y) 자리로 요소를 옮깁니다. 아래쪽에 있을수록 앞으로 보이게 z-index
function placeLobbyEl(el, x, y, durationMs){
  el.style.transitionDuration = `${durationMs}ms`;
  el.style.transform = `translate3d(${x * LOBBY_WORLD_W}px, ${y * LOBBY_WORLD_H}px, 0)`;
  el.style.zIndex = String(10 + Math.round(y * 1000));
}
function addLobbyPlayer(p){
  if (blockedIds.has(p.id)) return; // 차단한 사람은 보이지 않음
  const tier = transcendTier(p.transcend || 0);
  const el = document.createElement('div');
  el.className = `lobby-player tr-${tier}${p.id === lobbyMe ? ' me' : ''}`;
  el.dataset.uid = p.id;
  el.dataset.name = p.nickname;
  el.innerHTML = `
    <div class="lp-bubble"></div>
    <div class="lp-body">
      <span class="lp-aura"></span>
      <img class="lp-chest" src="icons/app/chest-only.svg" alt="" draggable="false">
      ${tier >= 5 ? '<span class="lp-crown">👑</span>' : ''}
    </div>
    <div class="lp-name">${lobbyNameHtml(p)}</div>`;
  lobbyWorld.appendChild(el);
  const entry = { p: { ...p }, el, bubbleTimer: null, motion: { x0: p.x, y0: p.y, x1: p.x, y1: p.y, t0: performance.now(), dur: 0 } };
  lobbyPlayers.set(p.id, entry);
  placeLobbyEl(el, p.x, p.y, 0);
  // 걷던 중에 들어왔으면 남은 길을 이어서 걷기
  if (p.dur > 0 && (p.tx !== p.x || p.ty !== p.y)) requestAnimationFrame(() => walkLobbyPlayer(p.id, p.tx, p.ty, p.dur));
}
// (x, y)로 걸어가기. 반환: 걸리는 시간(ms)
// durOverride: 서버가 알려준 걸리는 시간(다른 사람). 없으면 그 사람의 걷는 속도로 계산(나)
function walkLobbyPlayer(id, x, y, durOverride){
  const entry = lobbyPlayers.get(id);
  if (!entry) return 0;
  const now = performance.now();
  const cur = lobbyPosAt(entry.motion, now);
  const speed = entry.p.speed || LOBBY_WALK_PX_PER_SEC;
  const durationMs = typeof durOverride === 'number' ? durOverride : Math.round(lobbyDistPx(cur, { x, y }) / speed * 1000);
  // 걷는 도중에 방향을 바꾸면 지금 자리에서 바로 이어 걷도록, 먼저 지금 위치로 고정
  placeLobbyEl(entry.el, cur.x, cur.y, 0);
  void entry.el.offsetWidth;
  if (Math.abs(x - cur.x) * LOBBY_WORLD_W > 2) entry.el.classList.toggle('face-left', x < cur.x);
  entry.motion = { x0: cur.x, y0: cur.y, x1: x, y1: y, t0: now, dur: durationMs };
  entry.p.x = x;
  entry.p.y = y;
  placeLobbyEl(entry.el, x, y, durationMs);
  // 걷는 동안만 통통 튀는 모션
  entry.el.classList.add('walking');
  clearTimeout(entry.walkTimer);
  entry.walkTimer = setTimeout(() => entry.el.classList.remove('walking'), durationMs);
  if (id === lobbyMe) {
    lobbyCameraTo(cur.x, cur.y, 0); // 카메라도 지금 자리에서 이어서
    void lobbyWorld.offsetWidth;
    lobbyCameraTo(x, y, durationMs);
  }
  return durationMs;
}

// 바닥을 누르면 그 자리로 걸어가고, 누른 곳에 표시가 남습니다.
lobbyStage.addEventListener('click', (e) => {
  if (!lobbyWorld || !lobbyMe || !lobbyPlayers.has(lobbyMe)) return;
  if (e.target.closest('.lobby-golden, .lobby-raid, .lobby-raid-result')) return; // 황금 상자·레이드 누르기는 따로 처리
  const other = e.target.closest('.lobby-player:not(.me)');
  if (other) { openUserAction({ id: Number(other.dataset.uid), nickname: other.dataset.name, source: 'lobby' }); return; }
  const rect = lobbyStage.getBoundingClientRect();
  const cam = lobbyCameraCenter();
  const x = cam.x + (e.clientX - rect.left - rect.width / 2) / LOBBY_WORLD_W;
  const y = cam.y + (e.clientY - rect.top - lobbyFocusY()) / LOBBY_WORLD_H;
  lobbyWalkMeTo(x, y);
});
function lobbyWalkMeTo(rawX, rawY){
  const x = Math.min(LOBBY_WALK.maxX, Math.max(LOBBY_WALK.minX, rawX));
  const y = Math.min(LOBBY_WALK.maxY, Math.max(LOBBY_WALK.minY, rawY));
  const durationMs = walkLobbyPlayer(lobbyMe, x, y);
  showLobbyMarker(x, y, durationMs);
  lobbySend({ t: 'move', x, y });
}
function showLobbyMarker(x, y, durationMs){
  if (lobbyMarker) lobbyMarker.remove();
  const marker = document.createElement('div');
  marker.className = 'lobby-marker';
  marker.innerHTML = '<span class="lm-ring"></span><span class="lm-ring r2"></span><span class="lm-dot"></span>';
  marker.style.transform = `translate3d(${x * LOBBY_WORLD_W}px, ${y * LOBBY_WORLD_H}px, 0)`;
  lobbyWorld.appendChild(marker);
  lobbyMarker = marker;
  setTimeout(() => { if (lobbyMarker === marker) { marker.remove(); lobbyMarker = null; } }, Math.max(700, durationMs));
}
window.addEventListener('resize', () => {
  if (!lobbyWorld) return;
  const cam = lobbyCameraCenter();
  const me = lobbyPlayers.get(lobbyMe);
  lobbyCameraTo(cam.x, cam.y, 0);
  if (me && me.motion.dur) { void lobbyWorld.offsetWidth; lobbyCameraTo(me.motion.x1, me.motion.y1, Math.max(0, me.motion.t0 + me.motion.dur - performance.now())); }
});

// ── 황금 상자: 가까이 가면 "톡톡!" 손가락이 뜨고, 누를 때마다 흔들리며 금이 갑니다 ──
function addLobbyGolden(g){
  removeLobbyGolden();
  const el = document.createElement('div');
  el.className = 'lobby-golden';
  el.innerHTML = `
    <div class="lg-hint">👆 가까이 가서 톡톡!</div>
    <div class="lg-body"><span class="lg-glow"></span><img src="icons/items/gold_chest.svg" alt="황금 상자" draggable="false"></div>
    <div class="lg-hp"><div class="lg-hp-fill"></div></div>`;
  lobbyWorld.appendChild(el);
  lobbyGolden = { id: g.id, el, hp: g.hp, maxHp: g.maxHp,
    motion: { x0: g.x, y0: g.y, x1: g.x, y1: g.y, t0: performance.now(), dur: 0 } };
  placeLobbyEl(el, g.x, g.y, 0);
  renderGoldenHp();
  if (g.dur > 0) {
    requestAnimationFrame(() => {
      if (!lobbyGolden || lobbyGolden.el !== el) return;
      lobbyGolden.motion = { x0: g.x, y0: g.y, x1: g.tx, y1: g.ty, t0: performance.now(), dur: g.dur };
      placeLobbyEl(el, g.tx, g.ty, g.dur);
    });
  }
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!lobbyGolden || lobbyGolden.el !== el) return;
    const me = lobbyPlayers.get(lobbyMe);
    if (!me) return;
    const box = lobbyPosAt(lobbyGolden.motion);
    if (lobbyDistPx(lobbyPosAt(me.motion), box) <= lobbyTapRange(false)) {
      lobbySend({ t: 'gtap' });
      if (navigator.vibrate) navigator.vibrate(20);
    } else {
      // 멀면 상자 쪽으로 걸어감 (바로 옆까지)
      lobbyWalkMeTo(box.x, box.y + 50 / LOBBY_WORLD_H);
    }
  });
  updateLobbyGoldenHint();
}
function removeLobbyGolden(){
  if (lobbyGolden) lobbyGolden.el.remove();
  lobbyGolden = null;
  document.getElementById('lobbyGoldenArrow')?.classList.add('hidden');
}
function renderGoldenHp(){
  if (!lobbyGolden) return;
  const ratio = Math.max(0, lobbyGolden.hp / lobbyGolden.maxHp);
  lobbyGolden.el.querySelector('.lg-hp-fill').style.transform = `scaleX(${ratio})`;
  lobbyGolden.el.classList.toggle('cracked', ratio <= 0.5);
}
// 0.25초마다: 가까운지(톡톡 표시) · 화면 밖이면 가장자리 화살표
function updateLobbyGoldenHint(){
  updateLobbyRaidHud();
  const arrow = document.getElementById('lobbyGoldenArrow');
  // 화살표는 레이드 상자를 먼저 가리킴
  const target = lobbyRaid || lobbyGolden;
  if (!target || !arrow) { arrow?.classList.add('hidden'); return; }
  const me = lobbyPlayers.get(lobbyMe);
  if (!me) return;
  const mePos = lobbyPosAt(me.motion);
  const box = lobbyPosAt(target.motion);
  arrow.classList.toggle('raid', target === lobbyRaid);
  arrow.querySelector('.lga-icon').textContent = target === lobbyRaid ? '🐉' : '🎁';
  if (lobbyGolden) {
    const near = lobbyDistPx(mePos, lobbyPosAt(lobbyGolden.motion)) <= lobbyTapRange(false);
    lobbyGolden.el.classList.toggle('near', near);
    lobbyGolden.el.querySelector('.lg-hint').textContent = near ? '👆 톡톡! 두드리기' : '🎁 황금 상자';
  }
  if (lobbyRaid) {
    const near = lobbyDistPx(mePos, box) <= lobbyTapRange(true);
    lobbyRaid.el.classList.toggle('near', near);
    lobbyRaid.el.querySelector('.lr-hint').textContent = near ? '👊 연타! 다 같이 두드리기' : '🐉 거대 황금 상자';
  }
  // 화면 밖이면 가장자리에 방향 화살표
  const dx = (box.x - mePos.x) * LOBBY_WORLD_W;
  const dy = (box.y - mePos.y) * LOBBY_WORLD_H;
  // 보이는 영역: 위쪽 정보 층·레이드 체력바 아래부터 채팅 층 위까지
  const hud = document.getElementById('lobbyRaidHud');
  const topEl = document.querySelector('#lobbyView .lobby-top');
  const chatEl = document.getElementById('lobbyChat');
  const visTop = Math.max(topEl ? topEl.offsetTop + topEl.offsetHeight : 0,
    hud && !hud.classList.contains('hidden') ? hud.offsetTop + hud.offsetHeight : 0);
  const visBottom = chatEl && chatEl.offsetParent ? chatEl.offsetTop : lobbyStage.clientHeight;
  const cx = lobbyStage.clientWidth / 2;
  const cy = lobbyFocusY();
  const screenX = cx + dx;
  const screenY = cy + dy;
  // 상자가 조금이라도 보이면 화살표를 띄우지 않음 (가장자리에서 상자를 가리지 않게)
  const off = screenX < -24 || screenX > lobbyStage.clientWidth + 24 || screenY < visTop + 30 || screenY > visBottom + 40;
  arrow.classList.toggle('hidden', !off);
  if (off) {
    const hw = cx - 28;
    const k = Math.min(hw / Math.abs(dx || 1), Math.max(1, (dy < 0 ? cy - visTop - 26 : visBottom - cy - 26)) / Math.abs(dy || 1), 1);
    const ay = Math.min(visBottom - 26, Math.max(visTop + 26, cy + dy * k));
    arrow.style.transform = `translate(${cx + dx * k}px, ${ay}px)`;
    arrow.querySelector('.lga-arrow').style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
  }
}
// 화살표를 누르면 그쪽으로 걸어감
lobbyStage.addEventListener('click', (e) => {
  const target = lobbyRaid || lobbyGolden;
  if (!e.target.closest('#lobbyGoldenArrow') || !target) return;
  e.stopPropagation();
  const box = lobbyPosAt(target.motion);
  lobbyWalkMeTo(box.x, box.y + 50 / LOBBY_WORLD_H);
}, true);

function appendLobbyChat(c, showBubble){
  if (blockedIds.has(c.id)) return;
  if (showBubble && c.id !== lobbyMe && lobbyChatCollapsed) {
    lobbyUnread += 1;
    renderLobbyUnread();
  }
  const line = document.createElement('div');
  line.className = `lobby-line${c.id === lobbyMe ? ' mine' : ''}`;
  line.dataset.uid = c.id;
  if (c.cid) line.dataset.cid = c.cid;
  line.innerHTML = `<strong>${escapeHtml(c.nickname)}${transcendBadgeHtml(c.transcend)}</strong> <span class="lobby-text"></span>`;
  line.querySelector('.lobby-text').textContent = c.text;
  lobbyLogEl.appendChild(line);
  while (lobbyLogEl.children.length > 30) lobbyLogEl.firstChild.remove();
  lobbyLogEl.scrollTop = lobbyLogEl.scrollHeight;
  if (!showBubble) return;
  const entry = lobbyPlayers.get(c.id);
  if (!entry) return;
  const bubble = entry.el.querySelector('.lp-bubble');
  bubble.textContent = c.text;
  entry.el.classList.add('talking');
  clearTimeout(entry.bubbleTimer);
  entry.bubbleTimer = setTimeout(() => entry.el.classList.remove('talking'), LOBBY_BUBBLE_MS);
}
document.getElementById('lobbyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('lobbyInput');
  const text = input.value.trim();
  if (!text) return;
  if (!lobbyWs || lobbyWs.readyState !== WebSocket.OPEN) { showToast('광장에 연결되지 않았습니다', true); return; }
  lobbySend({ t: 'chat', text });
  input.value = '';
});

// -------------------------------
// 상자 강화 · 초월 (수집모드 강화 탭)
// -------------------------------
function renderEnhancePanel(){
  const panel = document.getElementById('enhancePanel');
  const c = lastStatus && lastStatus.collection;
  if (!c || !c.enhance) { panel.innerHTML = ''; return; }
  const e = c.enhance;
  const tr = e.transcend;
  const isMax = e.level >= e.max;
  const action = isMax
    ? `<button class="transcend-btn" id="transcendBtn">🌌 초월하기 <small>(${tr.count + 1}번째)</small></button>`
    : `<div class="enhance-odds">성공 <strong>${e.chance}%</strong> · ${e.dropOnFail ? '⚠️ 실패하면 한 단계 하락' : '실패해도 단계 유지'}</div>
       <button class="enhance-btn" id="enhanceBtn" ${c.shards >= e.cost ? '' : 'disabled'}>💎 ${e.cost} 써서 강화 <small>(보유 ${formatGold(c.shards)})</small></button>`;
  panel.innerHTML = `
    <div class="enhance-card tr-${tr.tier}${isMax ? ' maxed' : ''}">
      <div class="enhance-top">
        <div class="enhance-box"><img src="icons/app/chest-only.svg" alt=""><span class="enhance-level">+${e.level}</span></div>
        <div class="enhance-info">
          <strong>📦 상자 강화 +${e.level} / ${e.max}</strong>
          <small>전체 수입 +${e.incomePercent}% · 희귀 이상 등장률 +${e.luckPercent}%</small>
          <small>✦ 초월 ${tr.count}회 · 영구 전체 수입 +${tr.bonusPercent}%</small>
        </div>
      </div>
      <div class="enhance-bar"><div style="width:${e.level / e.max * 100}%"></div></div>
      ${action}
      <p class="enhance-hint">강화마다 수입 +${e.perLevel.income}% · 등장률 +${e.perLevel.luck}% · +${e.dropFrom}부터 실패 시 하락<br>
      +${e.max} 달성 시 초월: 골드·아이템·강화·연구·조각을 처음부터, 신화 도감·각성은 유지 · 초월 1회마다 영구 수입 +${tr.perTranscend}%와 이름 옆 ✦ 표시</p>
    </div>`;
}

document.getElementById('enhancePanel').addEventListener('click', async (event) => {
  const enhanceBtn = event.target.closest('#enhanceBtn');
  const transcendBtn = event.target.closest('#transcendBtn');
  if (enhanceBtn) {
    enhanceBtn.disabled = true;
    const { ok, data } = await collectionPost('/api/box/enhance');
    if (!ok) { showToast(data.message, true); renderEnhancePanel(); return; }
    lastStatus.collection.enhance = data.enhance;
    lastStatus.collection.shards = data.shards;
    renderEnhancePanel();
    const card = document.querySelector('#enhancePanel .enhance-card');
    card.classList.add(data.success ? 'flash-success' : 'flash-fail');
    showToast(data.message, !data.success);
    return;
  }
  if (transcendBtn) {
    const e = lastStatus.collection.enhance;
    const confirmed = await askConfirm({
      title: `🌌 ${e.transcend.count + 1}번째 초월`,
      text: `골드·아이템·업그레이드·연구·자동화·상자 강화·신화 조각이 사라지고 처음부터 다시 시작합니다.\n신화 도감·각성·업적은 그대로 남습니다.\n\n초월하면 영구 전체 수입 +${e.transcend.perTranscend}%가 더해지고, 이름 옆에 ✦${e.transcend.count + 1}이 표시됩니다.`,
      ok: '초월하기', danger: true,
    });
    if (!confirmed) return;
    transcendBtn.disabled = true;
    const { ok, data } = await collectionPost('/api/box/transcend');
    if (!ok) { showToast(data.message, true); renderEnhancePanel(); return; }
    currentUser.transcend_count = data.count;
    renderMyNickname();
    const flash = document.getElementById('legendaryFlash');
    if (flash) { flash.classList.remove('play'); void flash.offsetWidth; flash.classList.add('play'); }
    showToast(data.message);
    await refreshStatus();
    renderUpgradeScreen();
  }
});

// -------------------------------
// 신고 · 차단 (구글 플레이 사용자 제작 콘텐츠 정책)
// - 광장: 다른 사람 캐릭터나 채팅 줄을 누르면 신고·차단 창
// - 방명록: 글마다 신고·차단 버튼
// - 차단한 사람의 광장 캐릭터·채팅·방명록 글은 보이지 않습니다. 설정 → 차단 목록에서 해제
// -------------------------------
let blockedIds = new Set();
async function loadBlocks(){
  try {
    const res = await authFetch('/api/social/blocks');
    if (!res.ok) return;
    const data = await res.json();
    blockedIds = new Set(data.blocks.map(b => b.id));
    return data.blocks;
  } catch (e) { /* 다음 접속 때 다시 */ }
}

const userActionOverlay = document.getElementById('userActionOverlay');
let userActionTarget = null; // { id, nickname, cid, text, source }
function openUserAction(target){
  if (!target.id || target.id === (currentUser && currentUser.id)) return;
  userActionTarget = target;
  document.getElementById('userActionName').textContent = target.nickname || '';
  const quote = document.getElementById('userActionQuote');
  quote.textContent = target.text ? `“${target.text}”` : '';
  quote.classList.toggle('hidden', !target.text);
  document.getElementById('userActionReportBtn').innerHTML = target.cid
    ? '🚩 이 채팅 신고하기<small>부적절한 말을 운영자에게 알리기</small>'
    : '🚩 사용자 신고하기<small>부적절한 행동을 운영자에게 알리기</small>';
  // 광장 밖(방명록)에서는 글마다 신고 버튼이 따로 있어서 차단만 보여줍니다
  document.getElementById('userActionReportBtn').classList.toggle('hidden', target.source !== 'lobby');
  userActionOverlay.classList.add('show');
}
document.getElementById('userActionCloseBtn').addEventListener('click', () => userActionOverlay.classList.remove('show'));
document.getElementById('userActionReportBtn').addEventListener('click', () => {
  const t = userActionTarget;
  userActionOverlay.classList.remove('show');
  if (!t) return;
  if (!lobbyWs || lobbyWs.readyState !== WebSocket.OPEN) { showToast('광장에 연결되지 않았습니다', true); return; }
  lobbySend(t.cid ? { t: 'report', cid: t.cid } : { t: 'report', id: t.id });
});
document.getElementById('userActionBlockBtn').addEventListener('click', () => {
  const t = userActionTarget;
  userActionOverlay.classList.remove('show');
  if (t) blockUser(t.id, t.nickname);
});

async function blockUser(id, nickname){
  if (!id) return;
  const ok = await askConfirm({
    title: `🚫 ${nickname || ''} 차단`,
    text: '이 사람의 광장 캐릭터·채팅과 방명록 글이 더 이상 보이지 않습니다.\n설정 → 차단 목록에서 언제든 해제할 수 있습니다.',
    ok: '차단', danger: true,
  });
  if (!ok) return;
  try {
    const res = await authFetch('/api/social/block', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: id }),
    });
    const data = await res.json();
    showToast(data.message, !res.ok);
    if (!res.ok) return;
    blockedIds.add(id);
    hideBlockedEverywhere(id);
  } catch (e) {
    showToast('서버에 연결할 수 없습니다.', true);
  }
}
// 방금 차단한 사람을 지금 보이는 화면에서 바로 지웁니다
function hideBlockedEverywhere(id){
  const entry = lobbyPlayers.get(id);
  if (entry) { clearTimeout(entry.bubbleTimer); entry.el.remove(); lobbyPlayers.delete(id); updateLobbyCount(); }
  lobbyLogEl.querySelectorAll(`.lobby-line[data-uid="${id}"]`).forEach(el => el.remove());
  document.querySelectorAll(`#guestbookList [data-gb-block="${id}"]`).forEach(btn => btn.closest('.guestbook-entry')?.remove());
}

// 광장 채팅 줄을 누르면 그 채팅 신고·차단
lobbyLogEl.addEventListener('click', (e) => {
  const line = e.target.closest('.lobby-line');
  if (!line || line.classList.contains('mine')) return;
  openUserAction({
    id: Number(line.dataset.uid),
    nickname: line.querySelector('strong')?.textContent || '',
    cid: line.dataset.cid ? Number(line.dataset.cid) : null,
    text: line.querySelector('.lobby-text')?.textContent || '',
    source: 'lobby',
  });
});

// 설정 → 차단 목록
const blockListOverlay = document.getElementById('blockListOverlay');
async function renderBlockList(){
  const listEl = document.getElementById('blockList');
  listEl.innerHTML = '<p class="block-empty">불러오는 중...</p>';
  const blocks = await loadBlocks();
  if (!blocks) { listEl.innerHTML = '<p class="block-empty">불러오지 못했습니다.</p>'; return; }
  listEl.innerHTML = blocks.length
    ? blocks.map(b => `<div class="block-row"><span>${escapeHtml(b.nickname)}</span><button class="link-btn" data-unblock="${b.id}">해제</button></div>`).join('')
    : '<p class="block-empty">차단한 사람이 없습니다.<br>광장에서 다른 사람이나 채팅을 누르면 신고·차단할 수 있습니다.</p>';
}
document.getElementById('openBlockListBtn').addEventListener('click', () => {
  blockListOverlay.classList.add('show');
  renderBlockList();
});
document.getElementById('blockListCloseBtn').addEventListener('click', () => blockListOverlay.classList.remove('show'));
document.getElementById('blockList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-unblock]');
  if (!btn) return;
  btn.disabled = true;
  const res = await authFetch(`/api/social/block/${btn.dataset.unblock}`, { method: 'DELETE' });
  const data = await res.json().catch(() => ({}));
  showToast(data.message || '차단을 해제하지 못했습니다.', !res.ok);
  if (res.ok) {
    blockedIds.delete(Number(btn.dataset.unblock));
    btn.closest('.block-row').remove();
    if (!document.querySelector('#blockList .block-row')) renderBlockList();
  } else btn.disabled = false;
});

// -------------------------------
// 광장 레이드: 거대 황금 상자 (서버 lib/lobby.js 의 레이드와 짝)
// - 90초 안에 방 사람들이 함께 두드려 체력을 깎음 · 60%·25% 아래로 내려가면 도망
// - 피해 숫자·치명타 표시, 위쪽 공용 체력바, 끝나면 순위·MVP·내 보상
// -------------------------------
const lobbyPerksEl = document.getElementById('lobbyPerks');
function renderLobbyPerks(){
  const t = (currentUser && currentUser.transcend_count) || 0;
  lobbyPerksEl.classList.remove('hidden');
  lobbyPerksEl.innerHTML = t > 0
    ? `${transcendBadgeHtml(t)} <strong>초월 사냥 혜택</strong> 이동 +${lobbyPerks.speedPct}% · 사거리 +${lobbyPerks.rangePx} · 한 번에 피해 ${lobbyPerks.damage}`
    : '✦ <strong>초월하면 사냥이 쉬워집니다</strong> · 이동 속도·사거리·피해가 초월 횟수만큼 오릅니다';
}

function addLobbyRaid(r){
  removeLobbyRaid();
  const el = document.createElement('div');
  el.className = 'lobby-raid';
  el.innerHTML = `
    <div class="lr-hint">🐉 거대 황금 상자</div>
    <div class="lr-body"><span class="lr-aura"></span><img src="icons/items/gold_chest.svg" alt="거대 황금 상자" draggable="false"></div>`;
  lobbyWorld.appendChild(el);
  lobbyRaid = {
    id: r.id, el, hp: r.hp, maxHp: r.maxHp, party: r.party || 0, myDmg: 0,
    endsAt: performance.now() + r.endsInMs,
    motion: { x0: r.x, y0: r.y, x1: r.x, y1: r.y, t0: performance.now(), dur: 0 },
  };
  placeLobbyEl(el, r.x, r.y, 0);
  if (r.dur > 0) {
    requestAnimationFrame(() => {
      if (!lobbyRaid || lobbyRaid.el !== el) return;
      lobbyRaid.motion = { x0: r.x, y0: r.y, x1: r.tx, y1: r.ty, t0: performance.now(), dur: r.dur };
      placeLobbyEl(el, r.tx, r.ty, r.dur);
    });
  }
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!lobbyRaid || lobbyRaid.el !== el) return;
    const me = lobbyPlayers.get(lobbyMe);
    if (!me) return;
    const box = lobbyPosAt(lobbyRaid.motion);
    if (lobbyDistPx(lobbyPosAt(me.motion), box) <= lobbyTapRange(true)) {
      lobbySend({ t: 'rtap' });
      if (navigator.vibrate) navigator.vibrate(15);
    } else {
      lobbyWalkMeTo(box.x, box.y + 70 / LOBBY_WORLD_H);
    }
  });
  document.getElementById('lobbyRaidHud')?.classList.remove('hidden');
  document.getElementById('lobbyRaidResult')?.classList.add('hidden');
  updateLobbyRaidHud();
}
function removeLobbyRaid(){
  if (lobbyRaid) lobbyRaid.el.remove();
  lobbyRaid = null;
  document.getElementById('lobbyRaidHud')?.classList.add('hidden');
}
function updateLobbyRaidHud(){
  const hud = document.getElementById('lobbyRaidHud');
  if (!hud || !lobbyRaid) return;
  const ratio = Math.max(0, lobbyRaid.hp / lobbyRaid.maxHp);
  const left = Math.max(0, Math.ceil((lobbyRaid.endsAt - performance.now()) / 1000));
  hud.querySelector('.lrh-fill').style.transform = `scaleX(${ratio})`;
  hud.querySelector('.lrh-hp').textContent = `${lobbyRaid.hp} / ${lobbyRaid.maxHp}`;
  hud.querySelector('.lrh-time').textContent = `⏱ ${left}초`;
  hud.classList.toggle('hurry', left <= 15);
  hud.querySelector('.lrh-party').textContent = `👥${lobbyRaid.party}`;
  hud.querySelector('.lrh-mine').textContent = lobbyRaid.myDmg ? `내 피해 ${lobbyRaid.myDmg}` : '가서 연타!';
}
// 피해 숫자를 상자 위에 띄움 (내 것은 크게, 치명타는 노랗게)
function showLobbyDamage(dmg, crit, mine){
  if (!lobbyRaid || !lobbyWorld) return;
  const pos = lobbyPosAt(lobbyRaid.motion);
  const el = document.createElement('div');
  el.className = `dmg-float${crit ? ' crit' : ''}${mine ? ' mine' : ''}`;
  el.textContent = crit ? `치명타! -${dmg}` : `-${dmg}`;
  const jitter = (Math.random() - 0.5) * 60;
  el.style.transform = `translate3d(${pos.x * LOBBY_WORLD_W + jitter}px, ${pos.y * LOBBY_WORLD_H - 70}px, 0)`;
  lobbyWorld.appendChild(el);
  setTimeout(() => el.remove(), 900);
}
function onLobbyRaidHit(msg){
  if (!lobbyRaid) return;
  lobbyRaid.hp = msg.hp;
  lobbyRaid.party = msg.party;
  const mine = msg.by === lobbyMe;
  if (mine) lobbyRaid.myDmg += msg.dmg;
  // 다른 사람 피해 숫자는 너무 많아지지 않게 일부만
  if (mine || msg.crit || Math.random() < 0.5) showLobbyDamage(msg.dmg, msg.crit, mine);
  const body = lobbyRaid.el.querySelector('.lr-body');
  body.classList.remove('hit'); void body.offsetWidth; body.classList.add('hit');
  lobbyRaid.el.classList.toggle('cracked', lobbyRaid.hp <= lobbyRaid.maxHp * 0.5);
  updateLobbyRaidHud();
}
function onLobbyRaidEnd(msg){
  const myDmg = lobbyRaid ? lobbyRaid.myDmg : 0;
  if (lobbyRaid) {
    const el = lobbyRaid.el;
    el.classList.add(msg.success ? 'opened' : 'escaped');
    lobbyRaid = null;
    setTimeout(() => el.remove(), 1400);
  }
  document.getElementById('lobbyRaidHud')?.classList.add('hidden');
  const medals = ['🥇', '🥈', '🥉'];
  const rows = msg.ranking.slice(0, 3).map((r, i) => `
    <div class="lrr-row${r.id === lobbyMe ? ' me' : ''}"><span>${medals[i]} ${escapeHtml(r.nickname)}${r.id === msg.mvp ? ' <b>MVP</b>' : ''}</span><span>${r.dmg}</span></div>`).join('');
  const result = document.getElementById('lobbyRaidResult');
  if (!result) return;
  result.innerHTML = msg.success
    ? `<p class="lrr-title">🎉 레이드 성공!</p>
       <p class="lrr-sub">참가 ${msg.party}명 · 파티 보너스 +${msg.bonusPct}%</p>
       ${rows}
       <p class="lrr-mine" id="lobbyRaidMine">${myDmg ? `내 피해 ${myDmg} · 보상 받는 중...` : '이번에는 참가하지 못했습니다'}</p>
       <p class="lrr-close">눌러서 닫기</p>`
    : `<p class="lrr-title">💨 거대 상자가 달아났습니다…</p>
       <p class="lrr-sub">90초 안에 체력을 다 깎아야 합니다. 다음에는 더 많이 모여 보십시오!</p>
       ${rows}
       <p class="lrr-close">눌러서 닫기</p>`;
  if (msg.success && myDmg && myDmg > 0) {
    // 최소 횟수를 못 채운 경우 안내 (보상 메시지가 오면 덮어씀)
    setTimeout(() => {
      const mineEl = document.getElementById('lobbyRaidMine');
      if (mineEl && mineEl.textContent.includes('받는 중')) mineEl.textContent = `내 피해 ${myDmg} · ${msg.minTaps}번 이상 두드려야 보상을 받습니다`;
    }, 4000);
  }
  result.classList.remove('hidden');
  clearTimeout(result.hideTimer);
  result.hideTimer = setTimeout(() => result.classList.add('hidden'), 9000);
}
function onLobbyRaidReward(msg){
  const text = `+${formatGold(msg.gold)}G${msg.shards ? ` · 💎 +${msg.shards}` : ''}`;
  const mineEl = document.getElementById('lobbyRaidMine');
  if (mineEl) mineEl.innerHTML = `${msg.mvp ? '👑 MVP! ' : ''}기여 ${msg.share}% · <strong>${text}</strong>`;
  showToast(`🐉 레이드 보상 ${text}${msg.mvp ? ' (MVP 보너스 포함)' : ''}`);
  if (typeof msg.totalTreasure === 'number') setGold(msg.totalTreasure);
}

// -------------------------------
// 광장 전체 화면: 채팅 층 접기·펼치기, 도움말, 화면 크기 맞추기
// -------------------------------
const lobbyChatEl = document.getElementById('lobbyChat');
let lobbyChatCollapsed = false;
let lobbyUnread = 0;
try { lobbyChatCollapsed = localStorage.getItem('lobbyChatCollapsed') === '1'; } catch (e) { /* 저장소를 못 쓰면 펼친 상태 */ }
function renderLobbyUnread(){
  const badge = document.getElementById('lobbyChatUnread');
  badge.textContent = lobbyUnread > 99 ? '99+' : String(lobbyUnread);
  badge.classList.toggle('hidden', !(lobbyChatCollapsed && lobbyUnread > 0));
}
function setLobbyChatCollapsed(collapsed){
  lobbyChatCollapsed = collapsed;
  lobbyChatEl.classList.toggle('collapsed', collapsed);
  document.getElementById('lobbyChatToggle').setAttribute('aria-expanded', String(!collapsed));
  if (!collapsed) { lobbyUnread = 0; lobbyLogEl.scrollTop = lobbyLogEl.scrollHeight; }
  renderLobbyUnread();
  try { localStorage.setItem('lobbyChatCollapsed', collapsed ? '1' : '0'); } catch (e) { /* 무시 */ }
  relayoutLobby();
}
document.getElementById('lobbyChatToggle').addEventListener('click', () => setLobbyChatCollapsed(!lobbyChatCollapsed));
setLobbyChatCollapsed(lobbyChatCollapsed);

// 보이는 영역이 바뀌면(채팅 접기·화면 회전·키보드) 내 상자가 다시 가운데 오도록 카메라를 맞춤
function relayoutLobby(){
  const tabBar = document.getElementById('tabBar');
  if (tabBar && tabBar.offsetHeight) document.documentElement.style.setProperty('--tabbar-h', `${tabBar.offsetHeight}px`);
  const top = document.querySelector('#lobbyView .lobby-top');
  if (top) document.documentElement.style.setProperty('--lobby-top-h', `${top.offsetTop + top.offsetHeight}px`);
  if (!lobbyWorld || !lobbyPlayers.has(lobbyMe)) return;
  const me = lobbyPlayers.get(lobbyMe);
  const cur = lobbyPosAt(me.motion);
  lobbyCameraTo(cur.x, cur.y, 0);
  if (me.motion.dur && performance.now() < me.motion.t0 + me.motion.dur) {
    void lobbyWorld.offsetWidth;
    lobbyCameraTo(me.motion.x1, me.motion.y1, Math.max(0, me.motion.t0 + me.motion.dur - performance.now()));
  }
}
window.addEventListener('resize', relayoutLobby);
if (window.ResizeObserver) new ResizeObserver(relayoutLobby).observe(document.querySelector('#lobbyView .lobby-top'));

document.getElementById('lobbyHelpBtn').addEventListener('click', () => {
  askConfirm({
    title: '🎪 광장 도움말',
    text: '· 바닥을 누르면 그 자리로 걸어갑니다.\n'
      + '· 🎁 황금 상자: 가끔 나타나 돌아다닙니다. 가까이 가서 톡톡 두드리면 보상을 받습니다.\n'
      + '· 🐉 거대 황금 상자: 레이드입니다. 방 사람들과 90초 안에 함께 두드려 여십시오.\n'
      + '· 다른 사람이나 채팅을 누르면 🚩 신고 · 🚫 차단할 수 있습니다.\n'
      + '· 초월할수록 이동 속도·사거리·피해가 오르고 캐릭터 효과가 화려해집니다.\n'
      + '· 💬 채팅은 ▾ 로 접고 ▴ 로 펼칩니다.',
    ok: '확인', cancel: null,
  });
});

// -------------------------------
// 이메일 인증 · 변경 (서버 routes/auth.js /email/*)
// - 가입은 인증 없이 그대로, 원하는 사람만 설정에서 인증 (첫 인증 💎20)
// - 변경은 현재 비밀번호 + 새 주소로 받은 코드 확인
// - 인증 안 한 계정은 홈에 작은 안내 (닫으면 7일 숨김)
// -------------------------------
const emailOverlay = document.getElementById('emailOverlay');
let emailMode = 'verify';  // 'verify' | 'change'
let emailStep = 1;         // 1: 코드 받기 · 2: 코드 입력
const EMAIL_NUDGE_KEY = 'boxGameEmailNudgeHiddenUntil';

function renderEmailState(){
  const verified = Boolean(currentUser && currentUser.email_verified);
  const state = document.getElementById('settingsEmailState');
  state.textContent = verified ? '✅ 인증됨' : '⚠️ 인증 안 됨';
  state.classList.toggle('ok', verified);
  document.getElementById('openEmailVerifyBtn').classList.toggle('hidden', verified);
  let hiddenUntil = 0;
  try { hiddenUntil = Number(localStorage.getItem(EMAIL_NUDGE_KEY)) || 0; } catch (e) { /* 무시 */ }
  document.getElementById('emailNudge').classList.toggle('hidden', verified || !currentUser || Date.now() < hiddenUntil);
}
function showEmailError(message){
  const el = document.getElementById('emailError');
  el.textContent = message || '';
  el.style.display = message ? 'block' : 'none';
}
function setEmailStep(step){
  emailStep = step;
  const change = emailMode === 'change';
  document.getElementById('emailTitle').textContent = change ? '✏️ 이메일 변경' : '📧 이메일 인증';
  document.getElementById('emailChangeFields').classList.toggle('hidden', !change || step !== 1);
  document.getElementById('emailCodeFields').classList.toggle('hidden', step !== 2);
  document.getElementById('emailResendBtn').classList.toggle('hidden', step !== 2);
  document.getElementById('emailSubmitBtn').textContent = step === 2 ? (change ? '이메일 바꾸기' : '인증하기') : '인증 코드 받기';
  document.getElementById('emailDesc').textContent = step === 2
    ? `${change ? '새 이메일' : '이메일'}로 받은 6자리 코드를 입력해 주십시오. (메일이 안 보이면 스팸함도 확인해 주십시오)`
    : change
      ? '새 이메일로 인증 코드를 보냅니다. 본인 확인을 위해 현재 비밀번호가 필요합니다.'
      : `${currentUser ? currentUser.email : ''} 로 인증 코드를 보냅니다. 비밀번호를 잊었을 때 이 주소로 찾을 수 있습니다.`;
}
function openEmailOverlay(mode){
  emailMode = mode;
  ['emailNewInput', 'emailPasswordInput', 'emailCodeInput'].forEach(id => { document.getElementById(id).value = ''; });
  showEmailError('');
  setEmailStep(1);
  emailOverlay.classList.add('show');
}
document.getElementById('openEmailVerifyBtn').addEventListener('click', () => openEmailOverlay('verify'));
document.getElementById('openEmailChangeBtn').addEventListener('click', () => openEmailOverlay('change'));
document.getElementById('emailNudgeOpen').addEventListener('click', () => openEmailOverlay('verify'));
document.getElementById('emailNudgeClose').addEventListener('click', () => {
  try { localStorage.setItem(EMAIL_NUDGE_KEY, String(Date.now() + 7 * 24 * 60 * 60 * 1000)); } catch (e) { /* 무시 */ }
  document.getElementById('emailNudge').classList.add('hidden');
});
document.getElementById('emailCloseBtn').addEventListener('click', () => emailOverlay.classList.remove('show'));

async function emailPost(path, body){
  const res = await authFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}
async function requestEmailCode(){
  const body = emailMode === 'change'
    ? { newEmail: document.getElementById('emailNewInput').value.trim(), password: document.getElementById('emailPasswordInput').value }
    : {};
  if (emailMode === 'change' && (!body.newEmail || !body.password)) return showEmailError('새 이메일과 현재 비밀번호를 입력해 주십시오.');
  const { ok, data } = await emailPost(`/api/auth/email/${emailMode}/send`, body);
  if (!ok) return showEmailError(data.message || '인증 코드를 보내지 못했습니다.');
  showEmailError('');
  showToast(data.message);
  setEmailStep(2);
  document.getElementById('emailCodeInput').focus();
}
document.getElementById('emailSubmitBtn').addEventListener('click', async function(){
  if (this.disabled) return;
  this.disabled = true;
  showEmailError('');
  try {
    if (emailStep === 1) { await requestEmailCode(); return; }
    const { ok, data } = await emailPost(`/api/auth/email/${emailMode}/confirm`, { code: document.getElementById('emailCodeInput').value.trim() });
    if (!ok) return showEmailError(data.message || '확인하지 못했습니다.');
    if (data.token) { authToken = data.token; localStorage.setItem('boxGameToken', data.token); }
    if (data.user) currentUser = { ...currentUser, ...data.user };
    currentUser.email_verified = true;
    emailOverlay.classList.remove('show');
    showToast(data.message);
    renderEmailState();
    if (data.reward) refreshStatus();
  } catch (err) {
    showEmailError('서버에 연결할 수 없습니다.');
  } finally {
    this.disabled = false;
  }
});
document.getElementById('emailResendBtn').addEventListener('click', async function(){
  this.disabled = true;
  try { await requestEmailCode(); } catch (e) { showEmailError('서버에 연결할 수 없습니다.'); }
  finally { setTimeout(() => { this.disabled = false; }, 30000); }
});
// 코드 칸에서 엔터 = 확인
document.getElementById('emailCodeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); document.getElementById('emailSubmitBtn').click(); }
});
