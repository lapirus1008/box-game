// routes/box.js
// 로그인한 사용자가 상자를 열어 아이템을 모으는 API입니다.
//
// [핵심 구조 - 모드 시스템]
// 이 게임은 "기록모드"와 "수집모드", 두 개의 완전히 분리된 세이브로 동작합니다.
// 계정의 현재 활성 모드는 users.active_mode 에 저장되고, 모든 API는 요청이 올 때마다
// 이 값을 먼저 확인해서 그 모드에 해당하는 골드/충전/아이템/도감만 읽고 씁니다.
//
//   - 기록모드 (record):     환생을 반복하며 랭킹과 경쟁합니다.
//                            환생하거나 초심으로 돌아가면 골드·아이템뿐 아니라
//                            도감(발견기록)도 함께 초기화됩니다. ("도감은 이번 판만")
//   - 수집모드 (collection):  환생이 없습니다. 상자를 열어 도감을 영구히 채워나가는 데
//                            집중하는 모드입니다. 초심으로 돌아가기를 해도 도감은
//                            절대 지워지지 않습니다.
//
// 두 모드는 골드/충전/보유아이템/도감까지 전부 독립적이라, 사실상 계정 하나에
// 두 개의 세이브 슬롯이 있는 것과 같습니다. (마이그레이션에서 각 테이블에 mode
// 컬럼을 추가하고 UNIQUE 제약을 (user_id, mode[, item_key])로 바꿔두었습니다.)
//
// [방치형 성장 구조]
// - 골드는 시간이 지나면 자동으로 쌓입니다. 기본 분당 60G + 보유 아이템마다 등급별 분당 골드.
// - 상자는 시간이 지날수록 충전이 쌓이고(최대 100개), 원할 때 열 수 있습니다.
// - 자리를 비운 시간은 창고의 "보관 시간"까지만 인정됩니다 (기본 4시간).
// - 골드로 업그레이드(수입·충전 속도·창고·행운), 자동 개봉 시간(시간 충전식), 자동 합성을 살 수 있습니다.
// - 기록모드에서는 30만 골드(REBIRTH_GOLD_REQUIRED)를 모으면 "환생"해서 환생 포인트를 받고, 환생 상점에서 영구 특성을 삽니다.
//
// 게임 수치는 game/config.js, 확률/계산 로직은 game/logic.js, DB 읽기·쓰기는 game/store.js에 있습니다.

const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/auth');
const { HttpError, withUserTransaction, handle } = require('../lib/http');
const {
  MODES,
  VALID_MODES,
  TREASURES,
  TREASURE_BY_KEY,
  CRAFT_COST,
  REBIRTH_GOLD_REQUIRED,
  SEASON_GOLD_REQUIRED,
  EFFECT_TYPE_CAPS,
  SPLIT_STEPS,
  COLLECTOR_RANKS,
  MAX_BOX_CHARGES,
  MAX_GOLD_BOX_PURCHASE,
  GOLD_PER_BOX_PURCHASE,
  BOX_PRICE_REF_INCOME,
  BOX_PRICE_EXPONENT,
  MASTERY_THRESHOLDS,
  UPGRADES,
  AUTO_CRAFT,
  HOUR_MS,
  PRESTIGE_GOLD_PER_POINT,
  PRESTIGE_PERKS,
  PERK_INCOME_PERCENT,
  AWAY_SUMMARY_MIN_MS,
  GOLDEN_BOX_MIN_GAP_MS,
  GOLDEN_BOX_MAX_GAP_MS,
  GOLDEN_BOX_WINDOW_MS,
  GOLDEN_BOX_REWARDS,
  GOLDEN_GOLD_MINUTES,
  GOLDEN_GOLD_MIN,
  GOLDEN_BOXES,
  INCOME_BOOST_MS,
  INCOME_BOOST_MULTIPLIER,
  ACHIEVEMENTS,
  ITEM_EFFECTS,
} = require('../game/config');
const {
  rollWithPity,
  rollBoxes,
  getRotationMythics,
  getSeasonDexItems,
  getItemEffectValue,
  EFFECT_TYPE_EMOJI,
  getNextCraftRarity,
  pickRandomFromRarity,
  craftCascade,
  toObtainedList,
  describeMythicEffect,
  getItemStars,
  getCollectorRank,
  getUpgradeCost,
  describeUpgradeEffect,
  getPerkLevel,
  getPerkCost,
  getBoxPrice,
  getBoxPurchaseCost,
  getMaxAffordableBoxes,
  expectedIncomePerBox,
  describeItemEffect,
  getAutoOpenCostPerHour,
  formatHours,
  getPrestigePointsForRun,
} = require('../game/logic');
const store = require('../game/store');
const { MYTHICS } = require('../game/mythics');
const collection = require('../game/collection');
const skills = require('../game/skills');
const { getSeason, getSeasonStart, getSeasonEnd, getDay, getDayStart, getDayEnd, getNextDayForRotation } = require('../game/season');

const router = express.Router();

// 이 아래의 모든 API는 로그인이 필요합니다.
router.use(verifyToken);

const NOT_STARTED_MESSAGE = '아직 게임을 시작하지 않았습니다.';
const LEADERBOARD_PAGE_SIZE = 10;

// 요청 body의 quantity를 검사해서 1 ~ max 사이의 정수로 돌려줍니다.
function parseQuantity(rawQuantity, max, overMaxMessage) {
  const quantity = parseInt(rawQuantity, 10);
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new HttpError(400, '수량은 1 이상의 정수여야 합니다.');
  }
  if (quantity > max) {
    throw new HttpError(400, overMaxMessage);
  }
  return quantity;
}

// 트랜잭션을 열고, 현재 모드의 세이브를 "지금" 기준으로 정산한 뒤 fn을 실행합니다.
// 거의 모든 API가 이 순서(모드 확인 → 정산 → 작업)를 따릅니다.
// 같은 계정의 요청은 서버 안에서 차례로 처리합니다. (lib/http.js withUserTransaction 참고)
function withSave(userId, fn) {
  return withUserTransaction(userId, async (client) => {
    const mode = await store.getActiveMode(client, userId);
    const save = await store.settle(client, userId, mode);
    if (!save) throw new HttpError(400, NOT_STARTED_MESSAGE);
    return fn(client, mode, save);
  });
}

function pityResponse(save, pity, triggered) {
  return { mythicPity: pity, mythicPityLimit: save.stats.pityLimit, mythicPityTriggered: triggered };
}

function boxPriceOf(save) {
  return getBoxPrice(save.income.perMinuteIncome, save.stats.boxDiscountPercent);
}

// 골드 상자 가격 계산 기준 (화면도 같은 값으로 총액을 미리 계산합니다)
function boxPricingOf(save) {
  const s = save.stats;
  // 수입 배율(강화·환생 특성·신화 효과·신화 도감)까지 반영한, 상자 1개당 평균 분당 수입 증가량
  const multiplier = s.upgradeIncomePercent * s.prestigeIncomePercent * s.itemIncomePercent / 1000000;
  return {
    income: save.income.perMinuteIncome,
    step: expectedIncomePerBox(s.luckPercent) * multiplier,
    discountPercent: s.boxDiscountPercent,
    minPrice: GOLD_PER_BOX_PURCHASE,
    refIncome: BOX_PRICE_REF_INCOME,
    exponent: BOX_PRICE_EXPONENT,
  };
}

// 지금 적용 중인 아이템 효과 요약 (효과 종류별 합계, 화면 표시용)
// sources: 이 효과를 주는 아이템 이름들 (많으면 앞의 몇 개만)
function activeItemEffects(save) {
  const effects = save.stats.effects;
  const sourcesByType = {};
  for (const [key, count] of Object.entries(save.owned)) {
    const effect = ITEM_EFFECTS[key];
    if (!effect || !(count > 0)) continue;
    (sourcesByType[effect.type] = sourcesByType[effect.type] || []).push(TREASURE_BY_KEY.get(key).name);
  }
  const rule = save.claim.season_rule;
  if (rule) (sourcesByType[rule.type] = sourcesByType[rule.type] || []).push(`${rule.emoji} 오늘의 규칙`);
  return Object.keys(EFFECT_TYPE_CAPS)
    .filter(type => effects[type] > 0)
    .map(type => ({
      key: type,
      emoji: EFFECT_TYPE_EMOJI[type],
      text: describeItemEffect(type, effects[type]),
      maxed: effects[type] >= EFFECT_TYPE_CAPS[type],
      maxText: describeItemEffect(type, EFFECT_TYPE_CAPS[type]),
      sources: sourcesByType[type] || [],
    }));
}

// 아이템 하나의 효과 설명: 1개당 / 지금 / 이 아이템 최대치 (효과가 없으면 null)
function itemEffectInfo(key, count) {
  const effect = ITEM_EFFECTS[key];
  if (!effect) return null;
  return {
    type: effect.type,
    per: describeItemEffect(effect.type, effect.perItem),
    now: count > 0 ? describeItemEffect(effect.type, getItemEffectValue(effect, count)) : null,
    max: describeItemEffect(effect.type, effect.max),
    maxCount: Math.round(effect.max / effect.perItem),
  };
}

// 오늘의 규칙 (화면 표시용)
function ruleResponse(rule) {
  return { key: rule.key, emoji: rule.emoji, name: rule.name, text: describeItemEffect(rule.type, rule.value) };
}

// 시즌(매주) + 오늘(매일 바뀌는 신화 10종·규칙) 정보 (메인 화면 배너 · 변경 안내용)
// have: 수집모드는 신화 도감에 있는지, 기록모드는 이번 판 가방에 있는지
function seasonResponse(mode, save) {
  const isCollection = mode === MODES.COLLECTION;
  const mythics = getRotationMythics(save.rotation).map(m => {
    const have = isCollection ? save.codex.has(m.key) : (save.owned[m.key] || 0) > 0;
    return {
      key: m.key,
      name: have ? m.name : null,
      emoji: m.emoji,
      tier: m.tier,
      effect: describeItemEffect(m.effect.type, m.effect.perItem),
      have,
    };
  });
  return {
    number: save.season,
    rotation: save.rotation,
    startsAt: getSeasonStart(save.season),
    endsAt: getSeasonEnd(save.season),       // 시즌(기록모드 초기화·랭킹) 끝나는 시각
    day: save.day,
    dayEndsAt: getDayEnd(save.day),          // 오늘의 신화·규칙이 바뀌는 시각
    rule: ruleResponse(save.claim.season_rule),
    mythics,
    haveCount: mythics.filter(m => m.have).length,
  };
}

// 신화 도감 요약 (수집모드 전용, 기록모드는 null)
function codexSummary(mode, save) {
  if (mode !== MODES.COLLECTION) return null;
  return { obtained: save.codex.size, total: MYTHICS.length };
}

