// game/store.js
// 게임 데이터(box_claims, user_items, user_discoveries)를 읽고 쓰는 DB 함수 모음입니다.
// 모든 함수는 첫 인자로 runner를 받습니다. 트랜잭션 안이라면 client를, 아니라면 db를 넘기면 됩니다.
// (FOR UPDATE를 쓰는 함수는 반드시 BEGIN된 트랜잭션의 client를 넘겨야 합니다.)
//
// [정산(settle) 방식]
// 이 게임은 서버가 계속 돌면서 골드를 넣어주는 게 아니라, 요청이 올 때마다
// "마지막 정산 이후 흐른 시간"만큼 골드·충전·자동 개봉·자동 합성을 한 번에 계산해서 반영합니다.
// 그래서 모든 API는 일을 하기 전에 settle()을 먼저 호출해서 세이브를 "지금 시각" 기준으로 맞춥니다.

const {
  DEFAULT_MODE,
  MODES,
  BASE_INCOME_PER_MINUTE,
  INCOME_PER_MINUTE_BY_RARITY,
  MASTERY_THRESHOLDS,
  MASTERY_INCOME_BONUS_PERCENT_PER_STAR,
  MAX_AUTO_OPEN_PER_SYNC,
  RESET_GOLD,
  TREASURES,
  PERK_START_GOLD,
  PERK_START_AUTO_OPEN_MS,
  INCOME_BOOST_MULTIPLIER,
  TREASURE_BY_KEY,
  SEASON_RESET_PRESTIGE,
  PRESTIGE_LEFTOVER_SHARDS_PER_POINT,
  REBIRTH_GOLD_REQUIRED,
  SPLIT_STEPS,
} = require('./config');
const { getCollectionBonus, normalizeMissionState, getMilestones } = require('./collection');
// 이 간격 안에 다시 동기화했으면 "접속 중"으로 봅니다 (화면은 15초마다 동기화)
const ONLINE_MISSION_GAP_MS = 2 * 60 * 1000;
const { getItemStars, getClaimStats, getPerkLevel, rollBoxes, craftCascade, makeRollContext, getDailyRule } = require('./logic');
const { MYTHICS } = require('./mythics');
const { getSeason, getDay, getRotation } = require('./season');

// box_claims에서 게임 진행에 필요한 컬럼 전체
const CLAIM_COLUMNS = [
  'total_treasure', 'box_charges', 'last_charge_calculated_at', 'last_income_collected_at',
  'mythic_pity', 'rebirth_count', 'run_started_at',
  'upgrade_income', 'upgrade_charge_speed', 'upgrade_capacity', 'upgrade_luck', 'upgrade_research',
  'auto_open_enabled', 'auto_open_remaining_ms', 'auto_craft_unlocked', 'auto_craft_enabled',
  'prestige_points', 'prestige_perks', 'run_gold_earned', 'last_active_at',
  'golden_box_next_at', 'income_boost_until', 'lifetime_stats', 'achievements_claimed',
  'locked_items', 'season', 'run_splits', 'best_splits', 'best_run_ms', 'sealed_mythics',
  'mythic_choice_boxes', 'collector_rank_rewarded',
  'mythic_shards', 'mythic_awaken', 'daily_missions',
  'skill_cooldowns', 'skill_buffs',
];
const MYTHIC_KEYS = MYTHICS.map(m => m.key);

// 잠금(🔒)된 아이템 key 목록 → Set
function lockedSet(claim) {
  return new Set(Array.isArray(claim.locked_items) ? claim.locked_items : []);
}

