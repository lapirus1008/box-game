// game/logic.js
// DB와 무관한 순수 게임 로직(확률 뽑기, 천장, 합성, 숙련도, 업그레이드 효과 등)입니다.
// 입력만 같으면 결과가 같기 때문에 따로 떼어두면 읽기도, 테스트하기도 쉽습니다.

const {
  TREASURES,
  TREASURE_BY_KEY,
  RARITY_ORDER,
  CRAFTABLE_RARITIES,
  CRAFT_COST,
  MYTHIC_PITY_LIMIT,
  MASTERY_THRESHOLDS,
  COLLECTOR_RANKS,
  CHARGE_INTERVAL_MS,
  MAX_BOX_CHARGES,
  UPGRADES,
  UPGRADE_COST_GROWTH,
  INCOME_BONUS_PERCENT_PER_LEVEL,
  CHARGE_SPEED_MS_PER_LEVEL,
  MIN_CHARGE_INTERVAL_MS,
  LUCK_PERCENT_PER_LEVEL,
  HOUR_MS,
  BASE_STORAGE_MS,
  STORAGE_MS_PER_LEVEL,
  AUTO_OPEN_MIN_COST_PER_HOUR,
  AUTO_OPEN_COST_INCOME_MINUTES,
  PRESTIGE_GOLD_PER_POINT,
  PERK_INCOME_PERCENT,
  PERK_STORAGE_MS,
  ITEM_EFFECTS,
  GOLD_PER_BOX_PURCHASE,
  BOX_PRICE_REF_INCOME,
  BOX_PRICE_EXPONENT,
  BOX_PRICE_INCOME_MINUTES,
  INCOME_PER_MINUTE_BY_RARITY,
  EFFECT_TYPE_CAPS,
  MIN_ITEM_CHARGE_INTERVAL_MS,
  NON_MYTHIC_TREASURES,
  SEASON_RULES,
} = require('./config');
const { activeSkillBuffs } = require('./skills');
const { MYTHICS } = require('./mythics');

// weight 기반으로 목록 중 하나를 랜덤하게 뽑습니다. (pool 원소는 { treasure, weight })
function pickWeighted(pool) {
  const totalWeight = pool.reduce((sum, entry) => sum + entry.weight, 0);
  let rand = Math.random() * totalWeight;
  for (const entry of pool) {
    if (rand < entry.weight) return entry.treasure;
    rand -= entry.weight;
  }
  return pool[0].treasure;
}

// 시즌 신화 묶음(rotation)별 신화 목록
const MYTHICS_BY_ROTATION = MYTHICS.reduce((acc, m) => {
  (acc[m.rotation] = acc[m.rotation] || []).push(m);
  return acc;
}, {});
function getRotationMythics(rotation) {
  return MYTHICS_BY_ROTATION[rotation] || [];
}

// 오늘 상자에서 나오는 아이템: 일반~전설 전부 + 오늘의 신화 10종
function getSeasonDexItems(rotation) {
  return [...NON_MYTHIC_TREASURES, ...getRotationMythics(rotation)];
}

// (시즌 신화 묶음, 행운 보너스%)별 뽑기 풀. 상자에서는 일반~전설 + 이번 시즌 신화 10종만 나옵니다.
// 행운은 희귀 이상 아이템의 weight를 그만큼 키웁니다. (조합별로 한 번만 계산)
const poolCache = new Map();
function getBoxPool(luckPercent = 0, rotation = 0) {
  const cacheKey = `${rotation}:${luckPercent}`;
  if (!poolCache.has(cacheKey)) {
    const multiplier = 100 + luckPercent;
    poolCache.set(cacheKey, getSeasonDexItems(rotation).map(t => ({
      treasure: t,
      weight: t.rarity === 'common' ? t.weight : t.weight * multiplier / 100,
    })));
  }
  return poolCache.get(cacheKey);
}