// 기록모드 페이스: 이번 판 구간 기록을 시즌 최고 기록의 같은 구간과 비교합니다.
// deltaMs < 0 이면 최고 기록보다 빠름. 아직 비교할 구간이 없으면 null.
function paceResponse(mode, save) {
  if (mode !== MODES.RECORD) return null;
  const splits = Array.isArray(save.claim.run_splits) ? save.claim.run_splits : [];
  const best = Array.isArray(save.claim.best_splits) ? save.claim.best_splits : [];
  const bestRunMs = save.claim.best_run_ms != null ? Number(save.claim.best_run_ms) : null;
  const index = splits.length - 1;
  return {
    steps: SPLIT_STEPS,
    reached: splits.length,                       // 지나온 구간 수 (1 = 10%)
    lastSplitMs: index >= 0 ? splits[index] : null,
    deltaMs: index >= 0 && best[index] != null ? splits[index] - best[index] : null,
    bestRunMs,
    nextSplitBestMs: best[splits.length] != null ? best[splits.length] : null, // 다음 구간을 최고 기록은 몇 분에 지났는지
  };
}

function chargeResponse(chargeInfo, chargesUsed = 0) {
  return {
    charges: chargeInfo.charges - chargesUsed,
    maxCharges: chargeInfo.maxCharges,
    nextChargeInMs: chargeInfo.nextChargeInMs,
    serverTime: chargeInfo.serverTime,
  };
}

// 정산 중에 자동 개봉/자동 합성이 일어났다면 화면에 알려줄 수 있도록 응답에 실어 보냅니다.
function autoEventResponse(save) {
  return {
    autoOpened: save.autoOpened
      ? { count: save.autoOpened.count, obtained: toObtainedList(save.autoOpened.counts), pityTriggered: save.autoOpened.pityTriggered, sealed: save.autoOpened.sealed || 0 }
      : null,
    autoCrafted: save.autoCrafted,
  };
}

// 업그레이드 상점 / 자동화 / 환생 포인트 정보 (화면 표시용)
function progressionResponse(mode, save) {
  const { claim, stats } = save;
  const prestigeEnabled = store.isPrestigeMode(mode);
  const basePoints = prestigeEnabled ? getPrestigePointsForRun(claim.run_gold_earned) : 0;
  const mythicBonus = prestigeEnabled ? mythicKindsThisRun(save) : 0;
  const pointsOnRebirth = basePoints + mythicBonus;
  const autoOpenRemainingMs = Number(claim.auto_open_remaining_ms);
  return {
    storageMs: stats.storageMs,
    upgradeDiscountPercent: stats.upgradeDiscountPercent,
    upgrades: UPGRADES.filter(upgrade => !upgrade.collectionOnly || mode === MODES.COLLECTION).map(upgrade => {
      const level = claim[upgrade.column];
      const isMax = level >= upgrade.maxLevel;
      return {
        key: upgrade.key,
        name: upgrade.name,
        emoji: upgrade.emoji,
        level,
        maxLevel: upgrade.maxLevel,
        cost: isMax ? null : skillDiscountedUpgradeCost(getUpgradeCost(upgrade, level, stats.upgradeDiscountPercent), claim),
        effect: describeUpgradeEffect(upgrade.key, level),
        nextEffect: isMax ? null : describeUpgradeEffect(upgrade.key, level + 1),
      };
    }),
    autoOpen: {
      enabled: claim.auto_open_enabled,
      remainingMs: autoOpenRemainingMs,
      maxMs: stats.storageMs,
      costPerHour: getAutoOpenCostPerHour(save.income.perMinuteIncome, stats.autoOpenDiscountPercent),
      discountPercent: stats.autoOpenDiscountPercent,
    },
    autoCraft: {
      key: AUTO_CRAFT.key,
      name: AUTO_CRAFT.name,
      emoji: AUTO_CRAFT.emoji,
      desc: AUTO_CRAFT.desc,
      cost: AUTO_CRAFT.cost,
      unlocked: claim[AUTO_CRAFT.unlockedColumn],
      enabled: claim[AUTO_CRAFT.enabledColumn],
    },
    prestige: {
      enabled: prestigeEnabled,
      points: claim.prestige_points,
      incomeBonusPercent: getPerkLevel(claim, 'income') * PERK_INCOME_PERCENT,
      runGoldEarned: parseInt(claim.run_gold_earned, 10),
      pointsOnRebirth,
      nextPointAt: (basePoints + 1) * PRESTIGE_GOLD_PER_POINT,
      mythicBonus,
      perks: PRESTIGE_PERKS.map(perk => ({
        key: perk.key,
        emoji: perk.emoji,
        name: perk.name,
        desc: perk.desc,
        cost: getPerkLevel(claim, perk.key) >= perk.maxLevel ? null : getPerkCost(perk, getPerkLevel(claim, perk.key)),
        level: getPerkLevel(claim, perk.key),
        maxLevel: perk.maxLevel,
      })),
    },
  };
}

// 오래 자리를 비웠다가 돌아왔을 때 보여줄 요약 (짧게 비웠으면 null)
function awaySummary(save) {
  if (!save.previousActiveAt) return null;
  const awayMs = save.now - save.previousActiveAt;
  if (awayMs < AWAY_SUMMARY_MIN_MS) return null;

  const opened = save.autoOpened;
  const notable = opened
    ? toObtainedList(opened.counts, ['name', 'emoji', 'rarity'])
        .filter(item => ['epic', 'legendary', 'mythic'].includes(item.rarity))
    : [];
  return {
    awayMs,
    storageCapped: save.storageCapped,
    storageText: formatHours(save.stats.storageMs),
    goldEarned: save.earned,
    autoOpenedCount: opened ? opened.count : 0,
    autoCraftCount: save.autoCrafted ? save.autoCrafted.count : 0,
    sealedGained: opened ? opened.sealed || 0 : 0,
    notable,
  };
}

// 아직 열지 않은 신화 상자 (메인 화면 배지용)
function sealedResponse(save) {
  const list = store.sealedList(save.claim);
  return { count: list.length, since: list.length ? list[0].at : null };
}

function incomeResponse(save) {
  const boostUntil = save.claim.income_boost_until ? new Date(save.claim.income_boost_until) : null;
  return {
    ...save.income,
    lastCollectedAt: save.now,
    boostUntil: boostUntil && boostUntil > save.now ? boostUntil : null,
    boostMultiplier: INCOME_BOOST_MULTIPLIER,
  };
}

// -------------------------------
// 황금 상자 일정
// -------------------------------
// 도감 40종 마일스톤: 등장 간격 ×0.75
function randomGoldenGap(save) {
  const factor = save && save.milestones ? save.milestones.goldenGapFactor : 1;
  return Math.round((GOLDEN_BOX_MIN_GAP_MS + Math.random() * (GOLDEN_BOX_MAX_GAP_MS - GOLDEN_BOX_MIN_GAP_MS)) * factor);
}

// 접속 중(상태 조회)일 때만 호출합니다. 다음 등장 시각이 없거나 이미 놓쳤다면 새로 잡습니다.
async function syncGoldenBox(client, userId, mode, save) {
  const now = save.now;
  let nextAt = save.claim.golden_box_next_at ? new Date(save.claim.golden_box_next_at) : null;
  if (!nextAt || now - nextAt > GOLDEN_BOX_WINDOW_MS) {
    nextAt = new Date(now.getTime() + randomGoldenGap(save));
    await store.updateClaim(client, userId, mode, { golden_box_next_at: nextAt });
    save.claim.golden_box_next_at = nextAt;
  }
  return goldenBoxResponse(save);
}

// 황금 상자 규칙 (화면의 안내 팝업에 그대로 보여줍니다)
const GOLDEN_REWARD_TEXT = {
  gold: `💰 골드 (분당 수입 × ${GOLDEN_GOLD_MINUTES}분, 최소 ${GOLDEN_GOLD_MIN.toLocaleString()}G)`,
  boxes: `📦 상자 ${GOLDEN_BOXES}개 즉시 개봉`,
  boost: `⚡ ${INCOME_BOOST_MS / 60000}분간 수입 ${INCOME_BOOST_MULTIPLIER}배 (중복 시 시간 연장)`,
  autoOpen: '⏳ 자동 개봉 +1시간 (보관 시간이 꽉 찼으면 골드로)',
};
const GOLDEN_BOX_INFO = (() => {
  const total = GOLDEN_BOX_REWARDS.reduce((sum, r) => sum + r.weight, 0);
  return {
    minGapMinutes: GOLDEN_BOX_MIN_GAP_MS / 60000,
    maxGapMinutes: GOLDEN_BOX_MAX_GAP_MS / 60000,
    windowSeconds: GOLDEN_BOX_WINDOW_MS / 1000,
    rewards: GOLDEN_BOX_REWARDS.map(r => ({ text: GOLDEN_REWARD_TEXT[r.key], chancePercent: Math.round(r.weight / total * 100) })),
  };
})();

function goldenBoxResponse(save) {
  const nextAt = save.claim.golden_box_next_at ? new Date(save.claim.golden_box_next_at) : null;
  if (!nextAt) return { available: false, appearsInMs: null, expiresInMs: null, info: GOLDEN_BOX_INFO };
  const available = save.now >= nextAt && save.now - nextAt <= GOLDEN_BOX_WINDOW_MS;
  return {
    available,
    appearsInMs: available ? 0 : Math.max(0, nextAt - save.now),
    expiresInMs: nextAt.getTime() + GOLDEN_BOX_WINDOW_MS - save.now.getTime(),
    info: GOLDEN_BOX_INFO,
  };
}

// -------------------------------
// 업적
// -------------------------------
function getStatValue(claim, stat) {
  if (stat === 'rebirths') return claim.rebirth_count;
  return Number((claim.lifetime_stats || {})[stat]) || 0;
}

function describeReward(reward) {
  if (reward.mythicChoice) return `🎁 신화 선택 상자 ${reward.mythicChoice}`;
  return reward.points ? `✨ 환생 포인트 ${reward.points}` : `💰 ${reward.gold.toLocaleString()}G`;
}