// 이 요청 시점에 유저가 어떤 모드(기록/수집)를 쓰고 있는지 확인합니다.
async function getActiveMode(runner, userId) {
  const result = await runner.query('SELECT active_mode FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.active_mode || DEFAULT_MODE;
}

// 현재 모드의 box_claims 한 줄을 읽어옵니다. 없으면 null.
// columns는 코드 안에서 고정된 컬럼 목록만 넘겨야 합니다 (사용자 입력 금지).
async function getClaim(runner, userId, mode, columns = CLAIM_COLUMNS, { forUpdate = false } = {}) {
  const result = await runner.query(
    `SELECT ${columns.join(', ')} FROM box_claims WHERE user_id = $1 AND mode = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId, mode]
  );
  return result.rows[0] || null;
}

// box_claims의 여러 컬럼을 한 번에 업데이트합니다. fields의 key는 코드에서 정한 컬럼명만 사용합니다.
async function updateClaim(runner, userId, mode, fields) {
  const columns = Object.keys(fields);
  if (columns.length === 0) return;
  const sets = columns.map((col, i) => `${col} = $${i + 3}`).join(', ');
  await runner.query(
    `UPDATE box_claims SET ${sets} WHERE user_id = $1 AND mode = $2`,
    [userId, mode, ...columns.map(col => fields[col])]
  );
}

// 보유 아이템 개수를 { itemKey: 개수 } 형태로 읽어옵니다.
async function getOwnedCounts(runner, userId, mode, { forUpdate = false } = {}) {
  const result = await runner.query(
    `SELECT item_key, count FROM user_items WHERE user_id = $1 AND mode = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId, mode]
  );
  const counts = {};
  result.rows.forEach(row => { counts[row.item_key] = parseInt(row.count, 10); });
  return counts;
}

// 보유 아이템과 업그레이드/환생 포인트를 반영해서 분당 골드 수입을 계산합니다.
// - 아이템마다 자기 보유 개수에 맞는 ★ 보너스를 받고 (★당 +10%)
// - 전체 합계에 수입 업그레이드, 환생 특성, 신화(전체 수입 효과 + 신화 도감 보너스) 배율이 곱해집니다.
// 모든 값은 정수로 내림합니다.
function computeIncome(ownedCounts, claim) {
  const stats = getClaimStats(claim, ownedCounts);
  const items = [];
  let itemIncome = 0;

  for (const treasure of TREASURES) {
    const count = ownedCounts[treasure.key] || 0;
    if (count === 0) continue;

    const stars = getItemStars(count);
    const bonusPercent = 100 + stars * MASTERY_INCOME_BONUS_PERCENT_PER_STAR;
    const income = Math.floor(count * INCOME_PER_MINUTE_BY_RARITY[treasure.rarity] * bonusPercent / 100);
    itemIncome += income;
    items.push({
      key: treasure.key,
      name: treasure.name,
      emoji: treasure.emoji,
      rarity: treasure.rarity,
      count,
      stars,
      maxStars: MASTERY_THRESHOLDS.length,
      incomePerMinute: income,
    });
  }

  const baseTotal = BASE_INCOME_PER_MINUTE + itemIncome;
  const perMinuteIncome = Math.floor(
    baseTotal * stats.upgradeIncomePercent * stats.prestigeIncomePercent * stats.itemIncomePercent / 1000000
  );

  return {
    perMinuteIncome,
    baseIncome: BASE_INCOME_PER_MINUTE,
    itemIncome,
    upgradeBonusPercent: stats.upgradeIncomePercent - 100,
    prestigeBonusPercent: stats.prestigeIncomePercent - 100,
    mythicBonusPercent: stats.mythicIncomePercent,
    items, // 아이템별 개수/★/수입 상세 (가방·도감 화면 표시용)
  };
}

// -------------------------------
// 누적 기록 (업적용, 환생해도 사라지지 않음)
// -------------------------------
// lifetime_stats JSONB: { boxes, crafts, legendary, mythic, golden, bestIncome }

// 얻은 아이템 묶음({ itemKey: 개수 })에서 전설/신화 개수를 셉니다.
function countRareGains(counts) {
  let legendary = 0;
  let mythic = 0;
  for (const [key, amount] of Object.entries(counts)) {
    if (amount <= 0) continue;
    const rarity = TREASURE_BY_KEY.get(key)?.rarity;
    if (rarity === 'legendary') legendary += amount;
    if (rarity === 'mythic') mythic += amount;
  }
  return { legendary, mythic };
}

// 메모리의 claim.lifetime_stats에 증가분을 더하고, 새 객체를 돌려줍니다.
function bumpStats(claim, deltas) {
  const stats = { ...(claim.lifetime_stats || {}) };
  for (const [key, amount] of Object.entries(deltas)) {
    if (!amount) continue;
    stats[key] = (Number(stats[key]) || 0) + amount;
  }
  claim.lifetime_stats = stats;
  return stats;
}