// 등급별 아이템 목록 (합성 결과용. 신화는 합성으로 나오지 않으므로 넣지 않습니다)
const POOL_BY_RARITY = RARITY_ORDER.reduce((acc, rarity) => {
  acc[rarity] = NON_MYTHIC_TREASURES.filter(t => t.rarity === rarity).map(t => ({ treasure: t, weight: t.weight }));
  return acc;
}, {});

// 특정 등급 안에서만 하나를 뽑습니다.
function pickRandomFromRarity(rarity) {
  return pickWeighted(POOL_BY_RARITY[rarity]);
}

// 천장 보상: 이번 시즌 신화 중 아직 가져본 적 없는 것(신화 도감·지금 가방 기준)을 우선으로,
// 모두 가져봤다면 이번 시즌 신화 전체에서 뽑습니다.
function pickPityMythic(rotation, have) {
  const pool = getRotationMythics(rotation).map(t => ({ treasure: t, weight: t.weight }));
  const missing = pool.filter(e => !have.has(e.treasure.key));
  return pickWeighted(missing.length > 0 ? missing : pool);
}

// 상자 뽑기에 필요한 조건 묶음
// { luckPercent, pityLimit, rotation(이번 시즌 신화 묶음), have(가져본 적 있는 신화 key Set) }
function makeRollContext({ luckPercent = 0, pityLimit = MYTHIC_PITY_LIMIT, rotation = 0, have = new Set() } = {}) {
  return { luckPercent, pityLimit, rotation, have };
}

// 상자 하나를 뽑되, 천장 카운터를 반영합니다.
// pity = 지금까지 신화 없이 연 상자 수. 이번이 천장 번째 상자면 신화 확정.
function rollWithPity(pity, ctx = makeRollContext()) {
  if (pity + 1 >= ctx.pityLimit) {
    return { treasure: pickPityMythic(ctx.rotation, ctx.have), pity: 0, guaranteed: true };
  }
  const treasure = pickWeighted(getBoxPool(ctx.luckPercent, ctx.rotation));
  return { treasure, pity: treasure.rarity === 'mythic' ? 0 : pity + 1, guaranteed: false };
}

// 상자 여러 개를 연속으로 뽑습니다. 천장 카운터는 한 개씩 순서대로 반영됩니다.
// 반환: { counts: { itemKey: 개수 }, pity: 최종 천장 카운터, pityTriggered: 천장 발동 여부 }
function rollBoxes(startPity, quantity, ctx = makeRollContext()) {
  let pity = startPity;
  let pityTriggered = false;
  const counts = {};
  // 이번에 뽑은 신화도 '가져본 것'으로 쳐서, 한 번에 여러 번 천장이 터져도 겹치지 않게 합니다.
  const batchCtx = { ...ctx, have: new Set(ctx.have) };
  for (let i = 0; i < quantity; i++) {
    const roll = rollWithPity(pity, batchCtx);
    if (roll.treasure.rarity === 'mythic') batchCtx.have.add(roll.treasure.key);
    pity = roll.pity;
    if (roll.guaranteed) pityTriggered = true;
    counts[roll.treasure.key] = (counts[roll.treasure.key] || 0) + 1;
  }
  return { counts, pity, pityTriggered };
}

// 합성 가능한 아이템이면 결과로 나올 다음 등급을, 아니면 null을 돌려줍니다.
function getNextCraftRarity(item) {
  if (!CRAFTABLE_RARITIES.includes(item.rarity)) return null;
  return RARITY_ORDER[RARITY_ORDER.indexOf(item.rarity) + 1];
}

// 같은 등급에서 craftCount번 합성한 결과를 { itemKey: 개수 } 형태로 돌려줍니다.
function rollCraftResults(rarity, craftCount) {
  const counts = {};
  for (let i = 0; i < craftCount; i++) {
    const item = pickRandomFromRarity(rarity);
    counts[item.key] = (counts[item.key] || 0) + 1;
  }
  return counts;
}