// -------------------------------
// 신화 선택 상자 (수집모드 전용)
// -------------------------------
// 수집가 칭호가 오를 때마다(도감 10·30·60·90종) 1개씩 줍니다. 마지막 칭호(100종 완성)는 고를 신화가 없으므로 제외.
// 이미 받은 단계는 collector_rank_rewarded에 기록해서 중복 지급하지 않습니다. (기존 유저는 현재 칭호까지 소급 지급)
const LAST_REWARDABLE_RANK = COLLECTOR_RANKS.reduce((last, r, i) => (r.minObtained < MYTHICS.length ? i : last), 0);
function collectorRankIndex(count) {
  let index = 0;
  COLLECTOR_RANKS.forEach((r, i) => { if (count >= r.minObtained) index = i; });
  return index;
}
async function grantCollectorRankRewards(client, userId, mode, save) {
  if (mode !== MODES.COLLECTION) return null;
  const reached = Math.min(collectorRankIndex(save.codex.size), LAST_REWARDABLE_RANK);
  const rewarded = save.claim.collector_rank_rewarded || 0;
  if (reached <= rewarded) return null;
  const count = reached - rewarded;
  save.claim.mythic_choice_boxes = (save.claim.mythic_choice_boxes || 0) + count;
  save.claim.collector_rank_rewarded = reached;
  await store.updateClaim(client, userId, mode, {
    mythic_choice_boxes: save.claim.mythic_choice_boxes,
    collector_rank_rewarded: reached,
  });
  const rank = COLLECTOR_RANKS[reached];
  return { count, rank: { emoji: rank.emoji, name: rank.name } };
}
function choiceBoxResponse(mode, save) {
  if (mode !== MODES.COLLECTION) return null;
  return { count: save.claim.mythic_choice_boxes || 0, remainingMythics: MYTHICS.length - save.codex.size };
}

// -------------------------------
// 수집모드 성장: 신화 조각 · 각성 · 세트 · 일일 미션 (game/collection.js)
// -------------------------------
function missionsResponse(save) {
  const state = collection.normalizeMissionState(save.claim.daily_missions, save.day);
  const list = collection.getDailyMissions(save.day).map(m => {
    const progress = Math.min(m.goal, state.progress[m.key] || 0);
    return { key: m.key, emoji: m.emoji, text: m.text, goal: m.goal, progress, shards: m.shards,
      claimed: Boolean(state.claimed[m.key]), claimable: !state.claimed[m.key] && progress >= m.goal };
  });
  const allDone = list.every(m => m.claimed);
  return {
    list,
    allClear: { shards: collection.MISSION_ALL_CLEAR_SHARDS, claimed: Boolean(state.claimed.allClear), claimable: allDone && !state.claimed.allClear },
    claimable: list.filter(m => m.claimable).length + (allDone && !state.claimed.allClear ? 1 : 0),
    resetsAt: getDayEnd(save.day),
  };
}
function collectionResponse(mode, save) {
  if (mode !== MODES.COLLECTION) return null;
  const bonus = collection.getCollectionBonus(save.codex, save.claim.mythic_awaken);
  const dismantle = collection.getDismantlable(save.owned);
  return {
    shards: save.claim.mythic_shards || 0,
    dismantle: { count: dismantle.count, shards: dismantle.shards },
    sets: { motifComplete: bonus.motifComplete, motifTotal: bonus.motifs.length, themeComplete: bonus.themeComplete, themeTotal: bonus.themes.length },
    stars: bonus.stars,
    choiceBoxPrice: collection.CHOICE_BOX_SHARD_PRICE,
    missions: missionsResponse(save),
    milestones: save.milestones ? { list: save.milestones.list, next: save.milestones.next } : null,
  };
}
function requireCollection(mode) {
  if (mode !== MODES.COLLECTION) throw new HttpError(400, '수집모드 전용 기능입니다.');
}

// 기록모드 환생 보너스: 이번 판에 가진 신화 종류 수만큼 환생 포인트 추가
function mythicKindsThisRun(save) {
  return MYTHIC_KEYS.filter(key => (save.owned[key] || 0) > 0).length;
}

// '장인의 손' 스킬 할인 적용
function skillDiscountedUpgradeCost(cost, claim) {
  const discount = Number((claim.skill_buffs || {}).upgradeDiscount) || 0;
  return discount > 0 ? Math.floor(cost * Math.max(0, 100 - discount) / 100) : cost;
}

// -------------------------------
// 신화 스킬 (game/skills.js)
// -------------------------------
function skillStatesOf(mode, save) {
  const isCollection = mode === MODES.COLLECTION;
  return skills.getSkillStates({
    have: isCollection ? (key => save.codex.has(key)) : (key => (save.owned[key] || 0) > 0),
    awaken: isCollection ? (save.claim.mythic_awaken || {}) : {},
    cooldowns: save.claim.skill_cooldowns || {},
    cooldownBonus: save.milestones ? save.milestones.skillCooldownBonus : 0,
    now: save.now,
  });
}
function skillsResponse(mode, save) {
  const buffs = skills.activeSkillBuffs(save.claim.skill_buffs || {}, save.now);
  const b = save.claim.skill_buffs || {};
  return {
    list: skillStatesOf(mode, save),
    active: {
      luck: buffs.luck ? { value: buffs.luck, until: b.luckUntil } : null,
      boxDiscount: buffs.boxDiscount ? { value: buffs.boxDiscount, until: b.discountUntil } : null,
      upgradeDiscount: buffs.upgradeDiscount || 0,
    },
  };
}

// 스킬 사용: POST /api/box/skill { type }
router.post('/skill', handle('서버 오류로 스킬을 쓰지 못했습니다.', async (req) => {
  const userId = req.user.userId;
  const type = req.body.type;
  const def = skills.SKILL_BY_TYPE[type];
  if (!def) throw new HttpError(400, '없는 스킬입니다.');

  return withSave(userId, async (client, mode, save) => {
    const state = skillStatesOf(mode, save).find(s => s.type === type);
    if (!state.unlocked) throw new HttpError(400, `${def.name}: 이 종류의 신화를 가지면 열립니다.`);
    if (!state.ready) throw new HttpError(400, `${def.name}: ${Math.ceil(state.remainingMs / 60000)}분 뒤에 다시 쓸 수 있습니다.`);

    const t = state.tier;
    const { claim, now } = save;
    const fields = {};
    const buffs = { ...(claim.skill_buffs || {}) };
    let gold = claim.total_treasure;
    let extra = '';

    switch (type) {
      case 'incomePercent': {
        const current = claim.income_boost_until && new Date(claim.income_boost_until) > now ? new Date(claim.income_boost_until) : now;
        fields.income_boost_until = new Date(current.getTime() + (3 + 2 * t) * 60000);
        break;
      }
      case 'chargeSpeed':
        fields.box_charges = Math.min(save.stats.maxCharges, save.chargeInfo.charges + 25 * t);
        break;
      case 'golden':
        fields.golden_box_next_at = now;
        break;
      case 'luck':
        buffs.luckUntil = new Date(now.getTime() + skills.SKILL_BUFF_MS);
        buffs.luckValue = 10 * t;
        break;
      case 'pity':
        fields.mythic_pity = Math.min(save.stats.pityLimit - 1, claim.mythic_pity + 100 * t);
        break;
      case 'boxDiscount':
        buffs.discountUntil = new Date(now.getTime() + skills.SKILL_BUFF_MS);
        buffs.discountValue = 10 + 5 * t;
        break;
      case 'upgradeDiscount':
        buffs.upgradeDiscount = Math.min(100, 25 * t);
        break;
      case 'autoOpenDiscount':
        fields.auto_open_remaining_ms = Math.min(save.stats.storageMs, Number(claim.auto_open_remaining_ms) + 30 * t * 60000);
        fields.auto_open_enabled = true;
        break;
      case 'storageMinutes': {
        const earned = Math.floor(save.income.perMinuteIncome * 15 * t);
        gold += earned;
        fields.total_treasure = gold;
        fields.run_gold_earned = Number(claim.run_gold_earned) + earned;
        extra = ` (+${earned.toLocaleString()}G)`;
        break;
      }
      default: break;
    }
    const cooldowns = { ...(claim.skill_cooldowns || {}), [type]: new Date(now.getTime() + state.cooldownMs) };
    await store.updateClaim(client, userId, mode, {
      ...fields,
      skill_buffs: JSON.stringify(buffs),
      skill_cooldowns: JSON.stringify(cooldowns),
    });
    return { message: `${def.emoji} ${def.name}! ${state.desc}${extra}`, mode, type, totalTreasure: gold };
  });
}));

// 중복 신화 분해: POST /api/box/dismantle — 효과가 겹치는 3개를 넘는 신화를 모두 신화 조각으로
router.post('/dismantle', handle('서버 오류로 분해하지 못했습니다.', async (req) => {
  const userId = req.user.userId;
  return withSave(userId, async (client, mode, save) => {
    requireCollection(mode);
    const d = collection.getDismantlable(save.owned);
    if (d.count === 0) throw new HttpError(400, '분해할 중복 신화가 없습니다. (신화는 3개까지 효과가 겹칩니다)');
    await store.addItems(client, userId, mode, Object.fromEntries(d.list.map(x => [x.key, -x.count])));
    const shards = (save.claim.mythic_shards || 0) + d.shards;
    await store.updateClaim(client, userId, mode, { mythic_shards: shards });
    return { message: `💎 중복 신화 ${d.count}개 분해 · 신화 조각 +${d.shards}`, mode, shards, gained: d.shards };
  });
}));

// 신화 각성: POST /api/box/awaken { key } — 도감에 있는 신화를 조각으로 ★ 올리기
router.post('/awaken', handle('서버 오류로 각성하지 못했습니다.', async (req) => {
  const userId = req.user.userId;
  const key = req.body.key;
  return withSave(userId, async (client, mode, save) => {
    requireCollection(mode);
    if (!collection.MYTHIC_BY_KEY[key]) throw new HttpError(400, '존재하지 않는 신화입니다.');
    if (!save.codex.has(key)) throw new HttpError(400, '도감에 있는 신화만 각성할 수 있습니다.');
    const awaken = { ...(save.claim.mythic_awaken || {}) };
    const level = collection.awakenLevel(awaken, key);
    if (level >= collection.AWAKEN_MAX) throw new HttpError(400, `이미 최고 단계(★${collection.AWAKEN_MAX})입니다.`);
    const cost = collection.AWAKEN_COSTS[level];
    const shards = save.claim.mythic_shards || 0;
    if (shards < cost) throw new HttpError(400, `신화 조각이 부족합니다. (필요 ${cost}, 보유 ${shards})`);
    awaken[key] = level + 1;
    await store.updateClaim(client, userId, mode, { mythic_awaken: JSON.stringify(awaken), mythic_shards: shards - cost });
    const m = collection.MYTHIC_BY_KEY[key];
    return { message: `✨ ${m.name} ★${level + 1} 각성! (전체 수입 +${collection.AWAKEN_INCOME_PERCENT}%)`, mode, key, level: level + 1, shards: shards - cost };
  });
}));