// 증가분을 더해서 DB에도 저장합니다. (claim은 이미 FOR UPDATE로 잠근 세이브여야 합니다)
async function saveStats(client, userId, mode, claim, deltas) {
  const stats = bumpStats(claim, deltas);
  await updateClaim(client, userId, mode, { lifetime_stats: JSON.stringify(stats) });
}

// 상자를 열어서 얻은 아이템 묶음에 대한 기록 증가분
function boxStatDeltas(boxCount, counts) {
  return { boxes: boxCount, ...countRareGains(counts) };
}

// 얻은(또는 합성으로 소모한) 아이템을 user_items에 반영하고, 새로 얻은 아이템은 발견 기록도 남깁니다.
// deltas는 { itemKey: 증감 } 형태입니다 (음수 = 소모). 아이템 종류가 많아도 쿼리는 두 번만 실행됩니다.
// 발견 기록은
// - 기록모드: 이번 판 한정이라, 환생/초심으로 돌아가면 지워집니다.
// - 수집모드: 절대 지워지지 않는 영구 기록입니다.
// 같은 아이템을 또 발견해도 딱 한 번만 기록됩니다 (최초 발견일만 남김).
async function addItems(client, userId, mode, deltas) {
  const gainedKeys = Object.keys(deltas).filter(key => deltas[key] > 0);
  const spentKeys = Object.keys(deltas).filter(key => deltas[key] < 0);

  // 소모(음수)는 이미 가진 아이템의 개수만 줄이는 UPDATE로 따로 처리합니다.
  // INSERT ... ON CONFLICT에 음수를 넣으면, 충돌로 UPDATE가 되더라도 DB가 "넣으려던 값"(음수)을
  // 먼저 검사해서 count >= 0 같은 제약에 걸리기 때문입니다.
  if (spentKeys.length > 0) {
    await client.query(
      `UPDATE user_items SET count = user_items.count + t.amount
       FROM unnest($3::text[], $4::int[]) AS t(item_key, amount)
       WHERE user_items.user_id = $1 AND user_items.mode = $2 AND user_items.item_key = t.item_key`,
      [userId, mode, spentKeys, spentKeys.map(key => deltas[key])]
    );
  }

  if (gainedKeys.length === 0) return;
  await client.query(
    `INSERT INTO user_items (user_id, mode, item_key, count, first_obtained_at)
     SELECT $1, $2, t.item_key, t.amount, NOW()
     FROM unnest($3::text[], $4::int[]) AS t(item_key, amount)
     ON CONFLICT (user_id, mode, item_key)
     DO UPDATE SET count = user_items.count + EXCLUDED.count`,
    [userId, mode, gainedKeys, gainedKeys.map(key => deltas[key])]
  );
  await client.query(
    `INSERT INTO user_discoveries (user_id, mode, item_key, first_discovered_at)
     SELECT $1, $2, t.item_key, NOW()
     FROM unnest($3::text[]) AS t(item_key)
     ON CONFLICT (user_id, mode, item_key) DO NOTHING`,
    [userId, mode, gainedKeys]
  );
}

// 아직 열지 않은 신화 상자 목록 [{ key, at, pity }]
function sealedList(claim) {
  return Array.isArray(claim && claim.sealed_mythics) ? claim.sealed_mythics : [];
}

// 신화 도감: 수집모드에서 한 번이라도 얻은 신화 key Set
// 수집모드의 발견 기록(user_discoveries)은 절대 지워지지 않으므로 그대로 신화 도감이 됩니다.
// (기록모드에서 얻은 신화는 도감에 남지 않습니다)
async function getCodexKeys(runner, userId) {
  const result = await runner.query(
    `SELECT item_key FROM user_discoveries WHERE user_id = $1 AND mode = $2 AND item_key = ANY($3::text[])`,
    [userId, MODES.COLLECTION, MYTHIC_KEYS]
  );
  return new Set(result.rows.map(r => r.item_key));
}

