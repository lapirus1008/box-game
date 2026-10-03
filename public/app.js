const API_BASE = 'https://box-game-6y1g.onrender.com';

const DEFAULT_CHARGE_INTERVAL_MS = 15 * 1000; // 서버에서 실제 값(업그레이드 반영)을 받기 전까지 쓰는 기본값
const MAX_BOX_CHARGES = 100;
const REBIRTH_GOLD_REQUIRED = 100000;
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

const authScreen = document.getElementById('authScreen');
const gameScreen = document.getElementById('gameScreen');
const collectionScreen = document.getElementById('collectionScreen');
const rankingScreen = document.getElementById('rankingScreen');
const upgradeScreen = document.getElementById('upgradeScreen');
const achievementScreen = document.getElementById('achievementScreen');
const authError = document.getElementById('authError');

// 골드는 항상 소수점 없이, 천 단위 쉼표를 붙여 표시합니다.
function formatGold(value){
  return Math.floor(Number(value) || 0).toLocaleString();
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

  main.textContent = `${title} · 도감 ${rank.obtainedCount}/${rank.total}`;
  main.classList.remove('hidden');

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

// 페이지를 열자마자 저장된 토큰이 아직 유효한지 확인해서 자동 로그인 시도
(async function tryAutoLogin(){
  if (!authToken) return;
  try {
    const res = await authFetch('/api/auth/me');
    if (!res.ok) throw new Error('토큰 만료');
    const data = await res.json();
    currentUser = data.user;
    enterGame();
  } catch (err) {
    localStorage.removeItem('boxGameToken');
    authToken = null;
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

document.getElementById('signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearAuthError();
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
  }
});

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearAuthError();
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
  gameScreen.classList.add('hidden');
  authScreen.classList.remove('hidden');
});