// 보유 개수(owned: { itemKey: 개수 })로 가능한 만큼 전부 합성합니다.
// 일반 → 희귀 → 영웅 순서로 처리해서, 합성으로 새로 생긴 아이템도 바로 다음 단계 재료가 됩니다.
// locked(Set)에 든 아이템은 재료로 쓰지 않습니다 (🔒 잠금).
// 반환: { deltas: { itemKey: 증감 }, results: [{ sourceKey, craftCount, obtained }], totalCrafts }
function craftCascade(owned, locked = new Set()) {
  const counts = { ...owned };
  const deltas = {};
  const results = [];
  let totalCrafts = 0;
  const addDelta = (key, amount) => { deltas[key] = (deltas[key] || 0) + amount; };

  for (const rarity of CRAFTABLE_RARITIES) {
    for (const item of TREASURES.filter(t => t.rarity === rarity)) {
      if (locked.has(item.key)) continue;
      const craftCount = Math.floor((counts[item.key] || 0) / CRAFT_COST);
      if (craftCount === 0) continue;

      counts[item.key] -= craftCount * CRAFT_COST;
      addDelta(item.key, -craftCount * CRAFT_COST);

      const obtained = rollCraftResults(getNextCraftRarity(item), craftCount);
      for (const [key, amount] of Object.entries(obtained)) {
        counts[key] = (counts[key] || 0) + amount;
        addDelta(key, amount);
      }
      totalCrafts += craftCount;
      results.push({ sourceKey: item.key, craftCount, obtained });
    }
  }
  return { deltas, results, totalCrafts };
}

// { itemKey: 개수 } → 응답용 배열로 변환합니다. fields로 포함할 아이템 속성을 고릅니다.
function toObtainedList(counts, fields = ['name', 'emoji', 'rarity', 'flavor']) {
  return Object.entries(counts).map(([key, count]) => {
    const item = TREASURE_BY_KEY.get(key);
    const picked = {};
    for (const field of fields) picked[field] = item[field];
    if (item.effect) picked.effectText = describeMythicEffect(item);
    return { key, ...picked, count };
  });
}

// 신화 효과 한 줄 설명 (신화 등장 화면용). 예: "희귀 이상 등장률 +5% (1개당 · 3개까지)"
function describeMythicEffect(item) {
  const effect = ITEM_EFFECTS[item.key];
  if (!effect) return '';
  return `${describeItemEffect(effect.type, effect.perItem)} (1개당 · ${Math.round(effect.max / effect.perItem)}개까지)`;
}

// 같은 아이템 보유 개수에 따른 숙련도(★) 개수
function getItemStars(count) {
  let stars = 0;
  for (const threshold of MASTERY_THRESHOLDS) {
    if (count >= threshold) stars++;
    else break;
  }
  return stars;
}

// 수집모드 신화 도감 수에 따른 수집가 칭호 (+ 다음 칭호까지 남은 개수)
function getCollectorRank(obtainedCount) {
  let currentIndex = 0;
  COLLECTOR_RANKS.forEach((rank, i) => {
    if (obtainedCount >= rank.minObtained) currentIndex = i;
  });
  const current = COLLECTOR_RANKS[currentIndex];
  const next = COLLECTOR_RANKS[currentIndex + 1] || null;

  return {
    key: current.key,
    name: current.name,
    emoji: current.emoji,
    obtainedCount,
    total: MYTHICS.length,
    next: next
      ? { key: next.key, name: next.name, emoji: next.emoji, remaining: next.minObtained - obtainedCount }
      : null,
  };
}

// -------------------------------
// 업그레이드 / 환생 포인트
// -------------------------------
// discountPercent: 신화 효과(강화 비용 -%)
function getUpgradeCost(upgrade, level, discountPercent = 0) {
  const base = Math.floor(upgrade.baseCost * Math.pow(UPGRADE_COST_GROWTH, level));
  return Math.max(1, Math.floor(base * (100 - discountPercent) / 100));
}