// 조각 상점: POST /api/box/shard-shop { item: 'choiceBox' }
router.post('/shard-shop', handle('서버 오류로 구매하지 못했습니다.', async (req) => {
  const userId = req.user.userId;
  return withSave(userId, async (client, mode, save) => {
    requireCollection(mode);
    if (req.body.item !== 'choiceBox') throw new HttpError(400, '없는 상품입니다.');
    if (save.codex.size >= MYTHICS.length) throw new HttpError(400, '도감을 모두 채워서 고를 신화가 없습니다.');
    const price = collection.CHOICE_BOX_SHARD_PRICE;
    const shards = save.claim.mythic_shards || 0;
    if (shards < price) throw new HttpError(400, `신화 조각이 부족합니다. (필요 ${price}, 보유 ${shards})`);
    const boxes = (save.claim.mythic_choice_boxes || 0) + 1;
    await store.updateClaim(client, userId, mode, { mythic_shards: shards - price, mythic_choice_boxes: boxes });
    return { message: '🎁 신화 선택 상자 구매!', mode, shards: shards - price, choiceBoxes: boxes };
  });
}));

// 일일 미션 보상: POST /api/box/mission { key } (key = 미션 key 또는 'allClear')
router.post('/mission', handle('서버 오류로 보상을 받지 못했습니다.', async (req) => {
  const userId = req.user.userId;
  const key = req.body.key;
  return withSave(userId, async (client, mode, save) => {
    requireCollection(mode);
    const missions = missionsResponse(save);
    let reward;
    if (key === 'allClear') {
      if (!missions.allClear.claimable) throw new HttpError(400, '오늘의 미션을 모두 완료하면 받을 수 있습니다.');
      reward = missions.allClear.shards;
    } else {
      const m = missions.list.find(x => x.key === key);
      if (!m) throw new HttpError(400, '오늘의 미션이 아닙니다.');
      if (m.claimed) throw new HttpError(400, '이미 보상을 받았습니다.');
      if (!m.claimable) throw new HttpError(400, '아직 완료하지 않은 미션입니다.');
      reward = m.shards;
    }
    const state = collection.normalizeMissionState(save.claim.daily_missions, save.day);
    state.claimed[key] = true;
    const shards = (save.claim.mythic_shards || 0) + reward;
    await store.updateClaim(client, userId, mode, { daily_missions: JSON.stringify(state), mythic_shards: shards });
    return { message: `📅 미션 보상 · 신화 조각 +${reward}`, mode, shards, gained: reward };
  });
}));

function achievementsResponse(mode, claim) {
  const claimed = claim.achievements_claimed || {};
  if (store.isPrestigeMode(mode)) return { achievements: [], claimableAchievements: 0 };
  const list = ACHIEVEMENTS.map(a => {
    const value = getStatValue(claim, a.stat);
    const isClaimed = Boolean(claimed[a.key]);
    return {
      key: a.key,
      emoji: a.emoji,
      name: a.name,
      stat: a.stat,
      goal: a.goal,
      progress: Math.min(value, a.goal),
      claimed: isClaimed,
      claimable: !isClaimed && value >= a.goal,
      rewardText: describeReward(a.reward),
    };
  });
  return { achievements: list, claimableAchievements: list.filter(a => a.claimable).length };
}

// -------------------------------
// 모드 조회 / 전환: GET, POST /api/box/mode
// -------------------------------
router.get('/mode', handle('서버 오류가 발생했습니다.', async (req) => {
  const mode = await store.getActiveMode(db, req.user.userId);
  return { mode };
}));

router.post('/mode', handle('서버 오류로 모드를 전환하지 못했습니다.', async (req) => {
  const { mode } = req.body;
  if (!VALID_MODES.includes(mode)) {
    throw new HttpError(400, '올바르지 않은 모드입니다.');
  }

  await db.query('UPDATE users SET active_mode = $1 WHERE id = $2', [mode, req.user.userId]);
  return {
    message: mode === MODES.RECORD ? '기록모드로 전환했습니다.' : '수집모드로 전환했습니다.',
    mode,
  };
}));

// 충전으로 상자를 열 수 있는지 확인합니다.
function assertCanOpen(save, quantity) {
  if (save.claim.auto_open_enabled && Number(save.claim.auto_open_remaining_ms) > 0) {
    throw new HttpError(400, '자동 개봉 중에는 충전된 상자가 자동으로 열립니다.', chargeResponse(save.chargeInfo));
  }
  if (save.chargeInfo.charges < quantity) {
    if (quantity === 1) {
      throw new HttpError(429, '충전된 상자가 없습니다. 잠시 후 다시 시도해주세요.', {
        charges: save.chargeInfo.charges,
        maxCharges: save.chargeInfo.maxCharges,
        nextChargeInMs: save.chargeInfo.nextChargeInMs,
      });
    }
    throw new HttpError(400, `충전된 상자가 부족합니다. (요청: ${quantity}개, 보유: ${save.chargeInfo.charges}개)`, {
      maxAffordable: save.chargeInfo.charges,
    });
  }
}

// -------------------------------
// 상자 열기: POST /api/box/open (충전 1개 소모)
// -------------------------------
router.post('/open', handle('서버 오류로 상자를 열지 못했습니다.', async (req) => {
  const userId = req.user.userId;

  return withSave(userId, async (client, mode, save) => {
    assertCanOpen(save, 1);

    const roll = rollWithPity(save.claim.mythic_pity, store.rollContextOf(save));
    await store.updateClaim(client, userId, mode, {
      box_charges: save.chargeInfo.charges - 1,
      mythic_pity: roll.pity,
    });
    await store.addItems(client, userId, mode, { [roll.treasure.key]: 1 });
    await store.saveStats(client, userId, mode, save.claim, store.boxStatDeltas(1, { [roll.treasure.key]: 1 }));
    await store.bumpMission(client, userId, mode, save.claim, save.day, 'tapOpen');

    return {
      message: '상자를 열었습니다!',
      mode,
      treasure: roll.treasure.effect ? { ...roll.treasure, effectText: describeMythicEffect(roll.treasure) } : roll.treasure,
      ...pityResponse(save, roll.pity, roll.guaranteed),
      totalTreasure: save.claim.total_treasure,
      ...chargeResponse(save.chargeInfo, 1),
      ...autoEventResponse(save),
    };
  });
}));

// -------------------------------
// 수량 지정 일괄 열기: POST /api/box/bulk-open (충전 quantity개 소모)
// -------------------------------
router.post('/bulk-open', handle('서버 오류로 일괄 열기에 실패했습니다.', async (req) => {
  const userId = req.user.userId;
  const quantity = parseQuantity(
    req.body.quantity,
    MAX_BOX_CHARGES,
    `한 번에 최대 ${MAX_BOX_CHARGES}개까지만 열 수 있습니다.`
  );

  return withSave(userId, async (client, mode, save) => {
    assertCanOpen(save, quantity);

    const { counts, pity, pityTriggered } = rollBoxes(save.claim.mythic_pity, quantity, store.rollContextOf(save));
    await store.updateClaim(client, userId, mode, {
      box_charges: save.chargeInfo.charges - quantity,
      mythic_pity: pity,
    });
    await store.addItems(client, userId, mode, counts);
    await store.saveStats(client, userId, mode, save.claim, store.boxStatDeltas(quantity, counts));

    return {
      message: `상자 ${quantity}개를 열었습니다!`,
      mode,
      quantity,
      ...pityResponse(save, pity, pityTriggered),
      totalTreasure: save.claim.total_treasure,
      obtained: toObtainedList(counts),
      ...chargeResponse(save.chargeInfo, quantity),
      ...autoEventResponse(save),
    };
  });
}));

// -------------------------------
// 신화 상자 열기: POST /api/box/open-sealed (자동 개봉 중에 나와서 보관해 둔 신화를 한 번에 엽니다)
// -------------------------------
router.post('/open-sealed', handle('서버 오류로 신화 상자를 열지 못했습니다.', async (req) => {
  const userId = req.user.userId;

  return withSave(userId, async (client, mode, save) => {
    const sealed = store.sealedList(save.claim);
    if (sealed.length === 0) throw new HttpError(400, '열 수 있는 신화 상자가 없습니다.');

    const counts = {};
    for (const s of sealed) counts[s.key] = (counts[s.key] || 0) + 1;
    await store.addItems(client, userId, mode, counts);
    await store.saveStats(client, userId, mode, save.claim, store.countRareGains(counts));
    await store.updateClaim(client, userId, mode, { sealed_mythics: '[]' });

    return {
      message: `🔮 신화 상자 ${sealed.length}개 개봉!`,
      mode,
      quantity: sealed.length,
      obtained: toObtainedList(counts),
      pityTriggered: sealed.some(s => s.pity),
      firstAt: sealed[0].at,
      totalTreasure: save.claim.total_treasure,
    };
  });
}));

// -------------------------------
// 신화 선택 상자 사용: POST /api/box/choose-mythic { key } (수집모드 전용)
// 아직 도감에 없는 신화 중 고른 1종을 받습니다.
// -------------------------------
router.post('/choose-mythic', handle('서버 오류로 신화를 받지 못했습니다.', async (req) => {
  const userId = req.user.userId;
  const key = req.body.key;
  return withSave(userId, async (client, mode, save) => {
    if (mode !== MODES.COLLECTION) throw new HttpError(400, '신화 선택 상자는 수집모드 전용입니다.');
    if ((save.claim.mythic_choice_boxes || 0) < 1) throw new HttpError(400, '신화 선택 상자가 없습니다.');
    if (!MYTHIC_KEYS.includes(key)) throw new HttpError(400, '존재하지 않는 신화입니다.');
    if (save.codex.has(key)) throw new HttpError(400, '이미 도감에 있는 신화입니다. 다른 신화를 선택하세요.');

    const counts = { [key]: 1 };
    await store.addItems(client, userId, mode, counts);
    await store.saveStats(client, userId, mode, save.claim, store.countRareGains(counts));
    await store.updateClaim(client, userId, mode, { mythic_choice_boxes: save.claim.mythic_choice_boxes - 1 });

    return {
      message: '🎁 신화 선택 상자 개봉!',
      mode,
      obtained: toObtainedList(counts),
      remainingBoxes: save.claim.mythic_choice_boxes - 1,
    };
  });
}));

// -------------------------------
// 쌓인 상자 모두 열기: POST /api/box/open-all (상자를 누르면 충전된 만큼 한 번에 엽니다)
// -------------------------------
router.post('/open-all', handle('서버 오류로 상자를 열지 못했습니다.', async (req) => {
  const userId = req.user.userId;

  return withSave(userId, async (client, mode, save) => {
    const quantity = save.chargeInfo.charges;
    if (quantity < 1) assertCanOpen(save, 1); // 충전이 없으면 안내 메시지와 함께 거절
    assertCanOpen(save, quantity);

    const { counts, pity, pityTriggered } = rollBoxes(save.claim.mythic_pity, quantity, store.rollContextOf(save));
    await store.updateClaim(client, userId, mode, {
      box_charges: save.chargeInfo.charges - quantity,
      mythic_pity: pity,
    });
    await store.addItems(client, userId, mode, counts);
    await store.saveStats(client, userId, mode, save.claim, store.boxStatDeltas(quantity, counts));
    await store.bumpMission(client, userId, mode, save.claim, save.day, 'tapOpen');

    return {
      message: `상자 ${quantity}개를 열었습니다!`,
      mode,
      quantity,
      ...pityResponse(save, pity, pityTriggered),
      totalTreasure: save.claim.total_treasure,
      obtained: toObtainedList(counts),
      ...chargeResponse(save.chargeInfo, quantity),
      ...autoEventResponse(save),
    };
  });
}));