// 상자 뽑기 조건 (행운·천장·이번 시즌 신화 묶음·이미 가져본 신화)
// 천장은 아직 없는 이번 시즌 신화를 우선으로 줍니다. (수집모드: 신화 도감 기준 / 기록모드: 이번 판 가방 기준)
function rollContextOf(save) {
  const have = new Set(save.codex);
  // 아직 열지 않은 신화 상자에 든 신화도 "가진 것"으로 칩니다. (천장이 같은 걸 또 주지 않도록)
  for (const sealed of sealedList(save.claim)) have.add(sealed.key);
  for (const [key, count] of Object.entries(save.owned)) {
    if (count > 0 && TREASURE_BY_KEY.get(key)?.rarity === 'mythic') have.add(key);
  }
  return makeRollContext({
    luckPercent: save.stats.luckPercent,
    pityLimit: save.stats.pityLimit,
    rotation: save.rotation,
    have,
  });
}

// 새 시즌 적용. 시즌이 바뀐 뒤 처음 정산할 때 한 번만 실행됩니다.
// - 기록모드: 세이브를 처음부터 다시 시작합니다. (SEASON_RESET_PRESTIGE면 환생 포인트·특성·업적·기록까지)
//   지난 시즌 랭킹 기록(rebirth_history)은 그대로 남아서 랭킹 화면에서 볼 수 있습니다.
// - 수집모드: 아무것도 지우지 않습니다. (이번 주 신화·규칙만 바뀜)
async function applyNewSeason(client, userId, mode, claim, season, now) {
  if (mode !== MODES.RECORD) {
    await updateClaim(client, userId, mode, { season });
    return null;
  }
  // 남은 환생 포인트는 사라지기 전에 수집모드 신화 조각으로 바꿔 줍니다.
  let convertedShards = 0;
  const leftover = Number(claim.prestige_points) || 0;
  if (SEASON_RESET_PRESTIGE && leftover > 0) {
    convertedShards = leftover * PRESTIGE_LEFTOVER_SHARDS_PER_POINT;
    await client.query(
      `UPDATE box_claims SET mythic_shards = mythic_shards + $2 WHERE user_id = $1 AND mode = 'collection'`,
      [userId, convertedShards]
    );
  }
  const keepClaim = SEASON_RESET_PRESTIGE ? {} : claim;
  await resetSave(client, userId, mode, now, { claim: keepClaim });
  // 시즌 최고 기록(구간 기록 비교용)도 새 시즌에 맞춰 비웁니다.
  const fields = { season, golden_box_next_at: null, income_boost_until: null, best_splits: '[]', best_run_ms: null };
  if (SEASON_RESET_PRESTIGE) {
    Object.assign(fields, {
      prestige_points: 0,
      prestige_perks: '{}',
      rebirth_count: 0,
      achievements_claimed: '{}',
      lifetime_stats: '{}',
      locked_items: '[]',
    });
  }
  await updateClaim(client, userId, mode, fields);
  return { convertedShards, leftoverPoints: leftover };
}

// 구간 기록: 지금 골드로 새로 넘은 구간이 있으면 경과 시간을 더한 배열을, 없으면 null을 돌려줍니다.
// 구간 k(1~9) = 환생 목표의 k×10%. 마지막(100%) 구간은 환생할 때 기록합니다.
function updateRunSplits(claim, gold, now) {
  const splits = Array.isArray(claim.run_splits) ? [...claim.run_splits] : [];
  const elapsed = Math.max(0, now - new Date(claim.run_started_at));
  let changed = false;
  while (splits.length < SPLIT_STEPS - 1 && gold >= REBIRTH_GOLD_REQUIRED * (splits.length + 1) / SPLIT_STEPS) {
    splits.push(elapsed);
    changed = true;
  }
  return changed ? splits : null;
}

