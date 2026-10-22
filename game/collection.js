// game/collection.js
// 수집모드 전용 성장 요소: 세트 효과 · 신화 각성/조각 · 일일 미션
//
// [세트 효과] 신화 도감(영구)을 기준으로 계산합니다.
//   - 모티프 세트: 같은 모양(예: 나침반)의 신화 4종을 모두 모으면 → 전체 수입 +3%  (25세트)
//   - 테마 세트: 같은 색 테마(예: 서리)의 신화를 모두 모으면 → 테마마다 다른 보너스  (10세트)
// [각성] 도감에 있는 신화를 신화 조각으로 ★1~★5까지 올립니다. ★ 하나마다 전체 수입 +1%.
// [신화 조각] 효과가 겹치는 개수(3개)를 넘는 중복 신화를 분해해서 얻거나, 일일 미션 보상으로 받습니다.
// [일일 미션] 자동 개봉·자동 합성으로는 채워지지 않는, 직접 해야 하는 행동만 셉니다.
//
// 보너스는 아이템 효과 최대치(EFFECT_TYPE_CAPS)와 별개로 더해집니다. (오늘의 규칙과 같은 방식)

const { MYTHICS, MYTHIC_EFFECT_STACK } = require('./mythics');

const MOTIF_SET_INCOME_PERCENT = 3;

const THEME_SETS = {
  frost:   { name: '서리',   emoji: '❄️', bonus: { type: 'chargeSpeed', value: 5 } },
  storm:   { name: '폭풍',   emoji: '⚡', bonus: { type: 'luck', value: 5 } },
  tide:    { name: '조수',   emoji: '🌊', bonus: { type: 'storageMinutes', value: 60 } },
  gold:    { name: '황금',   emoji: '🪙', bonus: { type: 'golden', value: 30 } },
  galaxy:  { name: '은하',   emoji: '🌌', bonus: { type: 'pity', value: 200 } },
  flame:   { name: '불꽃',   emoji: '🔥', bonus: { type: 'incomePercent', value: 15 } },
  blossom: { name: '꽃',     emoji: '🌸', bonus: { type: 'autoOpenDiscount', value: 10 } },
  verdant: { name: '신록',   emoji: '🌿', bonus: { type: 'upgradeDiscount', value: 5 } },
  shadow:  { name: '그림자', emoji: '🌑', bonus: { type: 'boxDiscount', value: 5 } },
  abyss:   { name: '심연',   emoji: '🕳️', bonus: { type: 'incomePercent', value: 15 } },
};

// 모티프(모양) 한글 이름: 같은 모티프 4종 중 첫 신화 이름의 마지막 단어를 씁니다. (예: '서리 별의 나침반' → '나침반')
const MOTIF_NAMES = {};
for (const m of MYTHICS) if (!MOTIF_NAMES[m.motif]) MOTIF_NAMES[m.motif] = m.name.split(' ').pop();

const AWAKEN_MAX = 5;
const AWAKEN_COSTS = [10, 20, 40, 80, 150];      // ★0→1, 1→2, ... 4→5 에 드는 조각
const AWAKEN_INCOME_PERCENT = 1;                 // ★ 하나마다 전체 수입 +%
const DISMANTLE_SHARDS_BY_TIER = { 1: 10, 2: 12, 3: 15, 4: 20 }; // 중복 신화 1개 분해 시 조각
const CHOICE_BOX_SHARD_PRICE = 200;              // 조각 상점: 신화 선택 상자

const MYTHIC_BY_KEY = Object.fromEntries(MYTHICS.map(m => [m.key, m]));

function awakenLevel(awaken, key) {
  return Math.max(0, Math.min(AWAKEN_MAX, Number((awaken || {})[key]) || 0));
}