// -------------------------------
// 골드로 상자 구매해서 열기: POST /api/box/buy-boxes (충전과 무관, 골드만 소모)
// -------------------------------
router.post('/buy-boxes', handle('서버 오류로 구매에 실패했습니다.', async (req) => {
  const userId = req.user.userId;
  const requestedQuantity = parseQuantity(
    req.body.quantity,
    MAX_GOLD_BOX_PURCHASE,
    `한 번에 최대 ${MAX_GOLD_BOX_PURCHASE}개까지만 구매할 수 있습니다.`
  );

  // upTo: "최대로" 구매. 화면이 계산한 최대 개수는 몇 초 전 가격·골드 기준이라(자동 개봉으로 수입이 오르면 가격도 오름)
  // 그 사이 조금 모자랄 수 있습니다. 이때는 오류 대신 지금 살 수 있는 만큼만 삽니다.
  const upTo = req.body.upTo === true;

  return withSave(userId, async (client, mode, save) => {
    const currentGold = save.claim.total_treasure;
    const pricing = boxPricingOf(save);
    let quantity = requestedQuantity;
    if (upTo) quantity = Math.min(quantity, getMaxAffordableBoxes(pricing, currentGold, MAX_GOLD_BOX_PURCHASE));
    if (quantity < 1) throw new HttpError(400, '골드가 부족합니다.');
    const { total: totalCost, firstPrice: boxPrice, lastPrice } = getBoxPurchaseCost(pricing, quantity);
    if (currentGold < totalCost) {
      throw new HttpError(400, `골드가 부족합니다. (필요: ${totalCost.toLocaleString()}G, 보유: ${currentGold.toLocaleString()}G)`, {
        maxAffordable: getMaxAffordableBoxes(pricing, currentGold, MAX_GOLD_BOX_PURCHASE),
      });
    }

    const { counts, pity, pityTriggered } = rollBoxes(save.claim.mythic_pity, quantity, store.rollContextOf(save));
    await store.addItems(client, userId, mode, counts);
    await store.saveStats(client, userId, mode, save.claim, store.boxStatDeltas(quantity, counts));
    await store.bumpMission(client, userId, mode, save.claim, save.day, 'buy');

    const remainingGold = currentGold - totalCost;
    await store.updateClaim(client, userId, mode, { total_treasure: remainingGold, mythic_pity: pity });

    return {
      message: `골드로 상자 ${quantity}개를 구매해서 열었습니다!`,
      mode,
      quantity,
      totalCost,
      boxPrice,
      lastPrice,
      ...pityResponse(save, pity, pityTriggered),
      totalTreasure: remainingGold,
      obtained: toObtainedList(counts),
      ...autoEventResponse(save),
    };
  });
}));

// -------------------------------
// 상태 조회: GET /api/box/status
// -------------------------------
router.get('/status', handle('서버 오류가 발생했습니다.', async (req) => {
  const userId = req.user.userId;

  return withUserTransaction(userId, async (client) => {
    const mode = await store.getActiveMode(client, userId);
    const isRecordMode = mode === MODES.RECORD;

    const save = await store.settle(client, userId, mode);
    if (!save) {
      return { mode, isRecordMode, charges: 0, maxCharges: MAX_BOX_CHARGES, totalTreasure: 0 };
    }
    const { claim } = save;

    // 최고 분당 수입 기록 (업적용)
    const bestIncome = Number((claim.lifetime_stats || {}).bestIncome) || 0;
    if (save.income.perMinuteIncome > bestIncome) {
      await store.saveStats(client, userId, mode, claim, { bestIncome: save.income.perMinuteIncome - bestIncome });
    }
    const goldenBox = await syncGoldenBox(client, userId, mode, save);
    const rankReward = await grantCollectorRankRewards(client, userId, mode, save);

    return {
      mode,
      isRecordMode,
      goldenBox,
      rankReward,
      choiceBox: choiceBoxResponse(mode, save),
      collection: collectionResponse(mode, save),
      skills: skillsResponse(mode, save),
      dailyGrant: save.dailyGrant || null,
      ...achievementsResponse(mode, claim),
      season: seasonResponse(mode, save),
      seasonChange: save.seasonChange,
      codex: codexSummary(mode, save),
      pace: paceResponse(mode, save),
      sealed: sealedResponse(save),
      seasonBest: isRecordMode ? await findMyRank(client, userId, save.season) : null,
      ...chargeResponse(save.chargeInfo),
      chargeIntervalMs: save.stats.chargeIntervalMs,
      totalTreasure: claim.total_treasure,
      mythicPity: claim.mythic_pity,
      mythicPityLimit: save.stats.pityLimit,
      pityReduction: save.stats.effects.pity, // 아이템 효과·이번 주 규칙으로 줄어든 천장
      boxPrice: boxPriceOf(save),
      boxPricing: boxPricingOf(save),
      rebirthGoldRequired: REBIRTH_GOLD_REQUIRED,
      itemEffects: activeItemEffects(save),
      income: incomeResponse(save),
      collectorRank: mode === MODES.COLLECTION ? getCollectorRank(save.codex.size) : null,
      rebirthCount: claim.rebirth_count,
      runStartedAt: claim.run_started_at,
      ...progressionResponse(mode, save),
      ...autoEventResponse(save),
      awaySummary: awaySummary(save),
    };
  });
}));

// -------------------------------
// 쌓인 골드 정산: POST /api/box/collect-income
// -------------------------------
// 골드는 모든 요청마다 자동으로 정산되지만, 즉시 정산하고 싶을 때를 위해 남겨둡니다.
router.post('/collect-income', handle('서버 오류로 수령에 실패했습니다.', async (req) => {
  return withSave(req.user.userId, async (client, mode, save) => ({
    message: save.earned > 0 ? `${save.earned}G를 받았습니다!` : '아직 쌓인 골드가 없습니다.',
    mode,
    earned: save.earned,
    totalTreasure: save.claim.total_treasure,
    perMinuteIncome: save.income.perMinuteIncome,
  }));
}));

// -------------------------------
// 업그레이드 구매: POST /api/box/upgrade { key }
// -------------------------------
router.post('/upgrade', handle('서버 오류로 업그레이드에 실패했습니다.', async (req) => {
  const userId = req.user.userId;
  const upgrade = UPGRADES.find(u => u.key === req.body.key);
  if (!upgrade) throw new HttpError(400, '존재하지 않는 업그레이드입니다.');

  return withSave(userId, async (client, mode, save) => {
    if (upgrade.collectionOnly && mode !== MODES.COLLECTION) throw new HttpError(400, '수집모드 전용 강화입니다.');
    const level = save.claim[upgrade.column];
    if (level >= upgrade.maxLevel) throw new HttpError(400, '이미 최대 레벨입니다.');

    const cost = skillDiscountedUpgradeCost(getUpgradeCost(upgrade, level, save.stats.upgradeDiscountPercent), save.claim);
    const gold = save.claim.total_treasure;
    if (gold < cost) throw new HttpError(400, `골드가 부족합니다. (필요: ${cost.toLocaleString()}G)`);

    const buffs = save.claim.skill_buffs || {};
    await store.updateClaim(client, userId, mode, {
      total_treasure: gold - cost,
      [upgrade.column]: level + 1,
      // '장인의 손' 할인은 한 번 쓰면 사라짐
      ...(buffs.upgradeDiscount ? { skill_buffs: JSON.stringify({ ...buffs, upgradeDiscount: 0 }) } : {}),
    });

    return {
      message: `${upgrade.emoji} ${upgrade.name} Lv.${level + 1} 달성! (${describeUpgradeEffect(upgrade.key, level + 1)})`,
      mode,
      key: upgrade.key,
      level: level + 1,
      totalTreasure: gold - cost,
    };
  });
}));

// -------------------------------
// 자동 개봉 시간 구매 / 켜기·끄기: POST /api/box/auto-open { hours | enabled }
// -------------------------------
// - hours: 1 이상의 정수 또는 'max'(보관 시간까지 가득). 산 만큼 자동 개봉이 돌아갑니다.
// - enabled: 켜고 끄기. 끄면 남은 시간이 줄지 않습니다.
router.post('/auto-open', handle('서버 오류로 자동 개봉 설정에 실패했습니다.', async (req) => {
  const userId = req.user.userId;
  const { hours, enabled } = req.body;

  return withSave(userId, async (client, mode, save) => {
    const gold = save.claim.total_treasure;
    const remainingMs = Number(save.claim.auto_open_remaining_ms);
    const maxMs = save.stats.storageMs;

    if (hours === undefined) {
      const on = Boolean(enabled);
      await store.updateClaim(client, userId, mode, { auto_open_enabled: on });
      return { message: `⏳ 자동 개봉을 ${on ? 'ON' : 'OFF'}`, mode, enabled: on, totalTreasure: gold };
    }

    const spaceMs = Math.max(0, maxMs - remainingMs);
    let addMs;
    if (hours === 'max') {
      addMs = spaceMs;
    } else {
      const n = parseInt(hours, 10);
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, '구매할 시간은 1시간 이상이어야 합니다.');
      addMs = n * HOUR_MS;
    }
    if (addMs <= 0 || addMs > spaceMs) {
      throw new HttpError(400, `자동 개봉 시간은 보관 시간(${formatHours(maxMs)})까지만 채울 수 있습니다. 창고를 확장하세요!`);
    }

    const costPerHour = getAutoOpenCostPerHour(save.income.perMinuteIncome, save.stats.autoOpenDiscountPercent);
    const cost = Math.ceil(costPerHour * addMs / HOUR_MS);
    if (gold < cost) throw new HttpError(400, `골드가 부족합니다. (필요: ${cost.toLocaleString()}G)`);

    const newRemaining = remainingMs + addMs;
    await store.updateClaim(client, userId, mode, {
      total_treasure: gold - cost,
      auto_open_remaining_ms: newRemaining,
      auto_open_enabled: true,
    });
    return {
      message: `⏳ 자동 개봉 시간 +${formatHours(addMs)}! (남은 시간 ${formatHours(newRemaining)})`,
      mode,
      enabled: true,
      remainingMs: newRemaining,
      totalTreasure: gold - cost,
    };
  });
}));