// 세이브를 "지금 시각" 기준으로 정산합니다. (동시 요청 안전성을 위해 FOR UPDATE 사용)
// 1. 마지막 정산 이후 쌓인 골드를 지급
// 2. 흐른 시간만큼 충전을 채우고, 자동 개봉 시간이 남아 있으면 그동안 충전된 상자를 열기
// 3. 자동 합성이 켜져 있으면 가능한 만큼 합성
// 흐른 시간은 창고의 보관 시간까지만 인정합니다. (오래 비우면 그 뒤로는 쌓이지 않음)
// 세이브가 없으면 null을 돌려줍니다.
async function settle(client, userId, mode) {
  let claim = await getClaim(client, userId, mode, CLAIM_COLUMNS, { forUpdate: true });
  if (!claim) return null;

  const now = new Date();
  // 0. 시즌이 바뀌었으면 새 시즌을 먼저 적용합니다.
  const season = getSeason(now);
  // 신화 10종과 규칙은 매일 바뀝니다.
  const day = getDay(now);
  const rotation = getRotation(day);
  let seasonChange = null;
  if ((Number(claim.season) || 0) < season) {
    seasonChange = { from: Number(claim.season) || null, to: season, reset: mode === MODES.RECORD };
    const converted = await applyNewSeason(client, userId, mode, claim, season, now);
    if (converted && converted.convertedShards > 0) Object.assign(seasonChange, converted);
    claim = await getClaim(client, userId, mode, CLAIM_COLUMNS, { forUpdate: true });
  }
  // 신화 도감은 수집모드에서만 씁니다. (천장이 도감에 없는 신화를 먼저 주는 데 사용)
  const codex = mode === MODES.COLLECTION ? await getCodexKeys(client, userId) : new Set();
  claim.season_rule = getDailyRule(day);
  // 수집모드: 세트 효과·각성 보너스 (DB 컬럼이 아니라 능력치 계산용으로 붙여 둠)
  claim.collection_bonus = mode === MODES.COLLECTION ? getCollectionBonus(codex, claim.mythic_awaken).effects : null;
  // 수집모드: 도감 마일스톤 (최대 충전 +20 등)
  const milestones = mode === MODES.COLLECTION ? getMilestones(codex.size) : null;
  claim.milestone_max_charges = milestones ? milestones.maxChargesBonus : 0;

  let owned = await getOwnedCounts(client, userId, mode, { forUpdate: true });
  // 능력치(보관 시간·행운·천장 등)는 정산 시작 시점의 보유 아이템 기준으로 계산합니다.
  const stats = getClaimStats(claim, owned);
  const itemDeltas = {};
  const statDeltas = {};
  const addStats = (deltas) => {
    for (const [key, amount] of Object.entries(deltas)) statDeltas[key] = (statDeltas[key] || 0) + amount;
  };
  const applyDeltas = (deltas) => {
    for (const [key, amount] of Object.entries(deltas)) {
      itemDeltas[key] = (itemDeltas[key] || 0) + amount;
      owned[key] = (owned[key] || 0) + amount;
    }
  };

  // 1. 골드: 지금까지 들고 있던 아이템 기준으로 계산 (이번 정산에서 새로 얻은 아이템은 다음 정산부터 반영)
  const income = computeIncome(owned, claim);
  const lastCollected = new Date(claim.last_income_collected_at);
  const incomeElapsedMs = Math.max(0, now - lastCollected);
  const storageCapped = incomeElapsedMs > stats.storageMs;
  const countedIncomeMs = Math.min(incomeElapsedMs, stats.storageMs);
  // 수입 2배 버프: 버프가 걸려 있던 구간만큼 한 번 더 셉니다.
  const boostUntil = claim.income_boost_until ? new Date(claim.income_boost_until) : null;
  const boostedMs = boostUntil
    ? Math.min(countedIncomeMs, Math.max(0, Math.min(now, boostUntil) - lastCollected)) * (INCOME_BOOST_MULTIPLIER - 1)
    : 0;
  const earned = Math.floor((countedIncomeMs + boostedMs) / 1000 * income.perMinuteIncome / 60);
  const gold = parseInt(claim.total_treasure, 10) + earned;
  const runGoldEarned = parseInt(claim.run_gold_earned, 10) + earned;

  // 2. 충전 (+ 자동 개봉)
  const lastCalc = new Date(claim.last_charge_calculated_at);
  const chargeElapsedMs = Math.max(0, now - lastCalc);
  const countedMs = Math.min(chargeElapsedMs, stats.storageMs);
  const gained = Math.floor(countedMs / stats.chargeIntervalMs);

  let charges = claim.box_charges;
  let pity = claim.mythic_pity;
  let autoOpenRemainingMs = Number(claim.auto_open_remaining_ms);
  let autoOpened = null;
  const newSealed = [];

  const autoActive = claim.auto_open_enabled && autoOpenRemainingMs > 0;
  if (autoActive) {
    // 자동 개봉 시간이 남아 있는 구간에 충전된 상자(+이미 쌓여 있던 상자)를 엽니다.
    // 시간이 중간에 다 떨어졌다면, 그 뒤로 충전된 상자는 평소처럼 쌓입니다.
    // 자동 개봉 시간은 "직전 정산 이후" 흐른 시간만큼만 씁니다.
    // (충전 타이머 기준으로 재면, 직전 정산 때 이미 쓴 자투리 시간이 매번 또 깎입니다)
    const sinceLastSettleMs = Math.min(Math.max(0, now - lastCollected), stats.storageMs);
    const autoMs = Math.min(sinceLastSettleMs, autoOpenRemainingMs);
    // 이번에 새로 쌓인 충전 중, 자동 개봉 시간이 남아 있던 구간에 들어온 것만 자동으로 엽니다.
    // 보관 시간을 넘겼다면 인정되는 구간(마지막 보관 시간만큼)의 시작점을 기준으로 셉니다.
    const capped = chargeElapsedMs > stats.storageMs;
    const tickBase = capped ? now.getTime() - countedMs : lastCalc.getTime();
    const autoStart = capped ? tickBase : lastCollected.getTime();
    const autoGained = Math.min(gained, Math.max(0, Math.floor((autoStart + autoMs - tickBase) / stats.chargeIntervalMs)));
    const toOpen = Math.min(MAX_AUTO_OPEN_PER_SYNC, charges + autoGained);
    autoOpenRemainingMs -= autoMs;
    charges = Math.min(stats.maxCharges, gained - autoGained);
    if (toOpen > 0) {
      const rolled = rollBoxes(pity, toOpen, rollContextOf({ codex, owned, stats, rotation, claim }));
      pity = rolled.pity;
      // 신화는 바로 주지 않고 🔮 신화 상자에 담아 둡니다. (내용물은 지금 정해짐, 유효기간 없음)
      // 돌아온 유저가 직접 눌러서 열면 그때 가방·도감에 들어갑니다. (POST /open-sealed)
      const normalCounts = {};
      for (const [key, amount] of Object.entries(rolled.counts)) {
        if (TREASURE_BY_KEY.get(key)?.rarity === 'mythic') {
          for (let i = 0; i < amount; i++) newSealed.push({ key, at: now.toISOString(), pity: rolled.pityTriggered });
        } else {
          normalCounts[key] = amount;
        }
      }
      applyDeltas(normalCounts);
      addStats(boxStatDeltas(toOpen, normalCounts));
      autoOpened = { count: toOpen, counts: normalCounts, pityTriggered: rolled.pityTriggered, sealed: newSealed.length };
    }
  } else {
    charges = Math.min(stats.maxCharges, charges + gained);
  }

  const stillAuto = claim.auto_open_enabled && autoOpenRemainingMs > 0;
  // 보관 시간을 넘겼거나 충전이 꽉 찬 상태라면 타이머를 지금부터 다시 시작합니다.
  const newLastCalc = (chargeElapsedMs > stats.storageMs || (!stillAuto && charges >= stats.maxCharges))
    ? now
    : new Date(lastCalc.getTime() + gained * stats.chargeIntervalMs);

  // 3. 자동 합성
  let autoCrafted = null;
  if (claim.auto_craft_enabled) {
    const crafted = craftCascade(owned, lockedSet(claim));
    if (crafted.totalCrafts > 0) {
      applyDeltas(crafted.deltas);
      addStats({ crafts: crafted.totalCrafts, ...countRareGains(crafted.deltas) });
      autoCrafted = { count: crafted.totalCrafts };
    }
  }

  // 접속 중(직전 동기화가 2분 이내)에 일어난 자동 합성은 오늘의 미션 '직접 합성'에도 셉니다.
  // 오래 비웠다가 돌아와서 한꺼번에 정산된 자동 합성은 세지 않습니다.
  let missionState = null;
  const previousActive = claim.last_active_at ? new Date(claim.last_active_at) : null;
  const wasOnline = previousActive && now - previousActive <= ONLINE_MISSION_GAP_MS;
  if (mode === MODES.COLLECTION && autoCrafted && wasOnline) {
    missionState = normalizeMissionState(claim.daily_missions, day);
    missionState.progress.craft = (missionState.progress.craft || 0) + autoCrafted.count;
  }
  // 도감 마일스톤의 매일 지급 보상 (자동 개봉 1시간 · 신화 조각 30) — 하루 한 번
  let dailyGrant = null;
  let shardsAfterGrant = null;
  if (milestones && (milestones.dailyAutoOpenMs || milestones.dailyShards)) {
    const state = missionState || normalizeMissionState(claim.daily_missions, day);
    if (!state.granted) {
      state.granted = true;
      missionState = state;
      dailyGrant = { autoOpenMs: milestones.dailyAutoOpenMs, shards: milestones.dailyShards };
      if (milestones.dailyAutoOpenMs) autoOpenRemainingMs = Math.min(stats.storageMs, autoOpenRemainingMs + milestones.dailyAutoOpenMs);
      if (milestones.dailyShards) shardsAfterGrant = (Number(claim.mythic_shards) || 0) + milestones.dailyShards;
    }
  }

  await addItems(client, userId, mode, itemDeltas);
  if (mode === MODES.COLLECTION) {
    for (const [key, amount] of Object.entries(itemDeltas)) {
      if (amount > 0 && TREASURE_BY_KEY.get(key)?.rarity === 'mythic') codex.add(key);
    }
  }
  // 4. 기록모드 구간 기록: 환생 목표의 10%·20%…에 처음 닿은 경과 시간을 남깁니다.
  const runSplits = mode === MODES.RECORD ? updateRunSplits(claim, gold, now) : null;
  const lifetimeStats = bumpStats(claim, statDeltas);
  const sealedMythics = newSealed.length > 0 ? [...sealedList(claim), ...newSealed] : null;
  await updateClaim(client, userId, mode, {
    ...(runSplits ? { run_splits: JSON.stringify(runSplits) } : {}),
    ...(sealedMythics ? { sealed_mythics: JSON.stringify(sealedMythics) } : {}),
    ...(missionState ? { daily_missions: JSON.stringify(missionState) } : {}),
    ...(shardsAfterGrant !== null ? { mythic_shards: shardsAfterGrant } : {}),
    lifetime_stats: JSON.stringify(lifetimeStats),
    total_treasure: gold,
    run_gold_earned: runGoldEarned,
    last_income_collected_at: now,
    box_charges: charges,
    last_charge_calculated_at: newLastCalc,
    mythic_pity: pity,
    auto_open_remaining_ms: autoOpenRemainingMs,
    last_active_at: now,
  });

  const updatedClaim = {
    ...claim,
    ...(runSplits ? { run_splits: runSplits } : {}),
    ...(sealedMythics ? { sealed_mythics: sealedMythics } : {}),
    ...(missionState ? { daily_missions: missionState } : {}),
    ...(shardsAfterGrant !== null ? { mythic_shards: shardsAfterGrant } : {}),
    total_treasure: gold,
    run_gold_earned: runGoldEarned,
    last_income_collected_at: now,
    box_charges: charges,
    last_charge_calculated_at: newLastCalc,
    mythic_pity: pity,
    auto_open_remaining_ms: autoOpenRemainingMs,
    last_active_at: now,
  };
  const nextChargeInMs = (stillAuto || charges < stats.maxCharges)
    ? stats.chargeIntervalMs - (now - newLastCalc)
    : null;

  return {
    claim: updatedClaim,
    // 정산으로 아이템이 바뀌었을 수 있으니 능력치도 정산 후 보유 기준으로 다시 계산합니다.
    stats: getClaimStats(updatedClaim, owned),
    owned,
    codex,
    season,
    day,
    rotation,
    seasonChange,
    now,
    earned,
    previousActiveAt: claim.last_active_at ? new Date(claim.last_active_at) : null,
    storageCapped,
    autoOpened,
    autoCrafted,
    dailyGrant,
    milestones,
    // 아이템이 바뀌었을 수 있으니 수입은 정산 후 보유 기준으로 다시 계산해서 돌려줍니다.
    income: computeIncome(owned, updatedClaim),
    chargeInfo: { charges, maxCharges: stats.maxCharges, nextChargeInMs, serverTime: now },
  };
}

