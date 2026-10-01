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
// - 상자는 시간이 지날수록 충전이 쌓이고(기본 최대 100개), 원할 때 열 수 있습니다.
// - 골드로 업그레이드(수입·충전 속도·창고·행운)와 자동화(자동 개봉·자동 합성)를 살 수 있습니다.
// - 기록모드에서는 10만 골드를 모으면 "환생"해서 영구 수입 보너스(환생 포인트)를 받고 다시 시작합니다.
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
  MAX_BOX_CHARGES,
  CAPACITY_PER_LEVEL,
  GOLD_PER_BOX_PURCHASE,
  MAX_GOLD_BOX_PURCHASE,
  RESET_GOLD,
  MYTHIC_PITY_LIMIT,
  MASTERY_THRESHOLDS,
  UPGRADES,
  AUTOMATIONS,
  PRESTIGE_GOLD_PER_POINT,
  PRESTIGE_INCOME_PERCENT_PER_POINT,
  AWAY_SUMMARY_MIN_MS,
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
  getPrestigePointsForRun,
} = require('../game/logic');
const store = require('../game/store');

const router = express.Router();

// 이 아래의 모든 API는 로그인이 필요합니다.
router.use(verifyToken);

const NOT_STARTED_MESSAGE = '아직 게임을 시작하지 않았습니다.';
const LEADERBOARD_PAGE_SIZE = 10;
// 창고를 끝까지 확장했을 때의 최대 충전 (일괄 열기 수량의 절대 상한)
const MAX_POSSIBLE_CHARGES = MAX_BOX_CHARGES + UPGRADES.find(u => u.key === 'capacity').maxLevel * CAPACITY_PER_LEVEL;

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