// -------------------------------
// 자동 합성 구매 / 켜기·끄기: POST /api/box/auto-craft { enabled }
// -------------------------------
// 아직 잠겨 있으면 골드를 내고 해금(켜진 상태로 시작)하고, 해금돼 있으면 enabled 값으로 켜고 끕니다.
router.post('/auto-craft', handle('서버 오류로 자동 합성 설정에 실패했습니다.', async (req) => {
  const userId = req.user.userId;
  const auto = AUTO_CRAFT;

  return withSave(userId, async (client, mode, save) => {
    const gold = save.claim.total_treasure;

    if (!save.claim[auto.unlockedColumn]) {
      if (gold < auto.cost) throw new HttpError(400, `골드가 부족합니다. (필요: ${auto.cost.toLocaleString()}G)`);
      await store.updateClaim(client, userId, mode, {
        total_treasure: gold - auto.cost,
        [auto.unlockedColumn]: true,
        [auto.enabledColumn]: true,
      });
      return { message: `${auto.emoji} ${auto.name} 해금!`, mode, unlocked: true, enabled: true, totalTreasure: gold - auto.cost };
    }

    const on = Boolean(req.body.enabled);
    await store.updateClaim(client, userId, mode, { [auto.enabledColumn]: on });
    return { message: `${auto.emoji} ${auto.name} ${on ? 'ON' : 'OFF'}`, mode, unlocked: true, enabled: on, totalTreasure: gold };
  });
}));

// -------------------------------
// 아이템 잠금: POST /api/box/lock { itemKey, locked }
// -------------------------------
// 잠근 아이템은 수동 합성·전체 합성·자동 합성의 재료로 쓰이지 않습니다. (모드별, 환생해도 유지)
router.post('/lock', handle('서버 오류로 잠금 설정에 실패했습니다.', async (req) => {
  const userId = req.user.userId;
  const { itemKey } = req.body;
  const item = typeof itemKey === 'string' ? TREASURE_BY_KEY.get(itemKey) : undefined;
  if (!item) throw new HttpError(400, '존재하지 않는 아이템입니다.');

  return withSave(userId, async (client, mode, save) => {
    const locked = store.lockedSet(save.claim);
    const lock = Boolean(req.body.locked);
    if (lock) locked.add(item.key);
    else locked.delete(item.key);
    await store.updateClaim(client, userId, mode, { locked_items: JSON.stringify([...locked]) });
    return {
      message: lock ? `🔒 ${item.name} 잠금 · 합성 재료에서 제외` : `🔓 ${item.name} 잠금 해제`,
      mode,
      itemKey: item.key,
      locked: lock,
    };
  });
}));

// -------------------------------
// 황금 상자 열기: POST /api/box/golden-box
// -------------------------------
function pickGoldenReward() {
  const total = GOLDEN_BOX_REWARDS.reduce((sum, r) => sum + r.weight, 0);
  let rand = Math.random() * total;
  for (const reward of GOLDEN_BOX_REWARDS) {
    if (rand < reward.weight) return reward.key;
    rand -= reward.weight;
  }
  return GOLDEN_BOX_REWARDS[0].key;
}

router.post('/golden-box', handle('서버 오류로 황금 상자를 열지 못했습니다.', async (req) => {
  const userId = req.user.userId;

  return withSave(userId, async (client, mode, save) => {
    const box = goldenBoxResponse(save);
    if (!box.available) {
      throw new HttpError(400, box.appearsInMs > 0
        ? '아직 황금 상자가 등장하지 않았습니다.'
        : '황금 상자가 사라졌습니다. 다음 기회를 노려보세요!');
    }

    const { claim, now } = save;
    const fields = { golden_box_next_at: new Date(now.getTime() + randomGoldenGap(save)) };
    const result = { reward: pickGoldenReward() };
    let gold = claim.total_treasure;
    const statDeltas = { golden: 1 };

    // 은하의 구슬: 황금 상자 보상 +N%
    const bonus = (value) => Math.floor(value * (100 + save.stats.goldenBonusPercent) / 100);
    const goldenBoxes = bonus(GOLDEN_BOXES);
    const giveGold = () => {
      const amount = bonus(Math.max(GOLDEN_GOLD_MIN, save.income.perMinuteIncome * GOLDEN_GOLD_MINUTES));
      gold += amount;
      fields.total_treasure = gold;
      fields.run_gold_earned = claim.run_gold_earned + amount;
      result.reward = 'gold';
      result.gold = amount;
      result.message = `💰 황금 상자! +${amount.toLocaleString()}G`;
    };

    if (result.reward === 'boxes') {
      const { counts, pity, pityTriggered } = rollBoxes(claim.mythic_pity, goldenBoxes, store.rollContextOf(save));
      await store.addItems(client, userId, mode, counts);
      fields.mythic_pity = pity;
      Object.assign(statDeltas, store.boxStatDeltas(goldenBoxes, counts));
      result.obtained = toObtainedList(counts);
      result.mythicPityTriggered = pityTriggered;
      result.message = `📦 황금 상자! 상자 ${goldenBoxes}개 개봉`;
    } else if (result.reward === 'boost') {
      const current = claim.income_boost_until ? new Date(claim.income_boost_until) : now;
      const boostMs = bonus(INCOME_BOOST_MS);
      const until = new Date(Math.max(now.getTime(), current.getTime()) + boostMs);
      fields.income_boost_until = until;
      result.boostUntil = until;
      result.message = `⚡ 황금 상자! ${Math.round(boostMs / 60000)}분간 수입 ${INCOME_BOOST_MULTIPLIER}배`;
    } else if (result.reward === 'autoOpen') {
      const remaining = Number(claim.auto_open_remaining_ms);
      const add = Math.min(HOUR_MS, save.stats.storageMs - remaining);
      if (add <= 0) {
        giveGold(); // 보관 시간이 꽉 찼으면 골드로 대신 줍니다
      } else {
        fields.auto_open_remaining_ms = remaining + add;
        fields.auto_open_enabled = true;
        result.message = `⏳ 황금 상자! 자동 개봉 +${formatHours(add)}`;
      }
    } else {
      giveGold();
    }

    await store.updateClaim(client, userId, mode, fields);
    await store.saveStats(client, userId, mode, claim, statDeltas);
    await store.bumpMission(client, userId, mode, claim, save.day, 'golden');
    return { ...result, mode, totalTreasure: gold };
  });
}));

// -------------------------------
// 업적 보상 받기: POST /api/box/achievement { key }
// -------------------------------
router.post('/achievement', handle('서버 오류로 업적 보상을 받지 못했습니다.', async (req) => {
  const userId = req.user.userId;
  const achievement = ACHIEVEMENTS.find(a => a.key === req.body.key);
  if (!achievement) throw new HttpError(400, '존재하지 않는 업적입니다.');

  return withSave(userId, async (client, mode, save) => {
    const { claim } = save;
    if (store.isPrestigeMode(mode)) throw new HttpError(400, '업적은 수집모드 전용입니다.');
    const claimedMap = claim.achievements_claimed || {};
    if (claimedMap[achievement.key]) throw new HttpError(400, '이미 보상을 받은 업적입니다.');
    if (getStatValue(claim, achievement.stat) < achievement.goal) throw new HttpError(400, '아직 달성하지 못한 업적입니다.');

    const fields = {
      achievements_claimed: JSON.stringify({ ...claimedMap, [achievement.key]: save.now.toISOString() }),
    };
    let gold = claim.total_treasure;
    if (achievement.reward.gold) {
      gold += achievement.reward.gold;
      fields.total_treasure = gold;
    }
    if (achievement.reward.mythicChoice) {
      fields.mythic_choice_boxes = (claim.mythic_choice_boxes || 0) + achievement.reward.mythicChoice;
    }
    if (achievement.reward.points) {
      fields.prestige_points = claim.prestige_points + achievement.reward.points;
    }
    await store.updateClaim(client, userId, mode, fields);

    return {
      message: `🏅 ${achievement.emoji} ${achievement.name} 달성! ${describeReward(achievement.reward)}`,
      mode,
      key: achievement.key,
      totalTreasure: gold,
    };
  });
}));

// -------------------------------
// 환생 상점: POST /api/box/prestige-shop { key } (기록모드 전용)
// -------------------------------
// 환생 포인트로 영구 특성을 삽니다. 시작 자금·자동 개봉 비축은 다음 판부터 적용됩니다.
router.post('/prestige-shop', handle('서버 오류로 구매에 실패했습니다.', async (req) => {
  const userId = req.user.userId;
  const perk = PRESTIGE_PERKS.find(p => p.key === req.body.key);
  if (!perk) throw new HttpError(400, '존재하지 않는 특성입니다.');

  return withSave(userId, async (client, mode, save) => {
    if (!store.isPrestigeMode(mode)) throw new HttpError(400, '환생 상점은 기록모드 전용입니다.');

    const level = getPerkLevel(save.claim, perk.key);
    if (level >= perk.maxLevel) throw new HttpError(400, '이미 최대 레벨입니다.');
    const cost = getPerkCost(perk, level);
    if (save.claim.prestige_points < cost) {
      throw new HttpError(400, `환생 포인트가 부족합니다. (필요: ${cost}개)`);
    }

    const perks = { ...(save.claim.prestige_perks || {}), [perk.key]: level + 1 };
    const fields = {
      prestige_points: save.claim.prestige_points - cost,
      prestige_perks: JSON.stringify(perks),
    };
    // 타고난 장인은 지금 판에도 바로 자동 합성을 열어줍니다.
    if (perk.key === 'autoCraft' && !save.claim[AUTO_CRAFT.unlockedColumn]) {
      fields[AUTO_CRAFT.unlockedColumn] = true;
      fields[AUTO_CRAFT.enabledColumn] = true;
    }
    await store.updateClaim(client, userId, mode, fields);

    const nextRunOnly = ['startGold', 'startAuto'].includes(perk.key);
    return {
      message: `${perk.emoji} ${perk.name} Lv.${level + 1}! ${perk.desc}${nextRunOnly ? ' (다음 판부터 적용)' : ''}`,
      mode,
      key: perk.key,
      level: level + 1,
      points: fields.prestige_points,
    };
  });
}));

