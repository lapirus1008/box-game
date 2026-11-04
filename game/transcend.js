// game/transcend.js
// 수집모드 전용: 상자 강화(+0 ~ +20)와 초월
//
// [상자 강화] 신화 조각을 내고 확률로 상자를 +1 강화합니다.
//   - 단계가 높을수록 성공 확률은 낮아지고 비용은 올라갑니다.
//   - +10 이상에서 실패하면 한 단계 떨어집니다. (+9 이하는 실패해도 그대로)
//   - 강화 단계마다 전체 수입 +5%, 희귀 이상 등장률 +2%
//   - 평균 약 850조각이면 +20에 닿도록 맞췄습니다. (하루 조각 80~100개 기준 열흘 안팎)
// [초월] +20을 달성하면 초월할 수 있습니다.
//   - 골드·아이템·강화·연구·상자 강화·신화 조각을 처음부터 다시 시작합니다.
//   - 신화 도감·각성·업적·칭호는 그대로 남습니다.
//   - 초월 횟수는 영구히 쌓이고(users.transcend_count) 이름 옆에 표시됩니다. 1회마다 전체 수입 +20%.

const ENHANCE_MAX = 20;
// 지금 단계(인덱스)에서 다음 단계로 올릴 때의 성공 확률(%)과 비용(신화 조각)
const ENHANCE_CHANCES = [100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 70, 68, 66, 64, 62, 60, 58, 56, 54, 52];
const ENHANCE_COSTS   = [5, 5, 5, 5, 5, 10, 10, 10, 10, 10, 15, 15, 15, 15, 15, 20, 20, 20, 20, 20];
const ENHANCE_DROP_FROM = 10;           // 이 단계부터 실패하면 한 단계 하락
const ENHANCE_INCOME_PERCENT = 5;       // 강화 단계마다 전체 수입 +%
const ENHANCE_LUCK_PERCENT = 2;         // 강화 단계마다 희귀 이상 등장률 +%
const TRANSCEND_INCOME_PERCENT = 20;    // 초월 1회마다 전체 수입 +% (영구)

// 초월 횟수 → 효과 단계 (이름 옆 배지 · 광장 캐릭터 효과). 화면(public/app.js)과 같은 기준입니다.
const TRANSCEND_TIERS = [1, 3, 5, 10, 20];
function transcendTier(count) {
  let tier = 0;
  TRANSCEND_TIERS.forEach((min, i) => { if (count >= min) tier = i + 1; });
  return tier;
}

function enhanceLevel(claim) {
  return Math.max(0, Math.min(ENHANCE_MAX, Number(claim.box_enhance) || 0));
}

// 강화 한 번 시도. 반환: { success, dropped, level }
function rollEnhance(level, random = Math.random) {
  const success = random() * 100 < ENHANCE_CHANCES[level];
  if (success) return { success, dropped: false, level: level + 1 };
  const dropped = level >= ENHANCE_DROP_FROM;
  return { success, dropped, level: dropped ? level - 1 : level };
}

// 강화·초월이 주는 능력치 (수집모드 정산 때 세트·각성 보너스에 더해집니다)
function transcendEffects(enhance, transcendCount) {
  return {
    incomePercent: enhance * ENHANCE_INCOME_PERCENT + transcendCount * TRANSCEND_INCOME_PERCENT,
    luck: enhance * ENHANCE_LUCK_PERCENT,
  };
}

// 화면 표시용
function enhanceResponse(claim, transcendCount) {
  const level = enhanceLevel(claim);
  const isMax = level >= ENHANCE_MAX;
  return {
    level,
    max: ENHANCE_MAX,
    chance: isMax ? null : ENHANCE_CHANCES[level],
    cost: isMax ? null : ENHANCE_COSTS[level],
    dropOnFail: !isMax && level >= ENHANCE_DROP_FROM,
    dropFrom: ENHANCE_DROP_FROM,
    incomePercent: level * ENHANCE_INCOME_PERCENT,
    luckPercent: level * ENHANCE_LUCK_PERCENT,
    perLevel: { income: ENHANCE_INCOME_PERCENT, luck: ENHANCE_LUCK_PERCENT },
    canTranscend: isMax,
    transcend: {
      count: transcendCount,
      tier: transcendTier(transcendCount),
      bonusPercent: transcendCount * TRANSCEND_INCOME_PERCENT,
      perTranscend: TRANSCEND_INCOME_PERCENT,
    },
  };
}

module.exports = {
  ENHANCE_MAX,
  ENHANCE_CHANCES,
  ENHANCE_COSTS,
  ENHANCE_DROP_FROM,
  TRANSCEND_INCOME_PERCENT,
  TRANSCEND_TIERS,
  transcendTier,
  enhanceLevel,
  rollEnhance,
  transcendEffects,
  enhanceResponse,
};