// 도감(Set)과 각성 기록으로 세트 진행도와 보너스 효과를 계산합니다.
function getCollectionBonus(codex, awaken = {}) {
  const effects = {};
  const add = (type, value) => { effects[type] = (effects[type] || 0) + value; };

  const motifs = {};
  const themes = {};
  for (const m of MYTHICS) {
    (motifs[m.motif] = motifs[m.motif] || { key: m.motif, name: MOTIF_NAMES[m.motif], emoji: m.emoji, have: 0, total: 0 });
    (themes[m.theme] = themes[m.theme] || { key: m.theme, ...THEME_SETS[m.theme], have: 0, total: 0 });
    motifs[m.motif].total++;
    themes[m.theme].total++;
    if (codex.has(m.key)) { motifs[m.motif].have++; themes[m.theme].have++; }
  }
  const motifList = Object.values(motifs).map(s => ({ ...s, complete: s.have === s.total }));
  const themeList = Object.values(themes).map(s => ({ ...s, complete: s.have === s.total }));

  const motifComplete = motifList.filter(s => s.complete).length;
  if (motifComplete > 0) add('incomePercent', motifComplete * MOTIF_SET_INCOME_PERCENT);
  for (const t of themeList) if (t.complete) add(t.bonus.type, t.bonus.value);

  let stars = 0;
  for (const key of Object.keys(awaken || {})) if (MYTHIC_BY_KEY[key] && codex.has(key)) stars += awakenLevel(awaken, key);
  if (stars > 0) add('incomePercent', stars * AWAKEN_INCOME_PERCENT);

  return { effects, motifs: motifList, themes: themeList, motifComplete, themeComplete: themeList.filter(t => t.complete).length, stars };
}

// 효과가 겹치는 개수(3개)를 넘는 신화 = 분해할 수 있는 중복
function getDismantlable(owned) {
  const list = [];
  for (const m of MYTHICS) {
    const extra = (owned[m.key] || 0) - MYTHIC_EFFECT_STACK;
    if (extra > 0) list.push({ key: m.key, count: extra, shards: extra * DISMANTLE_SHARDS_BY_TIER[m.tier] });
  }
  return { list, count: list.reduce((s, x) => s + x.count, 0), shards: list.reduce((s, x) => s + x.shards, 0) };
}

// -------------------------------
// 일일 미션 (매일 오전 9시에 바뀜, 수집모드 전용)
// 자동 개봉·자동 합성으로는 채워지지 않는 "직접 하는 행동"만 셉니다.
// -------------------------------
const MISSION_POOL = [
  { key: 'golden',   emoji: '🎁', text: '황금 상자 {goal}번 터치',        goal: 3,  shards: 15 },
  { key: 'tapOpen',  emoji: '📦', text: '상자를 눌러 직접 열기 {goal}번', goal: 5,  shards: 10 },
  // 합성: 직접 합성 + 접속 중에 일어난 자동 합성 (자리 비운 동안의 자동 합성은 제외)
  { key: 'craft',    emoji: '⚙️', text: '합성 {goal}번 (접속 중)',        goal: 15, shards: 10 },
  { key: 'buy',      emoji: '💰', text: '골드로 상자 구매 {goal}번',      goal: 3,  shards: 10 },
  { key: 'guestbook', emoji: '💬', text: '방명록에 한마디 {goal}번',      goal: 1,  shards: 10 },
];
const MISSIONS_PER_DAY = 3;
const MISSION_ALL_CLEAR_SHARDS = 20;

// 그날의 미션 3개: 날짜로 정해지므로 모두 같은 미션을 받습니다. 황금 상자 미션은 매일 포함.
function getDailyMissions(day) {
  const others = MISSION_POOL.filter(m => m.key !== 'golden');
  const start = ((day % others.length) + others.length) % others.length;
  const picked = [MISSION_POOL[0]];
  for (let i = 0; picked.length < MISSIONS_PER_DAY; i++) picked.push(others[(start + i) % others.length]);
  return picked.map(m => ({ ...m, text: m.text.replace('{goal}', m.goal) }));
}

// 저장된 미션 진행(JSONB)을 오늘 날짜 기준으로 정리합니다. 날짜가 바뀌었으면 비웁니다.
function normalizeMissionState(state, day) {
  if (!state || state.day !== day) return { day, progress: {}, claimed: {} };
  return { day, progress: state.progress || {}, claimed: state.claimed || {} };
}

module.exports = {
  MOTIF_SET_INCOME_PERCENT,
  THEME_SETS,
  AWAKEN_MAX,
  AWAKEN_COSTS,
  AWAKEN_INCOME_PERCENT,
  DISMANTLE_SHARDS_BY_TIER,
  CHOICE_BOX_SHARD_PRICE,
  MISSION_ALL_CLEAR_SHARDS,
  MYTHIC_BY_KEY,
  awakenLevel,
  getCollectionBonus,
  getDismantlable,
  getDailyMissions,
  normalizeMissionState,
};