// -------------------------------
// 아이템 합성: POST /api/box/craft
// -------------------------------
router.post('/craft', handle('서버 오류로 합성에 실패했습니다.', async (req) => {
  const userId = req.user.userId;
  const { itemKey } = req.body;

  const sourceItem = typeof itemKey === 'string' ? TREASURE_BY_KEY.get(itemKey) : undefined;
  if (!sourceItem) {
    throw new HttpError(400, '존재하지 않는 아이템입니다.');
  }

  const nextRarity = getNextCraftRarity(sourceItem);
  if (!nextRarity) {
    throw new HttpError(400, sourceItem.rarity === 'legendary'
      ? '신화 아이템은 합성할 수 없습니다. 오직 상자에서만 등장!'
      : '이미 최고 등급이라 더 합성할 수 없습니다.');
  }

  return withSave(userId, async (client, mode, save) => {
    if (store.lockedSet(save.claim).has(itemKey)) {
      throw new HttpError(400, `🔒 ${sourceItem.name}은(는) 잠겨 있어 합성할 수 없습니다. 잠금을 해제하세요.`);
    }
    const ownedCount = save.owned[itemKey] || 0;
    if (ownedCount < CRAFT_COST) {
      throw new HttpError(400, `합성하려면 ${sourceItem.name}이(가) ${CRAFT_COST}개 필요합니다. (현재 ${ownedCount}개)`);
    }

    const resultItem = pickRandomFromRarity(nextRarity);
    await store.addItems(client, userId, mode, { [itemKey]: -CRAFT_COST, [resultItem.key]: 1 });
    await store.saveStats(client, userId, mode, save.claim, { crafts: 1, ...store.countRareGains({ [resultItem.key]: 1 }) });
    await store.bumpMission(client, userId, mode, save.claim, save.day, 'craft');

    return {
      message: '합성 성공!',
      mode,
      consumed: { key: sourceItem.key, name: sourceItem.name, amount: CRAFT_COST },
      result: resultItem,
    };
  });
}));

// -------------------------------
// 일괄 합성: POST /api/box/craft-all
// -------------------------------
// 일반 → 희귀 → 영웅 순서로 처리해서, 합성으로 새로 생긴 아이템도 이어서 합성합니다.
router.post('/craft-all', handle('서버 오류로 일괄 합성에 실패했습니다.', async (req) => {
  return withSave(req.user.userId, async (client, mode, save) => {
    const { deltas, results, totalCrafts } = craftCascade(save.owned, store.lockedSet(save.claim));
    if (totalCrafts === 0) {
      return { message: '합성 가능한 아이템이 없습니다.', mode, totalCrafts: 0, results: [] };
    }

    await store.addItems(client, req.user.userId, mode, deltas);
    await store.saveStats(client, req.user.userId, mode, save.claim, { crafts: totalCrafts, ...store.countRareGains(deltas) });
    await store.bumpMission(client, req.user.userId, mode, save.claim, save.day, 'craft', totalCrafts);
    return {
      message: `총 ${totalCrafts}번 합성했습니다!`,
      mode,
      totalCrafts,
      results: results.map(r => ({
        consumedKey: r.sourceKey,
        consumedName: TREASURE_BY_KEY.get(r.sourceKey).name,
        craftCount: r.craftCount,
        obtained: toObtainedList(r.obtained, ['name', 'emoji']),
      })),
    };
  });
}));

// -------------------------------
// 도감 조회: GET /api/box/collection
// -------------------------------
router.get('/collection', handle('서버 오류가 발생했습니다.', async (req) => {
  const userId = req.user.userId;

  return withSave(userId, async (client, mode, save) => {
    // 발견 기록: 기록모드에선 "이번 판" 한정, 수집모드에선 영구
    const discoveryResult = await client.query(
      'SELECT item_key, first_discovered_at FROM user_discoveries WHERE user_id = $1 AND mode = $2',
      [userId, mode]
    );
    const discoveryMap = {};
    discoveryResult.rows.forEach(row => { discoveryMap[row.item_key] = row.first_discovered_at; });
    const incomeByKey = {};
    save.income.items.forEach(item => { incomeByKey[item.key] = item.incomePerMinute; });

    // 가방 목록: 일반~전설 전부 + 이번 주 신화 10종 + 그 밖에 갖고 있는 지난 시즌 신화
    // (수집모드의 신화 100종 전체는 GET /codex 로 따로 봅니다)
    // 아이템 숙련도(★): 같은 아이템을 많이 모을수록 붙고, 그 아이템의 수입이 올라갑니다.
    const locked = store.lockedSet(save.claim);
    const dexItems = getSeasonDexItems(save.rotation);
    const dexKeys = new Set(dexItems.map(t => t.key));
    const extraMythics = MYTHICS.filter(m => !dexKeys.has(m.key) && (save.owned[m.key] || 0) > 0);
    const collection = [...dexItems, ...extraMythics].map(item => {
      const count = save.owned[item.key] || 0;
      return {
        locked: locked.has(item.key),
        // 고유 효과: 1개당 효과(per) / 지금 적용 중인 효과(now) / 이 아이템 최대치(max)
        effect: itemEffectInfo(item.key, count),
        inSeasonDex: dexKeys.has(item.key),
        tier: item.tier || null,
        key: item.key,
        name: item.name,
        rarity: item.rarity,
        emoji: item.emoji,
        flavor: item.flavor,
        count,
        obtained: Boolean(discoveryMap[item.key]),
        firstDiscoveredAt: discoveryMap[item.key] || null,
        stars: getItemStars(count),
        maxStars: MASTERY_THRESHOLDS.length,
        nextStarAt: MASTERY_THRESHOLDS.find(t => t > count) || null,
        incomePerMinute: incomeByKey[item.key] || 0,
      };
    });

    return {
      mode,
      isRecordMode: mode === MODES.RECORD,
      collection,
      totalTreasure: save.claim.total_treasure,
      itemEffects: activeItemEffects(save),
      season: seasonResponse(mode, save),
      codex: codexSummary(mode, save),
      collectorRank: mode === MODES.COLLECTION ? getCollectorRank(save.codex.size) : null,
      income: incomeResponse(save),
      prestige: progressionResponse(mode, save).prestige,
    };
  });
}));

// -------------------------------
// 초심으로 돌아가기: POST /api/box/reset-run
// -------------------------------
// 언제든 지금 세이브(현재 모드)를 포기하고 처음부터 다시 시작할 수 있습니다.
// - 기록모드: 골드·아이템·도감·업그레이드·자동화를 전부 초기화합니다 (환생 포인트는 유지).
// - 수집모드: 사용할 수 없습니다. (도감/천장이 영구라서 초기화가 무한 파밍 통로가 됨)
// 환생과 달리 "성공한 기록"이 아니라서 rebirth_count나 랭킹, 환생 포인트에는 남지 않습니다.
router.post('/reset-run', handle('서버 오류가 발생했습니다.', async (req) => {
  const userId = req.user.userId;

  return withUserTransaction(userId, async (client) => {
    const mode = await store.getActiveMode(client, userId);

    // [보안/밸런스] 수집모드에서는 초심으로 돌아가기를 막습니다.
    // 수집모드는 도감과 신화 천장이 영구 보존되는데, 초기화가 골드를 2000G로 되돌려주면
    // "초기화 → 2000G로 상자 구매 → 초기화"를 스크립트로 반복해서 무한히 공짜 상자를 열고
    // 도감/천장을 순식간에 채울 수 있습니다.
    if (mode !== MODES.RECORD) {
      throw new HttpError(400, '수집모드에서는 초심으로 돌아갈 수 없습니다.');
    }

    const now = new Date();
    const claim = await store.getClaim(client, userId, mode, ['prestige_perks'], { forUpdate: true });
    if (!claim) throw new HttpError(400, NOT_STARTED_MESSAGE);
    const startGold = await store.resetSave(client, userId, mode, now, { claim });

    return {
      message: '초심으로 돌아갔습니다. 도감도 함께 초기화되었습니다. 다시 도전하세요!',
      mode,
      totalTreasure: startGold,
      runStartedAt: now,
    };
  });
}));

