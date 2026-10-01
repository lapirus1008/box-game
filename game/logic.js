// game/logic.js
// DB와 무관한 순수 게임 로직(확률 뽑기, 천장, 숙련도, 수집가 등급 등)입니다.
// 입력만 같으면 결과가 같기 때문에 따로 떼어두면 읽기도, 테스트하기도 쉽습니다.

const {
  TREASURES,
  TREASURE_BY_KEY,
  RARITY_ORDER,
  CRAFTABLE_RARITIES,
  MYTHIC_PITY_LIMIT,
  MASTERY_THRESHOLDS,
  COLLECTOR_RANKS,
} = require('./config');

// weight 기반으로 목록 중 하나를 랜덤하게 뽑습니다.
function pickWeighted(pool) {
  const totalWeight = pool.reduce((sum, t) => sum + t.weight, 0);
  let rand = Math.random() * totalWeight;
  for (const treasure of pool) {
    if (rand < treasure.weight) return treasure;
    rand -= treasure.weight;
  }
  return pool[0];
}

// 등급별 아이템 목록은 바뀌지 않으므로 미리 나눠둡니다.
const TREASURES_BY_RARITY = RARITY_ORDER.reduce((acc, rarity) => {
  acc[rarity] = TREASURES.filter(t => t.rarity === rarity);
  return acc;
}, {});

// 전체 아이템 중 하나를 뽑습니다 (상자 열기용).
function pickRandomTreasure() {
  return pickWeighted(TREASURES);
}

// 특정 등급 안에서만 하나를 뽑습니다 (합성 결과/천장용).
function pickRandomFromRarity(rarity) {
  return pickWeighted(TREASURES_BY_RARITY[rarity]);
}

// 상자 하나를 뽑되, 천장 카운터를 반영합니다.
// pity = 지금까지 신화 없이 연 상자 수. 이번이 천장 번째 상자면 신화 확정.
function rollWithPity(pity) {
  if (pity + 1 >= MYTHIC_PITY_LIMIT) {
    return { treasure: pickRandomFromRarity('mythic'), pity: 0, guaranteed: true };
  }
  const treasure = pickRandomTreasure();
  return { treasure, pity: treasure.rarity === 'mythic' ? 0 : pity + 1, guaranteed: false };
}

// 상자 여러 개를 연속으로 뽑습니다. 천장 카운터는 한 개씩 순서대로 반영됩니다.
// 반환: { counts: { itemKey: 개수 }, pity: 최종 천장 카운터, pityTriggered: 천장 발동 여부 }
function rollBoxes(startPity, quantity) {
  let pity = startPity;
  let pityTriggered = false;
  const counts = {};
  for (let i = 0; i < quantity; i++) {
    const roll = rollWithPity(pity);
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

module.exports = {
  pickRandomTreasure,
  pickRandomFromRarity,
  rollWithPity,
  rollBoxes,
  getNextCraftRarity,
  rollCraftResults,
  toObtainedList,
  getItemStars,
  getCollectorRank,
};