// 현재 모드의 세이브를 "이번 판" 처음 상태로 되돌립니다. (초심으로 돌아가기 / 환생 공용)
// 보유 아이템과 도감(발견기록)을 지우고, 골드·충전·천장·업그레이드·자동화를 초기화합니다.
// 환생 포인트와 상점 특성은 남겨두고, 환생이라면 이번 판에서 얻은 포인트를 더합니다.
// 시작 골드·자동 개봉 시간·자동 합성은 환생 상점 특성(perks)을 반영합니다.
// 반환: 새 판의 시작 골드
async function resetSave(client, userId, mode, now, { rebirthCount = null, prestigeGain = 0, claim = {} } = {}) {
  const startGold = RESET_GOLD + getPerkLevel(claim, 'startGold') * PERK_START_GOLD;
  const startAutoOpenMs = getPerkLevel(claim, 'startAuto') * PERK_START_AUTO_OPEN_MS;
  const startAutoCraft = getPerkLevel(claim, 'autoCraft') > 0;

  await client.query('DELETE FROM user_items WHERE user_id = $1 AND mode = $2', [userId, mode]);
  await client.query('DELETE FROM user_discoveries WHERE user_id = $1 AND mode = $2', [userId, mode]);
  // $2(지금 시각)는 여러 시간 컬럼에 함께 들어갑니다. 실제 DB는 컬럼마다 timestamp / timestamptz 타입이
  // 섞여 있어서, 타입을 명시하지 않으면 PostgreSQL이 "$2의 타입을 하나로 정할 수 없다"며 거부합니다.
  await client.query(
    `UPDATE box_claims
     SET total_treasure = $1,
         run_splits = '[]'::jsonb,
         sealed_mythics = '[]'::jsonb,
         last_income_collected_at = $2::timestamptz,
         run_started_at = $2::timestamptz,
         box_charges = 1,
         last_charge_calculated_at = $2::timestamptz,
         mythic_pity = 0,
         rebirth_count = COALESCE($5, rebirth_count),
         upgrade_income = 0,
         upgrade_charge_speed = 0,
         upgrade_capacity = 0,
         upgrade_luck = 0,
         auto_open_enabled = TRUE,
         auto_open_remaining_ms = $7,
         auto_craft_unlocked = $8,
         auto_craft_enabled = $8,
         run_gold_earned = 0,
         prestige_points = prestige_points + $6,
         last_active_at = $2::timestamptz
     WHERE user_id = $3 AND mode = $4`,
    [startGold, now, userId, mode, rebirthCount, prestigeGain, startAutoOpenMs, startAutoCraft]
  );
  return startGold;
}

// 환생 포인트는 기록모드에서만 의미가 있습니다.
function isPrestigeMode(mode) {
  return mode === MODES.RECORD;
}

// 일일 미션 진행 +amount (수집모드 전용). claim은 이미 FOR UPDATE로 읽은 행이어야 합니다.
async function bumpMission(client, userId, mode, claim, day, key, amount = 1) {
  if (mode !== MODES.COLLECTION || !(amount > 0)) return;
  const state = normalizeMissionState(claim.daily_missions, day);
  state.progress[key] = (state.progress[key] || 0) + amount;
  claim.daily_missions = state;
  await updateClaim(client, userId, mode, { daily_missions: JSON.stringify(state) });
}

module.exports = {
  bumpMission,
  lockedSet,
  bumpStats,
  saveStats,
  boxStatDeltas,
  countRareGains,
  getActiveMode,
  getClaim,
  updateClaim,
  getOwnedCounts,
  getCodexKeys,
  rollContextOf,
  sealedList,
  computeIncome,
  addItems,
  settle,
  resetSave,
  isPrestigeMode,
};