// -------------------------------
// 환생: POST /api/box/rebirth (기록모드 전용)
// -------------------------------
// 이번 판에 번 골드 5만 G당 환생 포인트 1개를 받습니다. 포인트는 환생 상점에서 영구 특성을 사는 데 씁니다.
router.post('/rebirth', handle('서버 오류로 환생에 실패했습니다.', async (req) => {
  const userId = req.user.userId;

  return withUserTransaction(userId, async (client) => {
    const mode = await store.getActiveMode(client, userId);
    if (mode !== MODES.RECORD) {
      throw new HttpError(400, '수집모드에서는 환생할 수 없습니다. 기록모드로 전환해주세요.');
    }

    const save = await store.settle(client, userId, mode);
    if (!save) throw new HttpError(400, NOT_STARTED_MESSAGE);
    const { claim } = save;

    const currentGold = claim.total_treasure;
    if (currentGold < REBIRTH_GOLD_REQUIRED) {
      throw new HttpError(400, `${REBIRTH_GOLD_REQUIRED.toLocaleString()}G가 필요합니다. (현재 ${currentGold.toLocaleString()}G)`);
    }

    const now = save.now;
    const durationMs = now - new Date(claim.run_started_at);
    const rebirthNumber = claim.rebirth_count + 1;
    const mythicBonus = mythicKindsThisRun(save);
    const prestigeGained = getPrestigePointsForRun(claim.run_gold_earned) + mythicBonus;

    await client.query(
      `INSERT INTO rebirth_history (user_id, mode, rebirth_number, duration_ms, completed_at, season)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, mode, rebirthNumber, durationMs, now, save.season]
    );

    // 환생은 "이번 판"을 완전히 새로 시작하는 것이므로, 보유 아이템뿐 아니라
    // 도감(발견기록)·업그레이드·자동화도 함께 초기화합니다. 환생 포인트만 쌓입니다.
    const startGold = await store.resetSave(client, userId, mode, now, {
      rebirthCount: rebirthNumber,
      prestigeGain: prestigeGained,
      claim,
    });

    // 시즌 최고 기록이면 이번 판 구간 기록을 "최고 기록 구간"으로 저장합니다. (다음 판 페이스 비교용)
    const previousBestMs = claim.best_run_ms != null ? Number(claim.best_run_ms) : null;
    const isNewBest = previousBestMs === null || durationMs < previousBestMs;
    if (isNewBest) {
      const splits = (Array.isArray(claim.run_splits) ? claim.run_splits : []).slice(0, SPLIT_STEPS - 1);
      await store.updateClaim(client, userId, mode, {
        best_splits: JSON.stringify([...splits, durationMs]),
        best_run_ms: durationMs,
      });
    }

    return {
      message: `${rebirthNumber}번째 환생을 달성했습니다! 처음부터 다시 시작합니다.`,
      mode,
      rebirthNumber,
      durationMs,
      previousBestMs,
      isNewBest,
      prestigeGained,
      prestigePoints: claim.prestige_points + prestigeGained,
      totalTreasure: startGold,
      runStartedAt: now,
    };
  });
}));

// -------------------------------
// 환생 기록 조회: GET /api/box/rebirth/history (기록모드 전용 개념)
// -------------------------------
router.get('/rebirth/history', handle('서버 오류가 발생했습니다.', async (req) => {
  const historyResult = await db.query(
    `SELECT rebirth_number, duration_ms, completed_at, season FROM rebirth_history
     WHERE user_id = $1 AND mode = 'record' ORDER BY rebirth_number ASC`,
    [req.user.userId]
  );

  return {
    history: historyResult.rows.map(r => ({
      rebirthNumber: r.rebirth_number,
      durationMs: parseInt(r.duration_ms, 10),
      completedAt: r.completed_at,
      season: r.season,
    })),
    goldRequired: REBIRTH_GOLD_REQUIRED,
    season: getSeason(),
  };
}));

// -------------------------------
// 랭킹 조회: GET /api/box/leaderboard (페이지네이션, 기록모드 전용)
// -------------------------------
// 랭킹 화면에서 페이지에 내가 안 보일 때, 내 최고 기록과 전체 순위를 따로 계산합니다.
// runner: 트랜잭션 안(상태 조회)에서는 그 client를 넘겨야 합니다. 트랜잭션이 연결을 쥔 채로
// 연결을 하나 더 빌리면, 요청이 몰릴 때 연결 풀이 바닥나 서로 기다리다 500이 납니다.
async function findMyRank(runner, userId, season) {
  const myBestResult = await runner.query(
    `SELECT MIN(duration_ms) AS best_duration_ms FROM rebirth_history
     WHERE user_id = $1 AND mode = 'record' AND season = $2`,
    [userId, season]
  );
  const myBest = myBestResult.rows[0]?.best_duration_ms;
  if (!myBest) return null;

  const rankResult = await runner.query(
    `SELECT COUNT(*) + 1 AS rank FROM (
       SELECT user_id, MIN(duration_ms) AS best FROM rebirth_history
       WHERE mode = 'record' AND season = $2 GROUP BY user_id
     ) t WHERE t.best < $1`,
    [myBest, season]
  );
  return {
    rank: parseInt(rankResult.rows[0].rank, 10),
    bestDurationMs: parseInt(myBest, 10),
    isMe: true,
    outsideCurrentPage: true,
  };
}

// 수집가 칭호 (랭킹에서 닉네임 옆에 표시): userId → { emoji, name }
const MYTHIC_KEYS = MYTHICS.map(m => m.key);
function collectorTitle(count) {
  let title = COLLECTOR_RANKS[0];
  for (const rank of COLLECTOR_RANKS) if (count >= rank.minObtained) title = rank;
  return { emoji: title.emoji, name: title.name };
}
async function collectorTitlesFor(userIds) {
  if (userIds.length === 0) return {};
  const result = await db.query(
    `SELECT user_id, COUNT(*) AS cnt FROM user_discoveries
     WHERE mode = 'collection' AND item_key = ANY($1::text[]) AND user_id = ANY($2::int[])
     GROUP BY user_id`,
    [MYTHIC_KEYS, userIds]
  );
  const counts = Object.fromEntries(result.rows.map(r => [r.user_id, parseInt(r.cnt, 10)]));
  return Object.fromEntries(userIds.map(id => [id, collectorTitle(counts[id] || 0)]));
}

// 신화 수집 랭킹: 수집모드 신화 도감 수가 많은 순, 같으면 그 수를 먼저 채운(마지막 발견이 빠른) 순
const CODEX_RANK_CTE = `
  WITH c AS (
    SELECT user_id, COUNT(*) AS cnt, MAX(first_discovered_at) AS reached_at
    FROM user_discoveries
    WHERE mode = 'collection' AND item_key = ANY($1::text[])
    GROUP BY user_id
  )`;

async function collectionLeaderboard(userId, page, pageSize, offset) {
  const [totalResult, result, mineResult] = await Promise.all([
    db.query(`${CODEX_RANK_CTE} SELECT COUNT(*) AS total FROM c`, [MYTHIC_KEYS]),
    db.query(
      `${CODEX_RANK_CTE}
       SELECT u.id AS user_id, u.nickname, c.cnt FROM c JOIN users u ON u.id = c.user_id
       ORDER BY c.cnt DESC, c.reached_at ASC, u.id ASC
       LIMIT $2 OFFSET $3`,
      [MYTHIC_KEYS, pageSize, offset]
    ),
    db.query(
      `${CODEX_RANK_CTE}
       SELECT me.cnt, (SELECT COUNT(*) + 1 FROM c o
                       WHERE o.cnt > me.cnt OR (o.cnt = me.cnt AND (o.reached_at < me.reached_at
                         OR (o.reached_at = me.reached_at AND o.user_id < me.user_id)))) AS rank
       FROM c me WHERE me.user_id = $2`,
      [MYTHIC_KEYS, userId]
    ),
  ]);
  const totalPlayers = parseInt(totalResult.rows[0].total, 10);
  const titles = await collectorTitlesFor(result.rows.map(r => r.user_id));
  const leaderboard = result.rows.map((row, index) => ({
    rank: offset + index + 1,
    nickname: row.nickname,
    count: parseInt(row.cnt, 10),
    title: titles[row.user_id],
    isMe: row.user_id === userId,
  }));
  const mine = mineResult.rows[0];
  const myRank = leaderboard.find(r => r.isMe) || (mine ? {
    rank: parseInt(mine.rank, 10), count: parseInt(mine.cnt, 10), isMe: true, outsideCurrentPage: true,
  } : null);
  return {
    type: 'collection',
    leaderboard, myRank, page, pageSize, totalPlayers,
    totalPages: Math.max(1, Math.ceil(totalPlayers / pageSize)),
    total: MYTHICS.length,
  };
}

// ?type=collection 이면 신화 수집 랭킹, 아니면 기록모드 시즌 랭킹(환생 최단 기록)
router.get('/leaderboard', handle('서버 오류가 발생했습니다.', async (req) => {
  const userId = req.user.userId;
  const pageSize = LEADERBOARD_PAGE_SIZE;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * pageSize;
  if (req.query.type === 'collection') return collectionLeaderboard(userId, page, pageSize, offset);

  // ?season=1 처럼 지난 시즌도 볼 수 있습니다 (없거나 잘못된 값이면 현재 시즌)
  const currentSeason = getSeason();
  const requestedSeason = parseInt(req.query.season, 10);
  const season = requestedSeason >= 1 && requestedSeason <= currentSeason ? requestedSeason : currentSeason;

  const [totalResult, result] = await Promise.all([
    db.query(
      `SELECT COUNT(*) AS total FROM (
         SELECT user_id FROM rebirth_history WHERE mode = 'record' AND season = $1 GROUP BY user_id
       ) t`,
      [season]
    ),
    db.query(
      `SELECT u.id AS user_id, u.nickname, MIN(rh.duration_ms) AS best_duration_ms
       FROM rebirth_history rh
       JOIN users u ON u.id = rh.user_id
       WHERE rh.mode = 'record' AND rh.season = $3
       GROUP BY u.id, u.nickname
       ORDER BY best_duration_ms ASC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset, season]
    ),
  ]);

  const totalPlayers = parseInt(totalResult.rows[0].total, 10);
  const totalPages = Math.max(1, Math.ceil(totalPlayers / pageSize));
  const titles = await collectorTitlesFor(result.rows.map(r => r.user_id));

  const leaderboard = result.rows.map((row, index) => ({
    rank: offset + index + 1,
    nickname: row.nickname,
    bestDurationMs: parseInt(row.best_duration_ms, 10),
    title: titles[row.user_id],
    isMe: row.user_id === userId,
  }));

  const myRank = leaderboard.find(r => r.isMe) || await findMyRank(db, userId, season);

  return {
    type: 'record',
    leaderboard, myRank, page, pageSize, totalPlayers, totalPages,
    season,
    currentSeason,
    seasonStartsAt: getSeasonStart(season),
    seasonEndsAt: getSeasonEnd(season),
    goldRequired: SEASON_GOLD_REQUIRED[season] || REBIRTH_GOLD_REQUIRED,
  };
}));

// -------------------------------
// 신화 도감 조회: GET /api/box/codex (수집모드 전용 · 영구)
// -------------------------------
// 수집모드에서 얻은 신화 100종을 날짜별 묶음(10종씩)으로 나눠서, 얻었는지와 다음에 언제 나오는지를 알려줍니다.
router.get('/codex', handle('서버 오류가 발생했습니다.', async (req) => {
  const userId = req.user.userId;
  const result = await db.query(
    `SELECT item_key, first_discovered_at FROM user_discoveries
     WHERE user_id = $1 AND mode = 'collection' AND item_key = ANY($2::text[])`,
    [userId, MYTHIC_KEYS]
  );
  const found = new Map(result.rows.map(r => [r.item_key, r]));
  const today = getDay();
  const claimRow = await db.query(
    `SELECT mythic_awaken, mythic_shards FROM box_claims WHERE user_id = $1 AND mode = 'collection'`,
    [userId]
  );
  const awaken = (claimRow.rows[0] && claimRow.rows[0].mythic_awaken) || {};
  const bonus = collection.getCollectionBonus(new Set(found.keys()), awaken);

  const groups = [];
  for (const m of MYTHICS) {
    let group = groups[m.rotation];
    if (!group) {
      const nextDay = getNextDayForRotation(m.rotation, today);
      group = groups[m.rotation] = {
        rotation: m.rotation,
        isCurrent: nextDay === today,
        daysUntil: nextDay - today,
        nextStartsAt: getDayStart(nextDay),
        items: [],
      };
    }
    const row = found.get(m.key);
    group.items.push({
      key: m.key,
      name: row ? m.name : null,
      emoji: m.emoji,
      tier: m.tier,
      flavor: row ? m.flavor : null,
      // 효과는 아직 못 얻었어도 보여줘서 "무엇을 노릴지" 정할 수 있게 합니다.
      effect: itemEffectInfo(m.key, 0),
      obtained: Boolean(row),
      firstObtainedAt: row ? row.first_discovered_at : null,
      awaken: row ? collection.awakenLevel(awaken, m.key) : 0,
      theme: m.theme,
      motif: m.motif,
    });
  }
  // 오늘 묶음을 맨 앞에, 그 뒤로는 다음에 나오는 순서대로
  groups.sort((a, b) => a.daysUntil - b.daysUntil);

  return {
    dayEndsAt: getDayEnd(today),
    obtained: found.size,
    total: MYTHICS.length,
    collectorRank: getCollectorRank(found.size),
    groups,
    shards: claimRow.rows[0] ? claimRow.rows[0].mythic_shards : 0,
    awakenCosts: collection.AWAKEN_COSTS,
    awakenMax: collection.AWAKEN_MAX,
    awakenIncomePercent: collection.AWAKEN_INCOME_PERCENT,
    stars: bonus.stars,
    milestones: collection.getMilestones(found.size).list,
    sets: {
      motifBonusPercent: collection.MOTIF_SET_INCOME_PERCENT,
      motifs: bonus.motifs,
      themes: bonus.themes.map(t => ({ ...t, bonusText: describeItemEffect(t.bonus.type, t.bonus.value) })),
    },
  };
}));

module.exports = router;
// 방명록에서도 닉네임 옆 칭호를 보여주려고 같이 내보냅니다.
module.exports.collectorTitlesFor = collectorTitlesFor;