// 현재 모드에 맞춰 화면 전체를 갱신 (배지, 색상, 기록모드 전용 요소 표시 여부, 문구)
function applyModeUI(mode){
  currentMode = mode;
  const isRecord = mode === 'record';
  document.body.classList.toggle('mode-collection', !isRecord);

  document.getElementById('modeBadge').innerHTML = isRecord
    ? '🏆 기록모드<span class="mode-hint">환생하며 랭킹에 도전해요</span>'
    : '📖 수집모드<span class="mode-hint">환생 없이 도감을 영구히 채워요</span>';
  document.getElementById('switchModeBtn').textContent = isRecord ? '📖 수집모드로' : '🏆 기록모드로';

  document.getElementById('collectionModeSubtext').textContent = isRecord
    ? '도감은 이번 판 한정 (환생 시 초기화)'
    : '도감 영구 보존';

  document.getElementById('modeTabRun').textContent = '🎒 가방';
  document.getElementById('runModeHint').textContent = isRecord
    ? '같은 아이템 3개 → 한 등급 위로 합성 (영웅→전설까지) · 환생하면 비워져요'
    : '같은 아이템 3개 → 한 등급 위로 합성 (영웅→전설까지)';
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

document.getElementById('switchModeBtn').addEventListener('click', () => {
  switchMode(currentMode === 'record' ? 'collection' : 'record');
});

function enterGame(){
  document.getElementById('userNickname').textContent = currentUser.nickname || currentUser.email;
  authScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  resetGameResultUI();

  // /me 응답에 담겨온 현재 모드로 즉시 UI를 맞춰서, 첫 상태 조회가 끝나기 전에도
  // 깜빡임 없이 올바른 모드로 보이게 합니다.
  applyModeUI(currentUser.active_mode || 'record');

  refreshStatus();
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
    applyAutoOpen(data.autoOpen);
    applyChargeInfo(data);
    updatePityUI(data.mythicPity, data.mythicPityLimit);
    document.getElementById('mainClaimBonusBtn')
      .classList.toggle('hidden', !(data.collectionComplete && !data.bonusClaimed));

    if (data.collectorRank) renderCollectorRank(data.collectorRank);
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

// 정산 중에 자동 개봉/자동 합성이 일어났으면 결과 칸에 짧게 알려줍니다.
function handleAutoEvents(data){
  const lines = [];
  if (data.autoOpened && data.autoOpened.count > 0) {
    const highlights = data.autoOpened.obtained
      .filter(o => o.rarity !== 'common')
      .map(o => `${o.emoji}${o.name} x${o.count}`);
    lines.push(`🤖 자동 개봉 ${data.autoOpened.count}개${highlights.length ? ` · ${highlights.join(', ')}` : ''}`);
    checkAndTriggerLegendary(data.autoOpened.obtained, data.autoOpened.pityTriggered);
  }
  if (data.autoCrafted && data.autoCrafted.count > 0) {
    lines.push(`⚙️ 자동 합성 ${data.autoCrafted.count}번`);
  }
  if (lines.length === 0 || gameScreen.classList.contains('hidden')) return;
  document.getElementById('rarityBadge').textContent = '';
  document.getElementById('treasureName').textContent = lines[0];
  document.getElementById('treasureDetail').textContent = lines.slice(1).join(' · ');
  document.getElementById('resultBox').style.display = 'block';
}

// 자리 비운 동안 일어난 일을 팝업으로 보여줍니다.
function showAwaySummary(summary, autoOpened){
  const minutes = Math.floor(summary.awayMs / 60000);
  const awayText = minutes >= 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : `${minutes}분`;
  document.getElementById('awayTime').textContent = `${awayText} 동안 자리를 비웠어요`;
  document.getElementById('awayGold').textContent = `+${formatGold(summary.goldEarned)}G`;

  const details = [];
  if (summary.storageCapped) details.push(`📦 보관 시간 ${summary.storageText}까지만 쌓였어요 (강화에서 창고를 늘려보세요)`);
  if (summary.autoOpenedCount > 0) details.push(`⏳ 상자 ${formatGold(summary.autoOpenedCount)}개 자동 개봉`);
  if (summary.autoCraftCount > 0) details.push(`⚙️ ${formatGold(summary.autoCraftCount)}번 자동 합성`);
  summary.notable.forEach(item => details.push(`${item.emoji} ${item.name} x${item.count}`));
  if (summary.autoOpenedCount === 0) details.push('💡 강화 화면에서 자동 개봉 시간을 사두면 자리 비운 동안에도 상자가 열려요');

  const list = document.getElementById('awayDetails');
  list.innerHTML = '';
  details.forEach(text => {
    const li = document.createElement('li');
    li.textContent = text;
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

// 환생 목표 칸 아래: 환생 포인트 안내 (기록모드 전용)
function renderPrestigeHint(prestige){
  const el = document.getElementById('prestigeHint');
  if (!prestige || !prestige.enabled) { el.textContent = ''; return; }
  const owned = `✨ 환생 포인트 ${prestige.points}개`;
  const gain = prestige.pointsOnRebirth > 0
    ? `지금 환생하면 +${prestige.pointsOnRebirth}개`
    : `이번 판 ${formatGold(prestige.runGoldEarned)} / ${formatGold(prestige.nextPointAt)}G 벌면 +1개`;
  el.textContent = `${owned} · ${gain}`;
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
  chest.style.opacity = canOpen ? '1' : '0.6';
  chest.style.pointerEvents = (canOpen && !isOpening) ? 'auto' : 'none';

  if (cachedAutoOpen) {
    statusText.textContent = `⏳ 자동 개봉 중 · 남은 시간 ${formatDuration(Math.floor(autoOpenRemainingMs() / 1000))}`;
    statusText.classList.add('ready');
  } else if (canOpen) {
    statusText.textContent = `충전된 상자 ${cachedCharges}개 · 열 수 있습니다`;
    statusText.classList.add('ready');
  } else {
    statusText.classList.remove('ready');
    statusText.textContent = '충전된 상자가 없습니다';
  }

  document.getElementById('chargeBarFill').style.width = `${(cachedCharges / cachedMaxCharges) * 100}%`;

  // 다음 충전까지 몇 초 남았는지 표시 (꽉 찼으면 안내 문구로 대체)
  const nextChargeText = document.getElementById('nextChargeText');
  if (!cachedAutoOpen && cachedCharges >= cachedMaxCharges) {
    nextChargeText.textContent = `충전이 꽉 찼습니다 (최대 ${cachedMaxCharges}개)`;
  } else if (cachedNextChargeAt) {
    const secondsLeft = Math.max(0, Math.ceil((cachedNextChargeAt - adjustedNow()) / 1000));
    nextChargeText.textContent = `다음 충전까지 ${secondsLeft}초`;
  }

  // 플레이타임
  if (cachedRunStartedAt) {
    const playSeconds = Math.floor((adjustedNow() - cachedRunStartedAt) / 1000);
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
    breakdownText = `${parts.join(' + ')}${bonuses.length ? ` · ${bonuses.join(' · ')}` : ''}`;
  }
  document.querySelectorAll('[data-income="pending"]').forEach(el => { el.textContent = rateText; });
  document.querySelectorAll('[data-income="rate"]').forEach(el => { el.textContent = breakdownText; });

  // 환생 목표 진행바
  const goldNow = liveGold();
  const pct = Math.min(100, (goldNow / REBIRTH_GOLD_REQUIRED) * 100);
  document.getElementById('rebirthGoalText').textContent = `${goldNow.toLocaleString()} / ${REBIRTH_GOLD_REQUIRED.toLocaleString()}G`;
  document.getElementById('rebirthGoalBar').style.width = `${pct}%`;

  const goalBox = document.getElementById('rebirthGoalBox');
  const goalReady = goldNow >= REBIRTH_GOLD_REQUIRED;
  goalBox.style.borderColor = goalReady ? 'var(--gold)' : '#2C3F6B';
  goalBox.style.boxShadow = goalReady ? '0 0 12px rgba(227,178,60,0.4)' : 'none';
  const mainRebirthBtn = document.getElementById('mainRebirthBtn');
  mainRebirthBtn.disabled = !goalReady;
  mainRebirthBtn.classList.toggle('hidden', !goalReady); // 환생 가능할 때만 버튼 노출

  const rebirthProgressText = document.getElementById('rebirthProgressText');
  rebirthProgressText.textContent = `${goldNow.toLocaleString()} / ${REBIRTH_GOLD_REQUIRED.toLocaleString()}G`;
  const rebirthBtn = document.getElementById('rebirthBtn');
  rebirthBtn.disabled = !goalReady;
  rebirthBtn.classList.toggle('hidden', !goalReady);

  clampBulkOpenQty();
  clampBuyBoxQty();
  if (!upgradeScreen.classList.contains('hidden')) {
    updateUpgradeAffordability();
    renderAutoOpenTimer();
  }
  renderGoldenBox();
}

const GOLD_PER_BOX_PURCHASE = 75; // 서버의 GOLD_PER_BOX_PURCHASE와 반드시 일치시켜야 함
const MAX_GOLD_BOX_PURCHASE = 2000; // 서버의 MAX_GOLD_BOX_PURCHASE와 반드시 일치시켜야 함

function getMaxBuyableQty(){
  const gold = liveGold();
  return Math.min(MAX_GOLD_BOX_PURCHASE, Math.max(0, Math.floor(gold / GOLD_PER_BOX_PURCHASE)));
}

function clampBuyBoxQty(){
  const input = document.getElementById('buyBoxQty');
  const max = getMaxBuyableQty();
  let value = parseInt(input.value, 10);
  if (isNaN(value) || value < 1) value = 1;
  if (value > max) value = max;
  input.value = max === 0 ? 0 : value;

  const cost = value * GOLD_PER_BOX_PURCHASE;
  document.getElementById('buyBoxCostText').textContent =
    `개당 ${GOLD_PER_BOX_PURCHASE}G · 총 ${cost}G · 최대 ${max}개 구매 가능 (충전과 무관)`;

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
    document.getElementById('rarityBadge').textContent = '';
    document.getElementById('treasureName').textContent = `💰 ${data.quantity}개 구매 오픈`;
    document.getElementById('treasureDetail').textContent =
      data.obtained.map(o => `${o.emoji}${o.name} x${o.count}`).join(', ');
    document.getElementById('resultBox').style.display = 'block';

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

function getMaxOpenableQty(){
  return cachedAutoOpen ? 0 : Math.max(0, cachedCharges);
}

function clampBulkOpenQty(){
  const input = document.getElementById('bulkOpenQty');
  const max = getMaxOpenableQty();
  let value = parseInt(input.value, 10);
  if (isNaN(value) || value < 1) value = 1;
  if (value > max) value = max;
  input.value = max === 0 ? 0 : value;

  document.getElementById('bulkOpenCostText').textContent = cachedAutoOpen
    ? '⏳ 자동 개봉 중이라 충전된 상자는 자동으로 열려요'
    : `충전 ${cachedCharges}/${cachedMaxCharges} · 최대 ${max}개까지 무료로 열 수 있어요`;

  document.getElementById('bulkOpenBtn').disabled = cachedAutoOpen || max === 0 || value < 1 || isOpening;
  document.getElementById('maxQtyBtn').disabled = cachedAutoOpen || max === 0;
}

document.getElementById('bulkOpenQty').addEventListener('input', clampBulkOpenQty);
document.getElementById('maxQtyBtn').addEventListener('click', () => {
  document.getElementById('bulkOpenQty').value = getMaxOpenableQty();
  clampBulkOpenQty();
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
  const remaining = limit - pity; // 이 개수만큼 더 열면(=마지막 상자가) 신화 확정
  document.getElementById('pityText').textContent = `${pity.toLocaleString()} / ${limit.toLocaleString()}`;
  document.getElementById('pityBarFill').style.width = `${Math.min(100, (pity / limit) * 100)}%`;
  const box = document.getElementById('pityBox');
  const hint = document.getElementById('pityHint');
  const imminent = remaining <= 1;
  box.classList.toggle('imminent', imminent);
  hint.textContent = imminent
    ? '🔥 다음 상자는 신화 확정!'
    : `${remaining.toLocaleString()}개 더 열면 신화 확정`;
}

const mythicQueue = [];
let mythicShowing = false;

const overlayEyebrow = () => document.querySelector('#mythicEventOverlay .mythic-eyebrow');

function showNextMythicEvent(){
  if (mythicShowing || mythicQueue.length === 0) return;
  const item = mythicQueue.shift();
  mythicShowing = true;

  overlayEyebrow().textContent = item.pityTriggered ? '✦ 천장 달성 · 신화 확정 ✦' : '✦ 신화 등급 발견 ✦';
  document.getElementById('mythicEventEmoji').textContent = item.emoji;
  document.getElementById('mythicEventName').textContent =
    item.count > 1 ? `${item.name} x${item.count}` : item.name;
  document.getElementById('mythicEventFlavor').textContent = item.flavor || '';

  const overlay = document.getElementById('mythicEventOverlay');
  overlay.classList.add('show');

  // 카드 주변에 반짝이 파티클
  const card = overlay.querySelector('.mythic-card');
  for (let i = 0; i < 14; i++) {
    const p = document.createElement('span');
    p.className = 'mythic-particle';
    p.textContent = ['✨', '💫', '🌸'][i % 3];
    p.style.left = `${Math.random() * 100}%`;
    p.style.top = `${40 + Math.random() * 60}%`;
    p.style.animationDelay = `${Math.random() * 0.8}s`;
    card.appendChild(p);
    setTimeout(() => p.remove(), 2800);
  }
  if (navigator.vibrate) navigator.vibrate([80, 60, 160]);
}

document.getElementById('mythicEventCloseBtn').addEventListener('click', () => {
  document.getElementById('mythicEventOverlay').classList.remove('show');
  mythicShowing = false;
  showNextMythicEvent(); // 한 번에 여러 종류가 나온 경우 이어서 보여줌
});

function checkAndTriggerLegendary(items, pityTriggered){
  // items: 단일 아이템 객체 또는 아이템 배열 둘 다 받을 수 있게
  const list = Array.isArray(items) ? items : [items];
  const mythics = list.filter(item => item && item.rarity === 'mythic');

  if (mythics.length > 0) {
    // 신화는 전설 이펙트 대신 전용 이벤트 화면으로 보여줌
    mythics.forEach((m, i) => mythicQueue.push({ ...m, pityTriggered: Boolean(pityTriggered) && i === 0 }));
    showNextMythicEvent();
  } else if (list.some(item => item && item.rarity === 'legendary')) {
    triggerLegendaryEffect();
  }
}

// 상자 열기가 성공했을 때 화면을 갱신하는 공통 함수
function handleOpenSuccess(data){
  syncServerTime(data.serverTime);
  applyChargeInfo(data);
  renderTick();

  const chest = document.getElementById('chest');
  chest.classList.add('open');
  const rarityBadge = document.getElementById('rarityBadge');
  rarityBadge.textContent = RARITY_LABEL[data.treasure.rarity] || '';
  rarityBadge.className = `rarity-badge ${data.treasure.rarity}`;
  document.getElementById('treasureName').textContent = `${data.treasure.emoji} ${data.treasure.name}`;
  document.getElementById('treasureDetail').textContent = data.treasure.flavor || '';
  document.getElementById('resultBox').style.display = 'block';
  setGold(data.totalTreasure);

  updatePityUI(data.mythicPity, data.mythicPityLimit);
  checkAndTriggerLegendary(data.treasure, data.mythicPityTriggered);

  setTimeout(() => { chest.classList.remove('open'); }, 1500);
  refreshStatus();
}

const RARITY_LABEL = { common: '일반', rare: '희귀', epic: '영웅', legendary: '전설', mythic: '신화' };

document.getElementById('chest').addEventListener('click', async function(){
  if (cachedCharges < 1 || isOpening) return;
  isOpening = true;
  this.style.pointerEvents = 'none';

  try {
    const res = await authFetch('/api/box/open', { method: 'POST' });
    const data = await res.json();
    if (!res.ok){ refreshStatus(); return; }
    handleOpenSuccess(data);
  } catch (err) {
    refreshStatus();
  } finally {
    isOpening = false;
  }
});

document.getElementById('bulkOpenBtn').addEventListener('click', async function(){
  if (isOpening) return;
  const quantity = parseInt(document.getElementById('bulkOpenQty').value, 10);
  if (!quantity || quantity < 1) return;

  isOpening = true;
  this.disabled = true;
  const originalText = this.textContent;
  this.textContent = '여는 중...';

  try {
    const res = await authFetch('/api/box/bulk-open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity }),
    });
    const data = await res.json();
    if (!res.ok){ alert(data.message); return; }

    syncServerTime(data.serverTime);
    applyChargeInfo(data);
    setGold(data.totalTreasure);
    document.getElementById('rarityBadge').textContent = '';
    document.getElementById('treasureName').textContent = `📦 ${data.quantity}개 일괄 오픈`;
    document.getElementById('treasureDetail').textContent =
      data.obtained.map(o => `${o.emoji}${o.name} x${o.count}`).join(', ');
    document.getElementById('resultBox').style.display = 'block';

    updatePityUI(data.mythicPity, data.mythicPityLimit);
    checkAndTriggerLegendary(data.obtained, data.mythicPityTriggered);

    renderTick();
    refreshStatus();
  } catch (err) {
    // 네트워크 실패 시 다음 시도에 맡김
  } finally {
    isOpening = false;
    this.textContent = originalText;
    clampBulkOpenQty();
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
      else {
        const craftResult = document.getElementById('craftResult');
        craftResult.style.display = 'block';
        craftResult.style.color = 'var(--danger)';
        craftResult.textContent = data.message;
      }
    } else {
      const recordText = `기록: ${formatDuration(Math.floor(data.durationMs / 1000))} · 환생 포인트 +${data.prestigeGained} (보유 ${data.prestigePoints}개, 강화 → 환생 상점에서 사용)`;
      const msg = `✨ ${data.rebirthNumber}번째 환생! ${recordText}`;
      if (onMainScreen) {
        document.getElementById('rarityBadge').textContent = '';
        document.getElementById('treasureName').textContent = `✨ ${data.rebirthNumber}번째 환생 달성!`;
        document.getElementById('treasureDetail').textContent = recordText;
        document.getElementById('resultBox').style.display = 'block';
      } else {
        const craftResult = document.getElementById('craftResult');
        craftResult.style.display = 'block';
        craftResult.style.color = 'var(--gold)';
        craftResult.textContent = msg;
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
  const confirmed = confirm('정말 초심으로 돌아가시겠어요?\n지금 모은 골드·아이템·강화·자동화가 모두 사라지고, 다시 2000골드부터 시작합니다.\n(환생이 아니라서 기록과 환생 포인트는 생기지 않아요. 이미 가진 환생 포인트는 유지돼요)');
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
  collectionScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  refreshStatus();
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
    document.getElementById('collectionProgress').textContent = `${data.progress.obtained}/${data.progress.total}`;

    const claimBtn = document.getElementById('claimBonusBtn');
    if (data.isComplete && !data.bonusClaimed) claimBtn.classList.remove('hidden');
    else claimBtn.classList.add('hidden');

    if (data.collectorRank) renderCollectorRank(data.collectorRank);
    renderTick();

    // ── 수집모드 그리드: 평생 발견 기록 (전부 다 표시, 잠긴 건 ❔) ──
    collectionGrid.innerHTML = '';
    data.collection.forEach(item => {
      const card = document.createElement('div');
      card.className = `item-card ${item.rarity} ${item.obtained ? '' : 'locked'}`;
      card.title = item.obtained
        ? (item.firstDiscoveredAt ? `${item.flavor} (${new Date(item.firstDiscoveredAt).toLocaleDateString()} 발견)` : item.flavor)
        : '아직 발견하지 못한 아이템입니다';

      card.innerHTML = `
        <span class="item-emoji">${item.obtained ? item.emoji : '❔'}</span>
        <div class="item-name">${item.obtained ? item.name : '???'}</div>
        ${item.obtained ? `
          <div class="item-stars">${renderStars(item.stars, item.maxStars)}</div>
          <div class="item-next-star">${item.nextStarAt ? `다음 ★ ${item.count}/${item.nextStarAt}` : '★ 최대'}</div>
        ` : ''}
      `;
      collectionGrid.appendChild(card);
    });

    // ── 기록모드 그리드: 이번 판에 실제로 들고 있는 아이템만 (없으면 안내 문구) ──
    const heldItems = data.collection.filter(item => item.count > 0);
    if (heldItems.length === 0) {
      runGrid.innerHTML = '<p style="color:var(--ink-dim); font-size:13px; grid-column:1/-1; text-align:center; padding:20px 0;">이번 판에 모은 아이템이 아직 없어요.<br>상자를 열어보세요!</p>';
    } else {
      runGrid.innerHTML = '';
      heldItems.forEach(item => {
        const card = document.createElement('div');
        card.className = `item-card ${item.rarity}`;
        card.title = item.flavor;

        // 신화는 상자에서만 나오므로 전설도 합성 재료가 될 수 없음 (일반/희귀/영웅만 합성 가능)
        const isMaxRarity = item.rarity === 'mythic';
        const isCraftLocked = item.rarity === 'legendary' || isMaxRarity;
        const canCraft = item.count >= CRAFT_COST && !isCraftLocked;

        card.innerHTML = `
          <span class="item-emoji">${item.emoji}</span>
          <div class="item-name">${item.name}</div>
          <div class="item-count">x${item.count}</div>
          <div class="item-stars">${renderStars(item.stars, item.maxStars)}</div>
          ${item.incomePerMinute ? `<div class="item-income">분당 +${formatGold(item.incomePerMinute)}G</div>` : ''}
          <button class="craft-btn" data-key="${item.key}" ${canCraft ? '' : 'disabled'}>${isMaxRarity ? '최고 등급' : (isCraftLocked ? '합성 불가' : `합성(-${CRAFT_COST})`)}</button>
        `;
        runGrid.appendChild(card);
      });
    }

    runGrid.querySelectorAll('.craft-btn').forEach(btn => {
      btn.addEventListener('click', () => craftItem(btn.dataset.key, btn));
    });
  } catch (err) {
    collectionGrid.innerHTML = '<p style="color:var(--danger); font-size:13px;">불러오지 못했습니다.</p>';
  }
}

// 가방/도감 탭 전환 (기본은 가방)
function showBagTab(){
  document.getElementById('modeTabRun').classList.add('active');
  document.getElementById('modeTabCollection').classList.remove('active');
  document.getElementById('runModeView').classList.remove('hidden');
  document.getElementById('collectionModeView').classList.add('hidden');
}

// 상자 열기 패널 탭 (충전 / 골드 구매)
function showOpenTab(which){
  const isCharge = which === 'charge';
  document.getElementById('openTabCharge').classList.toggle('active', isCharge);
  document.getElementById('openTabGold').classList.toggle('active', !isCharge);
  document.getElementById('chargeOpenPanel').classList.toggle('hidden', !isCharge);
  document.getElementById('goldOpenPanel').classList.toggle('hidden', isCharge);
}
document.getElementById('openTabCharge').addEventListener('click', () => showOpenTab('charge'));
document.getElementById('openTabGold').addEventListener('click', () => showOpenTab('gold'));

// 메인 화면의 "도감 완료" 버튼: 도감을 다 채웠고 보상을 아직 안 받았을 때만 나타남
document.getElementById('mainClaimBonusBtn').addEventListener('click', async function(){
  this.disabled = true;
  try {
    const res = await authFetch('/api/box/collection/claim-bonus', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { alert(data.message); return; }
    document.getElementById('rarityBadge').textContent = '';
    document.getElementById('treasureName').textContent = `🎉 도감 완성! +${data.bonusGold}G`;
    document.getElementById('treasureDetail').textContent = '도감 완성 보상을 받았습니다';
    document.getElementById('resultBox').style.display = 'block';
    this.classList.add('hidden');
  } finally {
    this.disabled = false;
    refreshStatus();
  }
});

// 모드 탭 전환
document.getElementById('modeTabCollection').addEventListener('click', () => {
  document.getElementById('modeTabCollection').classList.add('active');
  document.getElementById('modeTabRun').classList.remove('active');
  document.getElementById('collectionModeView').classList.remove('hidden');
  document.getElementById('runModeView').classList.add('hidden');
});
document.getElementById('modeTabRun').addEventListener('click', () => {
  document.getElementById('modeTabRun').classList.add('active');
  document.getElementById('modeTabCollection').classList.remove('active');
  document.getElementById('runModeView').classList.remove('hidden');
  document.getElementById('collectionModeView').classList.add('hidden');
});

document.getElementById('claimBonusBtn').addEventListener('click', async function(){
  this.disabled = true;
  try {
    const res = await authFetch('/api/box/collection/claim-bonus', { method: 'POST' });
    const data = await res.json();
    const craftResult = document.getElementById('craftResult');
    craftResult.style.display = 'block';
    if (!res.ok) {
      craftResult.style.color = 'var(--danger)';
      craftResult.textContent = data.message;
    } else {
      craftResult.style.color = 'var(--gold)';
      craftResult.textContent = `🎉 도감 완성! +${data.bonusGold}G 획득!`;
    }
    await loadCollection(false);
    refreshStatus();
  } finally {
    this.disabled = false;
  }
});

document.getElementById('craftAllBtn').addEventListener('click', async function(){
  this.disabled = true;
  const originalText = this.textContent;
  this.textContent = '합성 중...';
  try {
    const res = await authFetch('/api/box/craft-all', { method: 'POST' });
    const data = await res.json();
    const craftResult = document.getElementById('craftResult');
    craftResult.style.display = 'block';
    if (!res.ok) {
      craftResult.style.color = 'var(--danger)';
      craftResult.textContent = data.message;
    } else if (data.totalCrafts === 0) {
      craftResult.style.color = 'var(--ink-dim)';
      craftResult.textContent = data.message;
    } else {
      craftResult.style.color = 'var(--gold)';
      const summary = data.results.map(r => {
        const obtainedText = r.obtained.map(o => `${o.emoji}${o.name}${o.count > 1 ? `x${o.count}` : ''}`).join(', ');
        return `${r.consumedName} ${r.craftCount}세트 → ${obtainedText}`;
      }).join(' / ');
      craftResult.textContent = `⚡ 총 ${data.totalCrafts}번 합성! (${summary})`;
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
    const craftResult = document.getElementById('craftResult');
    craftResult.style.display = 'block';
    if (!res.ok) {
      craftResult.style.color = 'var(--danger)';
      craftResult.textContent = data.message;
    } else {
      craftResult.style.color = 'var(--ink)';
      craftResult.innerHTML = `${data.consumed.name} x${data.consumed.amount} <span class="arrow">→</span> ${data.result.emoji} ${data.result.name} 획득!`;
    }
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
      return `<div style="padding:4px 0; border-bottom:1px solid #22335C;">#${h.rebirthNumber} — ${formatDuration(Math.floor(h.durationMs / 1000))} (${date})</div>`;
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
  upgradeScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  refreshStatus();
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

  const autoList = document.getElementById('automationList');
  autoList.innerHTML = '';

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
      <div class="shop-desc">사둔 시간 동안 충전되는 상자를 자동으로 열어요 · 최대 ${formatHoursText(ao.maxMs)}(보관 시간)까지</div>
      <div class="time-bar-wrap"><div class="time-bar-fill" id="autoOpenBar"></div></div>
    </div>
    <div class="shop-actions">
      <button class="shop-btn shop-btn-stack" data-autoopen="1" data-cost="${spaceMs >= 3600000 ? ao.costPerHour : ''}" ${spaceMs >= 3600000 ? '' : 'disabled'}>
        <span>+1시간</span><small>${formatGold(ao.costPerHour)}G</small>
      </button>
      <button class="shop-btn shop-btn-stack" data-autoopen="max" data-cost="${spaceMs > 0 ? fillCost : ''}" ${spaceMs > 0 ? '' : 'disabled'}>
        <span>가득 채우기</span><small>${spaceMs > 0 ? `${formatGold(fillCost)}G` : '꽉 찼어요'}</small>
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
      ? `지금 환생하면 +${p.pointsOnRebirth}개 · 이번 판 ${formatGold(p.runGoldEarned)}G 벌었어요`
      : `이번 판 ${formatGold(p.runGoldEarned)} / ${formatGold(p.nextPointAt)}G 벌면 첫 포인트를 받아요`;
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
function applyGoldenBox(box){
  if (!box) return;
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
    document.getElementById('goldenBoxTimer').textContent = `${secondsLeft}초 안에 눌러요`;
  }
}

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
  achievementScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  refreshStatus();
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
  currentRankPage = 1;
  await loadRanking();
});
document.getElementById('backFromRankingBtn').addEventListener('click', () => {
  rankingScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
});
document.getElementById('rankPrevBtn').addEventListener('click', async () => {
  if (currentRankPage > 1) { currentRankPage--; await loadRanking(); }
});
document.getElementById('rankNextBtn').addEventListener('click', async () => {
  currentRankPage++;
  await loadRanking();
});

// 서버에서 받은 문자열(닉네임 등)을 innerHTML에 넣을 때는 반드시 이스케이프합니다. (저장형 XSS 방지)
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function renderRankRow(rank, nickname, ms, isMe){
  return `
    <div class="rank-row ${isMe ? 'me' : ''}">
      <span class="rank-num">#${rank}</span>
      <span class="rank-name">${escapeHtml(nickname)}${isMe ? ' (나)' : ''}</span>
      <span class="rank-time">${formatDuration(Math.floor(ms / 1000))}</span>
    </div>
  `;
}
function renderEmptyRankRow(){
  return `<div class="rank-row empty"><span class="rank-num"></span><span class="rank-name">-</span><span class="rank-time">--:--:--</span></div>`;
}

async function loadRanking(){
  const listEl = document.getElementById('rankingList');
  const footerEl = document.getElementById('myRankFooter');
  const paginationEl = document.getElementById('rankPagination');
  listEl.innerHTML = '<p style="color:var(--ink-dim); font-size:13px;">불러오는 중...</p>';
  footerEl.classList.add('hidden');
  paginationEl.classList.add('hidden');

  try {
    const res = await authFetch(`/api/box/leaderboard?page=${currentRankPage}`);
    const data = await res.json();
    if (!res.ok) {
      listEl.innerHTML = '<p style="color:var(--danger); font-size:13px;">불러오지 못했습니다.</p>';
      return;
    }

    if (data.totalPlayers === 0) {
      listEl.innerHTML = '<p style="color:var(--ink-dim); font-size:13px; text-align:center; padding:20px 0;">아직 환생 기록이 없습니다.<br>첫 기록의 주인공이 되어보세요!</p>';
      return;
    }

    // 항상 RANK_PAGE_SIZE칸의 틀을 유지: 부족한 줄은 빈 자리로 채움
    let html = data.leaderboard.map(r => renderRankRow(r.rank, r.nickname, r.bestDurationMs, r.isMe)).join('');
    for (let i = data.leaderboard.length; i < RANK_PAGE_SIZE; i++) {
      html += renderEmptyRankRow();
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
        renderRankRow(data.myRank.rank, '나', data.myRank.bestDurationMs, true);
    } else if (!data.myRank) {
      footerEl.classList.remove('hidden');
      footerEl.innerHTML = `<p style="text-align:center; font-size:12px; color:var(--ink-dim);">아직 환생 기록이 없어 순위에 없습니다.</p>`;
    }
  } catch (err) {
    listEl.innerHTML = '<p style="color:var(--danger); font-size:13px;">불러오지 못했습니다.</p>';
  }
}
