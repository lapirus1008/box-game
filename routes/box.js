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
const { HttpError, withTransaction, handle } = require('../lib/http');
const {
  MODES,
  VALID_MODES,
  TREASURES,
  TREASURE_BY_KEY,
  CRAFT_COST,
  COMPLETION_BONUS_GOLD,
  REBIRTH_GOLD_REQUIRED,
  RANKING_SEASON,
  SEASON_GOLD_REQUIRED,
  MAX_BOX_CHARGES,
  MAX_GOLD_BOX_PURCHASE,
  GOLD_PER_BOX_PURCHASE,
  BOX_PRICE_INCOME_MINUTES,
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
  getNextCraftRarity,
  pickRandomFromRarity,
  craftCascade,
  toObtainedList,
  getItemStars,
  getCollectorRank,
  getUpgradeCost,
  describeUpgradeEffect,
  getPerkLevel,
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
function withSave(userId, fn) {
  return withTransaction(async (client) => {
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
  // 수입 배율(강화·환생 특성·신화)까지 반영한, 상자 1개당 평균 분당 수입 증가량
  const multiplier = s.upgradeIncomePercent * s.prestigeIncomePercent * (100 + s.mythicIncomePercent) / 1000000;
  return {
    income: save.income.perMinuteIncome,
    step: expectedIncomePerBox(s.luckPercent) * multiplier,
    discountPercent: s.boxDiscountPercent,
    minPrice: GOLD_PER_BOX_PURCHASE,
    incomeMinutes: BOX_PRICE_INCOME_MINUTES,
  };
}

// 지금 적용 중인 아이템 효과 목록 (화면 표시용)
function activeItemEffects(save) {
  const effects = save.stats.effects;
  return Object.entries(ITEM_EFFECTS)
    .filter(([key]) => (save.owned[key] || 0) > 0)
    .map(([key, effect]) => ({
      key,
      emoji: TREASURE_BY_KEY.get(key).emoji,
      name: TREASURE_BY_KEY.get(key).name,
      text: describeItemEffect(effect.type, effects[effect.type]),
      maxed: effects[effect.type] >= effect.max,
    }));
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
      ? { count: save.autoOpened.count, obtained: toObtainedList(save.autoOpened.counts), pityTriggered: save.autoOpened.pityTriggered }
      : null,
    autoCrafted: save.autoCrafted,
  };
}

// 업그레이드 상점 / 자동화 / 환생 포인트 정보 (화면 표시용)
function progressionResponse(mode, save) {
  const { claim, stats } = save;
  const prestigeEnabled = store.isPrestigeMode(mode);
  const pointsOnRebirth = prestigeEnabled ? getPrestigePointsForRun(claim.run_gold_earned) : 0;
  const autoOpenRemainingMs = Number(claim.auto_open_remaining_ms);
  return {
    storageMs: stats.storageMs,
    upgrades: UPGRADES.map(upgrade => {
      const level = claim[upgrade.column];
      const isMax = level >= upgrade.maxLevel;
      return {
        key: upgrade.key,
        name: upgrade.name,
        emoji: upgrade.emoji,
        level,
        maxLevel: upgrade.maxLevel,
        cost: isMax ? null : getUpgradeCost(upgrade, level),
        effect: describeUpgradeEffect(upgrade.key, level),
        nextEffect: isMax ? null : describeUpgradeEffect(upgrade.key, level + 1),
      };
    }),
    autoOpen: {
      enabled: claim.auto_open_enabled,
      remainingMs: autoOpenRemainingMs,
      maxMs: stats.storageMs,
      costPerHour: getAutoOpenCostPerHour(save.income.perMinuteIncome),
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
      nextPointAt: (pointsOnRebirth + 1) * PRESTIGE_GOLD_PER_POINT,
      perks: PRESTIGE_PERKS.map(perk => ({
        key: perk.key,
        emoji: perk.emoji,
        name: perk.name,
        desc: perk.desc,
        cost: perk.cost,
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
    notable,
  };
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
function randomGoldenGap() {
  return GOLDEN_BOX_MIN_GAP_MS + Math.floor(Math.random() * (GOLDEN_BOX_MAX_GAP_MS - GOLDEN_BOX_MIN_GAP_MS));
}

// 접속 중(상태 조회)일 때만 호출합니다. 다음 등장 시각이 없거나 이미 놓쳤다면 새로 잡습니다.
async function syncGoldenBox(client, userId, mode, save) {
  const now = save.now;
  let nextAt = save.claim.golden_box_next_at ? new Date(save.claim.golden_box_next_at) : null;
  if (!nextAt || now - nextAt > GOLDEN_BOX_WINDOW_MS) {
    nextAt = new Date(now.getTime() + randomGoldenGap());
    await store.updateClaim(client, userId, mode, { golden_box_next_at: nextAt });
    save.claim.golden_box_next_at = nextAt;
  }
  return goldenBoxResponse(save);
}

// 황금 상자 규칙 (화면의 안내 팝업에 그대로 보여줍니다)
const GOLDEN_REWARD_TEXT = {
  gold: `💰 골드 (분당 수입 × ${GOLDEN_GOLD_MINUTES}분, 최소 ${GOLDEN_GOLD_MIN.toLocaleString()}G)`,
  boxes: `📦 상자 ${GOLDEN_BOXES}개 즉시 개봉`,
  boost: `⚡ ${INCOME_BOOST_MS / 60000}분간 수입 ${INCOME_BOOST_MULTIPLIER}배 (겹치면 시간이 늘어나요)`,
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
  return reward.points ? `✨ 환생 포인트 ${reward.points}` : `💰 ${reward.gold.toLocaleString()}G`;
}

function achievementsResponse(mode, claim) {
  const claimed = claim.achievements_claimed || {};
  const list = ACHIEVEMENTS
    .filter(a => !a.recordOnly || store.isPrestigeMode(mode))
    .map(a => {
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
    throw new HttpError(400, '자동 개봉이 켜져 있어서 충전된 상자는 자동으로 열려요.', chargeResponse(save.chargeInfo));
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

    const roll = rollWithPity(save.claim.mythic_pity, save.stats.luckPercent, save.stats.pityLimit, save.owned);
    await store.updateClaim(client, userId, mode, {
      box_charges: save.chargeInfo.charges - 1,
      mythic_pity: roll.pity,
    });
    await store.addItems(client, userId, mode, { [roll.treasure.key]: 1 });
    await store.saveStats(client, userId, mode, save.claim, store.boxStatDeltas(1, { [roll.treasure.key]: 1 }));

    return {
      message: '상자를 열었습니다!',
      mode,
      treasure: roll.treasure,
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

    const { counts, pity, pityTriggered } = rollBoxes(save.claim.mythic_pity, quantity, save.stats.luckPercent, save.stats.pityLimit, save.owned);
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
// 골드로 상자 구매해서 열기: POST /api/box/buy-boxes (충전과 무관, 골드만 소모)
// -------------------------------
router.post('/buy-boxes', handle('서버 오류로 구매에 실패했습니다.', async (req) => {
  const userId = req.user.userId;
  const quantity = parseQuantity(
    req.body.quantity,
    MAX_GOLD_BOX_PURCHASE,
    `한 번에 최대 ${MAX_GOLD_BOX_PURCHASE}개까지만 구매할 수 있습니다.`
  );

  return withSave(userId, async (client, mode, save) => {
    const currentGold = save.claim.total_treasure;
    const pricing = boxPricingOf(save);
    const { total: totalCost, firstPrice: boxPrice, lastPrice } = getBoxPurchaseCost(pricing, quantity);
    if (currentGold < totalCost) {
      throw new HttpError(400, `골드가 부족합니다. (필요: ${totalCost.toLocaleString()}G, 보유: ${currentGold.toLocaleString()}G)`, {
        maxAffordable: getMaxAffordableBoxes(pricing, currentGold, MAX_GOLD_BOX_PURCHASE),
      });
    }

    const { counts, pity, pityTriggered } = rollBoxes(save.claim.mythic_pity, quantity, save.stats.luckPercent, save.stats.pityLimit, save.owned);
    await store.addItems(client, userId, mode, counts);
    await store.saveStats(client, userId, mode, save.claim, store.boxStatDeltas(quantity, counts));

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

  return withTransaction(async (client) => {
    const mode = await store.getActiveMode(client, userId);
    const isRecordMode = mode === MODES.RECORD;

    const save = await store.settle(client, userId, mode);
    if (!save) {
      return { mode, isRecordMode, charges: 0, maxCharges: MAX_BOX_CHARGES, totalTreasure: 0 };
    }
    const { claim } = save;

    // 도감을 다 채웠는지 (메인 화면의 "도감 완료" 버튼 표시용) + 수집가 등급 계산
    const discoveredResult = await client.query(
      'SELECT COUNT(*) AS total FROM user_discoveries WHERE user_id = $1 AND mode = $2',
      [userId, mode]
    );
    const obtainedCount = parseInt(discoveredResult.rows[0].total, 10);

    // 최고 분당 수입 기록 (업적용)
    const bestIncome = Number((claim.lifetime_stats || {}).bestIncome) || 0;
    if (save.income.perMinuteIncome > bestIncome) {
      await store.saveStats(client, userId, mode, claim, { bestIncome: save.income.perMinuteIncome - bestIncome });
    }
    const goldenBox = await syncGoldenBox(client, userId, mode, save);

    return {
      mode,
      isRecordMode,
      goldenBox,
      ...achievementsResponse(mode, claim),
      collectionComplete: obtainedCount >= TREASURES.length,
      bonusClaimed: claim.completion_bonus_claimed,
      ...chargeResponse(save.chargeInfo),
      chargeIntervalMs: save.stats.chargeIntervalMs,
      totalTreasure: claim.total_treasure,
      mythicPity: claim.mythic_pity,
      mythicPityLimit: save.stats.pityLimit,
      pityReduction: save.stats.effects.pity, // 별의 파편 효과로 줄어든 천장
      boxPrice: boxPriceOf(save),
      boxPricing: boxPricingOf(save),
      rebirthGoldRequired: REBIRTH_GOLD_REQUIRED,
      itemEffects: activeItemEffects(save),
      income: incomeResponse(save),
      collectorRank: getCollectorRank(obtainedCount),
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
    const level = save.claim[upgrade.column];
    if (level >= upgrade.maxLevel) throw new HttpError(400, '이미 최대 레벨입니다.');

    const cost = getUpgradeCost(upgrade, level);
    const gold = save.claim.total_treasure;
    if (gold < cost) throw new HttpError(400, `골드가 부족합니다. (필요: ${cost.toLocaleString()}G)`);

    await store.updateClaim(client, userId, mode, {
      total_treasure: gold - cost,
      [upgrade.column]: level + 1,
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
      return { message: `⏳ 자동 개봉을 ${on ? '켰어요' : '껐어요'}.`, mode, enabled: on, totalTreasure: gold };
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
      throw new HttpError(400, `자동 개봉 시간은 보관 시간(${formatHours(maxMs)})까지만 채울 수 있어요. 창고를 늘려보세요!`);
    }

    const cost = Math.ceil(getAutoOpenCostPerHour(save.income.perMinuteIncome) * addMs / HOUR_MS);
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
      return { message: `${auto.emoji} ${auto.name}을(를) 해금했어요!`, mode, unlocked: true, enabled: true, totalTreasure: gold - auto.cost };
    }

    const on = Boolean(req.body.enabled);
    await store.updateClaim(client, userId, mode, { [auto.enabledColumn]: on });
    return { message: `${auto.emoji} ${auto.name}을(를) ${on ? '켰어요' : '껐어요'}.`, mode, unlocked: true, enabled: on, totalTreasure: gold };
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
      message: lock ? `🔒 ${item.name}을(를) 잠갔어요. 합성 재료로 쓰이지 않아요.` : `🔓 ${item.name} 잠금을 풀었어요.`,
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
        ? '아직 황금 상자가 나타나지 않았어요.'
        : '황금 상자가 사라졌어요. 다음 기회를 노려보세요!');
    }

    const { claim, now } = save;
    const fields = { golden_box_next_at: new Date(now.getTime() + randomGoldenGap()) };
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
      const { counts, pity, pityTriggered } = rollBoxes(claim.mythic_pity, goldenBoxes, save.stats.luckPercent, save.stats.pityLimit, save.owned);
      await store.addItems(client, userId, mode, counts);
      fields.mythic_pity = pity;
      Object.assign(statDeltas, store.boxStatDeltas(goldenBoxes, counts));
      result.obtained = toObtainedList(counts);
      result.mythicPityTriggered = pityTriggered;
      result.message = `📦 황금 상자! 상자 ${goldenBoxes}개를 열었어요`;
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
    if (achievement.recordOnly && !store.isPrestigeMode(mode)) throw new HttpError(400, '기록모드 전용 업적입니다.');
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
    if (!store.isPrestigeMode(mode)) throw new HttpError(400, '환생 상점은 기록모드에서만 이용할 수 있어요.');

    const level = getPerkLevel(save.claim, perk.key);
    if (level >= perk.maxLevel) throw new HttpError(400, '이미 최대 레벨입니다.');
    if (save.claim.prestige_points < perk.cost) {
      throw new HttpError(400, `환생 포인트가 부족합니다. (필요: ${perk.cost}개)`);
    }

    const perks = { ...(save.claim.prestige_perks || {}), [perk.key]: level + 1 };
    const fields = {
      prestige_points: save.claim.prestige_points - perk.cost,
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
      ? '신화 아이템은 합성으로 얻을 수 없어요. 오직 상자에서만 나옵니다!'
      : '이미 최고 등급이라 더 합성할 수 없습니다.');
  }

  return withSave(userId, async (client, mode, save) => {
    if (store.lockedSet(save.claim).has(itemKey)) {
      throw new HttpError(400, `🔒 ${sourceItem.name}은(는) 잠겨 있어서 합성할 수 없어요. 잠금을 풀어주세요.`);
    }
    const ownedCount = save.owned[itemKey] || 0;
    if (ownedCount < CRAFT_COST) {
      throw new HttpError(400, `합성하려면 ${sourceItem.name}이(가) ${CRAFT_COST}개 필요합니다. (현재 ${ownedCount}개)`);
    }

    const resultItem = pickRandomFromRarity(nextRarity);
    await store.addItems(client, userId, mode, { [itemKey]: -CRAFT_COST, [resultItem.key]: 1 });
    await store.saveStats(client, userId, mode, save.claim, { crafts: 1, ...store.countRareGains({ [resultItem.key]: 1 }) });

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

    // 아이템 숙련도(★): 같은 아이템을 많이 모을수록 붙고, 그 아이템의 수입이 올라갑니다.
    const locked = store.lockedSet(save.claim);
    const collection = TREASURES.map(item => {
      const count = save.owned[item.key] || 0;
      const effect = ITEM_EFFECTS[item.key];
      return {
        locked: locked.has(item.key),
        // 고유 효과: 1개당 효과(per) / 지금 적용 중인 효과(now) / 최대치(max)
        effect: effect ? {
          per: describeItemEffect(effect.type, effect.perItem),
          now: count > 0 ? describeItemEffect(effect.type, Math.min(effect.max, count * effect.perItem)) : null,
          max: describeItemEffect(effect.type, effect.max),
        } : null,
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

    const obtainedCount = collection.filter(item => item.obtained).length;

    return {
      mode,
      isRecordMode: mode === MODES.RECORD,
      collection,
      totalTreasure: save.claim.total_treasure,
      progress: { obtained: obtainedCount, total: TREASURES.length },
      isComplete: obtainedCount === TREASURES.length,
      bonusClaimed: save.claim.completion_bonus_claimed,
      collectorRank: getCollectorRank(obtainedCount),
      income: incomeResponse(save),
      prestige: progressionResponse(mode, save).prestige,
    };
  });
}));

// -------------------------------
// 도감 완성 보상 수령: POST /api/box/collection/claim-bonus
// -------------------------------
router.post('/collection/claim-bonus', handle('서버 오류가 발생했습니다.', async (req) => {
  const userId = req.user.userId;

  return withSave(userId, async (client, mode, save) => {
    if (save.claim.completion_bonus_claimed) throw new HttpError(400, '이미 완성 보상을 받으셨습니다.');

    const discoveredResult = await client.query(
      'SELECT item_key FROM user_discoveries WHERE user_id = $1 AND mode = $2',
      [userId, mode]
    );
    const discoveredKeys = new Set(discoveredResult.rows.map(r => r.item_key));
    if (!TREASURES.every(t => discoveredKeys.has(t.key))) {
      throw new HttpError(400, '아직 모든 아이템을 모으지 못했습니다.');
    }

    const newTotal = save.claim.total_treasure + COMPLETION_BONUS_GOLD;
    await store.updateClaim(client, userId, mode, {
      total_treasure: newTotal,
      run_gold_earned: save.claim.run_gold_earned + COMPLETION_BONUS_GOLD,
      completion_bonus_claimed: true,
    });

    return {
      message: '도감 완성 보상을 받았습니다!',
      mode,
      bonusGold: COMPLETION_BONUS_GOLD,
      totalTreasure: newTotal,
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

  return withTransaction(async (client) => {
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
      message: '초심으로 돌아갔습니다. 도감도 함께 초기화됐어요. 다시 도전해보세요!',
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

  return withTransaction(async (client) => {
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
    const prestigeGained = getPrestigePointsForRun(claim.run_gold_earned);

    await client.query(
      `INSERT INTO rebirth_history (user_id, mode, rebirth_number, duration_ms, completed_at, season)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, mode, rebirthNumber, durationMs, now, RANKING_SEASON]
    );

    // 환생은 "이번 판"을 완전히 새로 시작하는 것이므로, 보유 아이템뿐 아니라
    // 도감(발견기록)·업그레이드·자동화도 함께 초기화합니다. 환생 포인트만 쌓입니다.
    const startGold = await store.resetSave(client, userId, mode, now, {
      rebirthCount: rebirthNumber,
      prestigeGain: prestigeGained,
      claim,
    });

    return {
      message: `${rebirthNumber}번째 환생을 달성했습니다! 처음부터 다시 시작합니다.`,
      mode,
      rebirthNumber,
      durationMs,
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
    season: RANKING_SEASON,
  };
}));

// -------------------------------
// 랭킹 조회: GET /api/box/leaderboard (페이지네이션, 기록모드 전용)
// -------------------------------
// 랭킹 화면에서 페이지에 내가 안 보일 때, 내 최고 기록과 전체 순위를 따로 계산합니다.
async function findMyRank(userId, season) {
  const myBestResult = await db.query(
    `SELECT MIN(duration_ms) AS best_duration_ms FROM rebirth_history
     WHERE user_id = $1 AND mode = 'record' AND season = $2`,
    [userId, season]
  );
  const myBest = myBestResult.rows[0]?.best_duration_ms;
  if (!myBest) return null;

  const rankResult = await db.query(
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

router.get('/leaderboard', handle('서버 오류가 발생했습니다.', async (req) => {
  const userId = req.user.userId;
  const pageSize = LEADERBOARD_PAGE_SIZE;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * pageSize;
  // ?season=1 처럼 지난 시즌도 볼 수 있습니다 (없거나 잘못된 값이면 현재 시즌)
  const requestedSeason = parseInt(req.query.season, 10);
  const season = requestedSeason >= 1 && requestedSeason <= RANKING_SEASON ? requestedSeason : RANKING_SEASON;

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

  const leaderboard = result.rows.map((row, index) => ({
    rank: offset + index + 1,
    nickname: row.nickname,
    bestDurationMs: parseInt(row.best_duration_ms, 10),
    isMe: row.user_id === userId,
  }));

  const myRank = leaderboard.find(r => r.isMe) || await findMyRank(userId, season);

  return {
    leaderboard, myRank, page, pageSize, totalPlayers, totalPages,
    season,
    currentSeason: RANKING_SEASON,
    goldRequired: SEASON_GOLD_REQUIRED[season] || REBIRTH_GOLD_REQUIRED,
  };
}));

module.exports = router;