function pityResponse(pity, triggered) {
  return { mythicPity: pity, mythicPityLimit: MYTHIC_PITY_LIMIT, mythicPityTriggered: triggered };
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
function progressionResponse(mode, claim) {
  const prestigeEnabled = store.isPrestigeMode(mode);
  const pointsOnRebirth = prestigeEnabled ? getPrestigePointsForRun(claim.run_gold_earned) : 0;
  return {
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
    automation: AUTOMATIONS.map(auto => ({
      key: auto.key,
      name: auto.name,
      emoji: auto.emoji,
      desc: auto.desc,
      cost: auto.cost,
      unlocked: claim[auto.unlockedColumn],
      enabled: claim[auto.enabledColumn],
    })),
    prestige: {
      enabled: prestigeEnabled,
      points: claim.prestige_points,
      incomeBonusPercent: claim.prestige_points * PRESTIGE_INCOME_PERCENT_PER_POINT,
      incomePercentPerPoint: PRESTIGE_INCOME_PERCENT_PER_POINT,
      runGoldEarned: parseInt(claim.run_gold_earned, 10),
      pointsOnRebirth,
      nextPointAt: (pointsOnRebirth + 1) * PRESTIGE_GOLD_PER_POINT,
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
    goldEarned: save.earned,
    autoOpenedCount: opened ? opened.count : 0,
    autoCraftCount: save.autoCrafted ? save.autoCrafted.count : 0,
    notable,
  };
}

function incomeResponse(save) {
  return { ...save.income, lastCollectedAt: save.now };
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
  if (save.claim.auto_open_enabled) {
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

    const roll = rollWithPity(save.claim.mythic_pity, save.stats.luckLevel);
    await store.updateClaim(client, userId, mode, {
      box_charges: save.chargeInfo.charges - 1,
      mythic_pity: roll.pity,
    });
    await store.addItems(client, userId, mode, { [roll.treasure.key]: 1 });

    return {
      message: '상자를 열었습니다!',
      mode,
      treasure: roll.treasure,
      ...pityResponse(roll.pity, roll.guaranteed),
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
    MAX_POSSIBLE_CHARGES,
    `한 번에 최대 ${MAX_POSSIBLE_CHARGES}개까지만 열 수 있습니다.`
  );

  return withSave(userId, async (client, mode, save) => {
    assertCanOpen(save, quantity);

    const { counts, pity, pityTriggered } = rollBoxes(save.claim.mythic_pity, quantity, save.stats.luckLevel);
    await store.updateClaim(client, userId, mode, {
      box_charges: save.chargeInfo.charges - quantity,
      mythic_pity: pity,
    });
    await store.addItems(client, userId, mode, counts);

    return {
      message: `상자 ${quantity}개를 열었습니다!`,
      mode,
      quantity,
      ...pityResponse(pity, pityTriggered),
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
    const totalCost = GOLD_PER_BOX_PURCHASE * quantity;
    if (currentGold < totalCost) {
      throw new HttpError(400, `골드가 부족합니다. (필요: ${totalCost}, 보유: ${currentGold})`, {
        maxAffordable: Math.floor(currentGold / GOLD_PER_BOX_PURCHASE),
      });
    }

    const { counts, pity, pityTriggered } = rollBoxes(save.claim.mythic_pity, quantity, save.stats.luckLevel);
    await store.addItems(client, userId, mode, counts);

    const remainingGold = currentGold - totalCost;
    await store.updateClaim(client, userId, mode, { total_treasure: remainingGold, mythic_pity: pity });

    return {
      message: `골드로 상자 ${quantity}개를 구매해서 열었습니다!`,
      mode,
      quantity,
      totalCost,
      ...pityResponse(pity, pityTriggered),
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

    return {
      mode,
      isRecordMode,
      collectionComplete: obtainedCount >= TREASURES.length,
      bonusClaimed: claim.completion_bonus_claimed,
      ...chargeResponse(save.chargeInfo),
      chargeIntervalMs: save.stats.chargeIntervalMs,
      totalTreasure: claim.total_treasure,
      mythicPity: claim.mythic_pity,
      mythicPityLimit: MYTHIC_PITY_LIMIT,
      income: incomeResponse(save),
      collectorRank: getCollectorRank(obtainedCount),
      rebirthCount: claim.rebirth_count,
      runStartedAt: claim.run_started_at,
      ...progressionResponse(mode, claim),
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
// 자동화 구매 / 켜기·끄기: POST /api/box/automation { key, enabled }
// -------------------------------
// 아직 잠겨 있으면 골드를 내고 해금(켜진 상태로 시작)하고, 해금돼 있으면 enabled 값으로 켜고 끕니다.
router.post('/automation', handle('서버 오류로 자동화 설정에 실패했습니다.', async (req) => {
  const userId = req.user.userId;
  const auto = AUTOMATIONS.find(a => a.key === req.body.key);
  if (!auto) throw new HttpError(400, '존재하지 않는 자동화입니다.');

  return withSave(userId, async (client, mode, save) => {
    const gold = save.claim.total_treasure;

    if (!save.claim[auto.unlockedColumn]) {
      if (gold < auto.cost) throw new HttpError(400, `골드가 부족합니다. (필요: ${auto.cost.toLocaleString()}G)`);
      await store.updateClaim(client, userId, mode, {
        total_treasure: gold - auto.cost,
        [auto.unlockedColumn]: true,
        [auto.enabledColumn]: true,
      });
      return { message: `${auto.emoji} ${auto.name}을(를) 해금했어요!`, mode, key: auto.key, unlocked: true, enabled: true, totalTreasure: gold - auto.cost };
    }

    const enabled = Boolean(req.body.enabled);
    await store.updateClaim(client, userId, mode, { [auto.enabledColumn]: enabled });
    return { message: `${auto.emoji} ${auto.name}을(를) ${enabled ? '켰어요' : '껐어요'}.`, mode, key: auto.key, unlocked: true, enabled, totalTreasure: gold };
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
    const ownedCount = save.owned[itemKey] || 0;
    if (ownedCount < CRAFT_COST) {
      throw new HttpError(400, `합성하려면 ${sourceItem.name}이(가) ${CRAFT_COST}개 필요합니다. (현재 ${ownedCount}개)`);
    }

    const resultItem = pickRandomFromRarity(nextRarity);
    await store.addItems(client, userId, mode, { [itemKey]: -CRAFT_COST, [resultItem.key]: 1 });

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
    const { deltas, results, totalCrafts } = craftCascade(save.owned);
    if (totalCrafts === 0) {
      return { message: '합성 가능한 아이템이 없습니다.', mode, totalCrafts: 0, results: [] };
    }

    await store.addItems(client, req.user.userId, mode, deltas);
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
    const collection = TREASURES.map(item => {
      const count = save.owned[item.key] || 0;
      return {
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
      prestige: progressionResponse(mode, save.claim).prestige,
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
    await store.resetSave(client, userId, mode, now);

    return {
      message: '초심으로 돌아갔습니다. 도감도 함께 초기화됐어요. 다시 도전해보세요!',
      mode,
      totalTreasure: RESET_GOLD,
      runStartedAt: now,
    };
  });
}));

// -------------------------------
// 환생: POST /api/box/rebirth (기록모드 전용)
// -------------------------------
// 이번 판에 번 골드 5만 G당 환생 포인트 1개를 받습니다. 포인트는 영구 수입 보너스가 됩니다.
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
      throw new HttpError(400, `10만 골드가 필요합니다. (현재 ${currentGold}G)`);
    }

    const now = save.now;
    const durationMs = now - new Date(claim.run_started_at);
    const rebirthNumber = claim.rebirth_count + 1;
    const prestigeGained = getPrestigePointsForRun(claim.run_gold_earned);

    await client.query(
      `INSERT INTO rebirth_history (user_id, mode, rebirth_number, duration_ms, completed_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, mode, rebirthNumber, durationMs, now]
    );

    // 환생은 "이번 판"을 완전히 새로 시작하는 것이므로, 보유 아이템뿐 아니라
    // 도감(발견기록)·업그레이드·자동화도 함께 초기화합니다. 환생 포인트만 쌓입니다.
    await store.resetSave(client, userId, mode, now, { rebirthCount: rebirthNumber, prestigeGain: prestigeGained });

    const prestigePoints = claim.prestige_points + prestigeGained;
    return {
      message: `${rebirthNumber}번째 환생을 달성했습니다! 처음부터 다시 시작합니다.`,
      mode,
      rebirthNumber,
      durationMs,
      prestigeGained,
      prestigePoints,
      prestigeIncomeBonusPercent: prestigePoints * PRESTIGE_INCOME_PERCENT_PER_POINT,
      totalTreasure: RESET_GOLD,
      runStartedAt: now,
    };
  });
}));

// -------------------------------
// 환생 기록 조회: GET /api/box/rebirth/history (기록모드 전용 개념)
// -------------------------------
router.get('/rebirth/history', handle('서버 오류가 발생했습니다.', async (req) => {
  const historyResult = await db.query(
    `SELECT rebirth_number, duration_ms, completed_at FROM rebirth_history
     WHERE user_id = $1 AND mode = 'record' ORDER BY rebirth_number ASC`,
    [req.user.userId]
  );

  return {
    history: historyResult.rows.map(r => ({
      rebirthNumber: r.rebirth_number,
      durationMs: parseInt(r.duration_ms, 10),
      completedAt: r.completed_at,
    })),
    goldRequired: REBIRTH_GOLD_REQUIRED,
  };
}));

// -------------------------------
// 랭킹 조회: GET /api/box/leaderboard (페이지네이션, 기록모드 전용)
// -------------------------------
// 랭킹 화면에서 페이지에 내가 안 보일 때, 내 최고 기록과 전체 순위를 따로 계산합니다.
async function findMyRank(userId) {
  const myBestResult = await db.query(
    `SELECT MIN(duration_ms) AS best_duration_ms FROM rebirth_history WHERE user_id = $1 AND mode = 'record'`,
    [userId]
  );
  const myBest = myBestResult.rows[0]?.best_duration_ms;
  if (!myBest) return null;

  const rankResult = await db.query(
    `SELECT COUNT(*) + 1 AS rank FROM (
       SELECT user_id, MIN(duration_ms) AS best FROM rebirth_history WHERE mode = 'record' GROUP BY user_id
     ) t WHERE t.best < $1`,
    [myBest]
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

  const [totalResult, result] = await Promise.all([
    db.query(
      `SELECT COUNT(*) AS total FROM (
         SELECT user_id FROM rebirth_history WHERE mode = 'record' GROUP BY user_id
       ) t`
    ),
    db.query(
      `SELECT u.id AS user_id, u.nickname, MIN(rh.duration_ms) AS best_duration_ms
       FROM rebirth_history rh
       JOIN users u ON u.id = rh.user_id
       WHERE rh.mode = 'record'
       GROUP BY u.id, u.nickname
       ORDER BY best_duration_ms ASC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset]
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

  const myRank = leaderboard.find(r => r.isMe) || await findMyRank(userId);

  return { leaderboard, myRank, page, pageSize, totalPlayers, totalPages };
}));

module.exports = router;
