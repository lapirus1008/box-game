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
  BOX_PRICE_INCOME_MINUTES,
} = require('./config');

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

// 행운 보너스(%)별 뽑기 풀: 희귀 이상 아이템의 weight를 그만큼 키웁니다. (값별로 한 번만 계산)
const poolCache = new Map();
function getBoxPool(luckPercent = 0) {
  if (!poolCache.has(luckPercent)) {
    const multiplier = 100 + luckPercent;
    poolCache.set(luckPercent, TREASURES.map(t => ({
      treasure: t,
      weight: t.rarity === 'common' ? t.weight : t.weight * multiplier / 100,
    })));
  }
  return poolCache.get(luckPercent);
}

// 등급별 아이템 목록은 바뀌지 않으므로 미리 나눠둡니다 (합성 결과/천장용).
const POOL_BY_RARITY = RARITY_ORDER.reduce((acc, rarity) => {
  acc[rarity] = TREASURES.filter(t => t.rarity === rarity).map(t => ({ treasure: t, weight: t.weight }));
  return acc;
}, {});

// 특정 등급 안에서만 하나를 뽑습니다.
function pickRandomFromRarity(rarity) {
  return pickWeighted(POOL_BY_RARITY[rarity]);
}

// 상자 하나를 뽑되, 천장 카운터를 반영합니다.
// pity = 지금까지 신화 없이 연 상자 수. 이번이 천장 번째 상자면 신화 확정.
function rollWithPity(pity, luckPercent = 0, pityLimit = MYTHIC_PITY_LIMIT) {
  if (pity + 1 >= pityLimit) {
    return { treasure: pickRandomFromRarity('mythic'), pity: 0, guaranteed: true };
  }
  const treasure = pickWeighted(getBoxPool(luckPercent));
  return { treasure, pity: treasure.rarity === 'mythic' ? 0 : pity + 1, guaranteed: false };
}

// 상자 여러 개를 연속으로 뽑습니다. 천장 카운터는 한 개씩 순서대로 반영됩니다.
// 반환: { counts: { itemKey: 개수 }, pity: 최종 천장 카운터, pityTriggered: 천장 발동 여부 }
function rollBoxes(startPity, quantity, luckPercent = 0, pityLimit = MYTHIC_PITY_LIMIT) {
  let pity = startPity;
  let pityTriggered = false;
  const counts = {};
  for (let i = 0; i < quantity; i++) {
    const roll = rollWithPity(pity, luckPercent, pityLimit);
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
    return { key, ...picked, count };
  });
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

// 도감 발견 개수에 따른 수집가 등급 (+ 다음 등급까지 남은 개수)
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
    total: TREASURES.length,
    next: next
      ? { key: next.key, name: next.name, emoji: next.emoji, remaining: next.minObtained - obtainedCount }
      : null,
  };
}

// -------------------------------
// 업그레이드 / 환생 포인트
// -------------------------------
function getUpgradeCost(upgrade, level) {
  return Math.floor(upgrade.baseCost * Math.pow(UPGRADE_COST_GROWTH, level));
}

// 환생 상점 특성 레벨 (prestige_perks JSONB 컬럼, 없으면 0)
function getPerkLevel(claim, key) {
  const perks = claim.prestige_perks || {};
  return Number(perks[key]) || 0;
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

// 보유 아이템의 고유 효과 합계: { luck, golden, boxDiscount, pity, storageMinutes, incomePercent }
function getItemEffects(owned = {}) {
  const effects = { luck: 0, golden: 0, boxDiscount: 0, pity: 0, storageMinutes: 0, incomePercent: 0 };
  for (const [key, effect] of Object.entries(ITEM_EFFECTS)) {
    const count = owned[key] || 0;
    if (count > 0) effects[effect.type] = Math.min(effect.max, count * effect.perItem);
  }
  return effects;
}

// 효과 하나를 화면용 문구로 (value = 지금 적용 중인 값)
function describeItemEffect(type, value) {
  switch (type) {
    case 'luck':           return `희귀 이상 등장률 +${value}%`;
    case 'golden':         return `황금 상자 보상 +${value}%`;
    case 'boxDiscount':    return `상자 구매가 -${value}%`;
    case 'pity':           return `신화 천장 -${value}개`;
    case 'storageMinutes': return `보관 시간 +${formatHours(value * 60000)}`;
    case 'incomePercent':  return `전체 수입 +${value}%`;
    default:               return '';
  }
}

// box_claims 한 줄(claim)과 보유 아이템(owned)에서 업그레이드·환생 특성·아이템 효과가 반영된 능력치를 계산합니다.
function getClaimStats(claim, owned = {}) {
  const effects = getItemEffects(owned);
  return {
    chargeIntervalMs: getChargeIntervalMs(claim.upgrade_charge_speed + getPerkLevel(claim, 'chargeSpeed')),
    maxCharges: MAX_BOX_CHARGES,
    storageMs: getStorageMs(claim.upgrade_capacity, getPerkLevel(claim, 'storage')) + effects.storageMinutes * 60000,
    luckPercent: (claim.upgrade_luck + getPerkLevel(claim, 'luck')) * LUCK_PERCENT_PER_LEVEL + effects.luck,
    pityLimit: MYTHIC_PITY_LIMIT - effects.pity,
    goldenBonusPercent: effects.golden,
    boxDiscountPercent: effects.boxDiscount,
    mythicIncomePercent: effects.incomePercent,
    effects,
    // 수입 배율은 퍼센트 정수 두 개로 들고 다닙니다 (부동소수점 오차 방지)
    upgradeIncomePercent: 100 + claim.upgrade_income * INCOME_BONUS_PERCENT_PER_LEVEL,
    prestigeIncomePercent: 100 + getPerkLevel(claim, 'income') * PERK_INCOME_PERCENT,
  };
}

// 골드 상자 1개 가격 = max(최소 가격, 분당 수입 × 0.25분) 에서 용의 비늘 할인
function getBoxPrice(perMinuteIncome, discountPercent = 0) {
  const base = Math.max(GOLD_PER_BOX_PURCHASE, Math.floor(perMinuteIncome * BOX_PRICE_INCOME_MINUTES));
  return Math.max(1, Math.floor(base * (100 - discountPercent) / 100));
}

// 자동 개봉 1시간 가격: 최소 가격과 "지금 분당 수입 × N분" 중 큰 값
function getAutoOpenCostPerHour(perMinuteIncome) {
  return Math.max(AUTO_OPEN_MIN_COST_PER_HOUR, perMinuteIncome * AUTO_OPEN_COST_INCOME_MINUTES);
}

// 이번 판에 번 골드로 환생하면 받을 포인트
function getPrestigePointsForRun(runGoldEarned) {
  return Math.floor(Number(runGoldEarned) / PRESTIGE_GOLD_PER_POINT);
}

module.exports = {
  pickRandomFromRarity,
  rollWithPity,
  rollBoxes,
  getNextCraftRarity,
  rollCraftResults,
  craftCascade,
  toObtainedList,
  getItemStars,
  getCollectorRank,
  getUpgradeCost,
  describeUpgradeEffect,
  getClaimStats,
  getItemEffects,
  describeItemEffect,
  getBoxPrice,
  getPerkLevel,
  getAutoOpenCostPerHour,
  formatHours,
  getPrestigePointsForRun,
  HOUR_MS,
  UPGRADE_KEYS: UPGRADES.map(u => u.key),
};