// 환생 상점 특성 레벨 (prestige_perks JSONB 컬럼, 없으면 0)
function getPerkLevel(claim, key) {
  const perks = claim.prestige_perks || {};
  return Number(perks[key]) || 0;
}

// 환생 특성 다음 레벨 비용: 레벨이 오를수록 비싸짐 (기본 비용 × (현재 레벨 + 1))
function getPerkCost(perk, level) {
  return perk.cost * (level + 1);
}

function getChargeIntervalMs(speedLevel) {
  return Math.max(MIN_CHARGE_INTERVAL_MS, CHARGE_INTERVAL_MS - speedLevel * CHARGE_SPEED_MS_PER_LEVEL);
}

function getStorageMs(capacityLevel, storagePerkLevel = 0) {
  return BASE_STORAGE_MS + capacityLevel * STORAGE_MS_PER_LEVEL + storagePerkLevel * PERK_STORAGE_MS;
}

// 시간을 "4시간", "1시간 30분"처럼 표시합니다.
function formatHours(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}분`;
  return minutes === 0 ? `${hours}시간` : `${hours}시간 ${minutes}분`;
}

// 업그레이드 레벨에 따른 효과를 화면에 보여줄 문구로 만듭니다. (환생 특성 보너스는 제외한 업그레이드 자체 효과)
function describeUpgradeEffect(key, level) {
  switch (key) {
    case 'income':      return `수입 +${level * INCOME_BONUS_PERCENT_PER_LEVEL}%`;
    case 'chargeSpeed': return `충전 ${getChargeIntervalMs(level) / 1000}초마다`;
    case 'capacity':    return `보관 시간 ${formatHours(getStorageMs(level))}`;
    case 'luck':        return `희귀 이상 등장률 +${level * LUCK_PERCENT_PER_LEVEL}%`;
    default:            return '';
  }
}

// 아이템 하나가 지금 주는 효과 (보유 개수 × 1개당 수치, 아이템별 최대치까지)
function getItemEffectValue(effect, count) {
  return Math.min(effect.max, count * effect.perItem);
}

// 보유 아이템의 고유 효과 합계 (효과 종류별로 더하고, 종류별 최대치까지)
// { luck, golden, boxDiscount, pity, storageMinutes, incomePercent, upgradeDiscount, autoOpenDiscount, chargeSpeed }
function getItemEffects(owned = {}) {
  const effects = Object.fromEntries(Object.keys(EFFECT_TYPE_CAPS).map(type => [type, 0]));
  for (const [key, count] of Object.entries(owned)) {
    const effect = ITEM_EFFECTS[key];
    if (!effect || !(count > 0)) continue;
    effects[effect.type] += getItemEffectValue(effect, count);
  }
  for (const type of Object.keys(effects)) effects[type] = Math.min(EFFECT_TYPE_CAPS[type], effects[type]);
  return effects;
}

// 효과 종류별 대표 이모지 (효과 요약 표시용)
const EFFECT_TYPE_EMOJI = {
  incomePercent: '💰', luck: '🍀', golden: '🎁', boxDiscount: '🏷️', pity: '🌸',
  storageMinutes: '📦', upgradeDiscount: '🔨', autoOpenDiscount: '⏳', chargeSpeed: '⚡',
};

// 효과 하나를 화면용 문구로 (value = 지금 적용 중인 값)
function describeItemEffect(type, value) {
  switch (type) {
    case 'luck':           return `희귀 이상 등장률 +${value}%`;
    case 'golden':         return `황금 상자 보상 +${value}%`;
    case 'boxDiscount':    return `상자 구매가 -${value}%`;
    case 'pity':           return `신화 천장 -${value}개`;
    case 'storageMinutes': return `보관 시간 +${formatHours(value * 60000)}`;
    case 'incomePercent':  return `전체 수입 +${value}%`;
    case 'upgradeDiscount':  return `강화 비용 -${value}%`;
    case 'autoOpenDiscount': return `자동 개봉 가격 -${value}%`;
    case 'chargeSpeed':      return `충전 속도 +${value}%`;
    default:               return '';
  }
}

// 오늘의 규칙 (매일 돌아가며 정해짐. +2는 처음 적용한 날의 규칙을 이어가기 위한 값)
function getDailyRule(day) {
  const n = SEASON_RULES.length;
  return SEASON_RULES[(((day + 2) % n) + n) % n];
}

// box_claims 한 줄(claim)과 보유 아이템(owned)에서 업그레이드·환생 특성·아이템 효과·오늘의 규칙이 반영된 능력치를 계산합니다.
// claim.season_rule: 오늘의 규칙 (DB 컬럼이 아니라 정산할 때 store.settle 이 넣어줍니다)
function getClaimStats(claim, owned = {}) {
  const effects = getItemEffects(owned);
  // 오늘의 규칙은 아이템 효과 최대치와 별개로 더해집니다.
  const rule = claim.season_rule;
  if (rule) effects[rule.type] += rule.value;
  // 수집모드 세트 효과·각성 보너스 (game/collection.js)
  for (const [type, value] of Object.entries(claim.collection_bonus || {})) effects[type] = (effects[type] || 0) + value;
  // 신화 스킬의 시간제 효과 (행운의 손길 · 떨이)
  const buffs = activeSkillBuffs(claim.skill_buffs || {});
  effects.luck += buffs.luck;
  effects.boxDiscount = Math.min(80, effects.boxDiscount + buffs.boxDiscount);
  const baseChargeMs = getChargeIntervalMs(claim.upgrade_charge_speed + getPerkLevel(claim, 'chargeSpeed'));
  return {
    chargeIntervalMs: effects.chargeSpeed > 0
      ? Math.max(MIN_ITEM_CHARGE_INTERVAL_MS, Math.round(baseChargeMs * (100 - effects.chargeSpeed) / 100))
      : baseChargeMs,
    maxCharges: MAX_BOX_CHARGES + (Number(claim.milestone_max_charges) || 0),
    storageMs: getStorageMs(claim.upgrade_capacity, getPerkLevel(claim, 'storage')) + effects.storageMinutes * 60000,
    luckPercent: (claim.upgrade_luck + getPerkLevel(claim, 'luck')) * LUCK_PERCENT_PER_LEVEL + effects.luck,
    pityLimit: Math.max(300, MYTHIC_PITY_LIMIT - effects.pity),
    goldenBonusPercent: effects.golden,
    boxDiscountPercent: effects.boxDiscount,
    mythicIncomePercent: effects.incomePercent,
    // 수입 배율 세 번째 항목: 아이템 효과(전체 수입 +%) + 오늘의 규칙
    itemIncomePercent: 100 + effects.incomePercent,
    upgradeDiscountPercent: effects.upgradeDiscount,
    autoOpenDiscountPercent: effects.autoOpenDiscount,
    effects,
    // 수입 배율은 퍼센트 정수 두 개로 들고 다닙니다 (부동소수점 오차 방지)
    upgradeIncomePercent: 100 + claim.upgrade_income * INCOME_BONUS_PERCENT_PER_LEVEL,
    prestigeIncomePercent: 100 + getPerkLevel(claim, 'income') * PERK_INCOME_PERCENT,
  };
}

// 골드 상자 1개 가격 = max(최소 가격, 최소 가격 × (분당 수입 ÷ 기준 수입)^지수) 에서 할인
// (수입에 정비례하던 예전 공식은 성장해도 체감이 없어서, 수입보다 완만하게 오르도록 바꿨습니다)
// public/app.js 의 boxPriceAt 과 같은 공식이어야 합니다.
function getBoxPrice(perMinuteIncome, discountPercent = 0) {
  const scaled = GOLD_PER_BOX_PURCHASE * Math.pow(Math.max(0, perMinuteIncome) / BOX_PRICE_REF_INCOME, BOX_PRICE_EXPONENT);
  const base = Math.max(GOLD_PER_BOX_PURCHASE, Math.floor(scaled));
  return Math.max(1, Math.floor(base * (100 - discountPercent) / 100));
}

// 상자 1개를 열면 분당 수입이 평균 얼마나 오르는지 (행운 반영, ★·배율 제외)
// 시즌 신화는 묶음마다 개수·확률이 같아서 어느 묶음으로 계산해도 같습니다.
function expectedIncomePerBox(luckPercent = 0) {
  const pool = getBoxPool(luckPercent, 0);
  const totalWeight = pool.reduce((sum, e) => sum + e.weight, 0);
  return pool.reduce((sum, e) => sum + e.weight * INCOME_PER_MINUTE_BY_RARITY[e.treasure.rarity], 0) / totalWeight;
}

// 상자 여러 개를 한 번에 살 때의 총액.
// 하나씩 산 것과 같도록, k번째 상자는 "앞의 상자들로 오른 평균 수입" 기준 가격을 매깁니다.
// (한 번에 사면 첫 상자 가격으로 전부 사져서 몰아 사기가 무조건 이득이 되는 것을 막음)
// pricing = { income, step(상자 1개당 평균 수입 증가), discountPercent }
function getBoxPurchaseCost(pricing, quantity) {
  let total = 0;
  let lastPrice = 0;
  for (let k = 0; k < quantity; k++) {
    lastPrice = getBoxPrice(pricing.income + k * pricing.step, pricing.discountPercent);
    total += lastPrice;
  }
  return { total, firstPrice: getBoxPrice(pricing.income, pricing.discountPercent), lastPrice };
}

// 가진 골드로 최대 몇 개까지 살 수 있는지
function getMaxAffordableBoxes(pricing, gold, limit) {
  let total = 0;
  for (let k = 0; k < limit; k++) {
    total += getBoxPrice(pricing.income + k * pricing.step, pricing.discountPercent);
    if (total > gold) return k;
  }
  return limit;
}

// 자동 개봉 1시간 가격: 최소 가격과 "지금 분당 수입 × N분" 중 큰 값
// discountPercent: 신화 효과(자동 개봉 가격 -%)
function getAutoOpenCostPerHour(perMinuteIncome, discountPercent = 0) {
  const base = Math.max(AUTO_OPEN_MIN_COST_PER_HOUR, perMinuteIncome * AUTO_OPEN_COST_INCOME_MINUTES);
  return Math.max(1, Math.floor(base * (100 - discountPercent) / 100));
}

// 이번 판에 번 골드로 환생하면 받을 포인트
function getPrestigePointsForRun(runGoldEarned) {
  return Math.floor(Number(runGoldEarned) / PRESTIGE_GOLD_PER_POINT);
}

module.exports = {
  pickRandomFromRarity,
  makeRollContext,
  rollWithPity,
  rollBoxes,
  getRotationMythics,
  getSeasonDexItems,
  getItemEffectValue,
  EFFECT_TYPE_EMOJI,
  getNextCraftRarity,
  rollCraftResults,
  craftCascade,
  toObtainedList,
  describeMythicEffect,
  getItemStars,
  getCollectorRank,
  getDailyRule,
  getUpgradeCost,
  describeUpgradeEffect,
  getClaimStats,
  getPerkCost,
  getItemEffects,
  describeItemEffect,
  getBoxPrice,
  getBoxPurchaseCost,
  getMaxAffordableBoxes,
  expectedIncomePerBox,
  getPerkLevel,
  getAutoOpenCostPerHour,
  formatHours,
  getPrestigePointsForRun,
  HOUR_MS,
  UPGRADE_KEYS: UPGRADES.map(u => u.key),
};
