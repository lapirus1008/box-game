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
// - 상자는 "충전"이 다 돼야 열 수 있는 게 아니라, 시간이 지날수록 충전이 쌓입니다 (최대 100개).
//   원할 때 한 번에 몰아서 열 수도, 조금씩 열 수도 있습니다.
// - 골드는 기본적으로 초당 1골드씩 자동으로 쌓이고, 전설 등급 아이템을 갖고 있으면 개당 추가로 더 쌓입니다.
// - 기록모드에서는 10만 골드를 모으면 "환생"으로 기록을 남기고 처음부터 다시 시작할 수 있습니다.
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
  MAX_BULK_OPEN_QUANTITY,
  GOLD_PER_BOX_PURCHASE,
  MAX_GOLD_BOX_PURCHASE,
  RESET_GOLD,
  MYTHIC_PITY_LIMIT,
  MASTERY_THRESHOLDS,
} = require('../game/config');
const {
  rollWithPity,
  rollBoxes,
  getNextCraftRarity,
  pickRandomFromRarity,
  rollCraftResults,
  toObtainedList,
  getItemStars,
  getCollectorRank,
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

// 충전을 최신화한 뒤 정보를 돌려줍니다. 아직 세이브가 없으면 400 에러.
async function requireCharges(client, userId, mode) {
  const chargeInfo = await store.syncBoxCharges(client, userId, mode);
  if (!chargeInfo) throw new HttpError(400, NOT_STARTED_MESSAGE);
  return chargeInfo;
}

function pityResponse(pity, triggered) {
  return { mythicPity: pity, mythicPityLimit: MYTHIC_PITY_LIMIT, mythicPityTriggered: triggered };
}

function chargeResponse(chargeInfo, chargesUsed) {
  return {
    charges: chargeInfo.charges - chargesUsed,
    maxCharges: chargeInfo.maxCharges,
    nextChargeInMs: chargeInfo.nextChargeInMs,
    serverTime: chargeInfo.serverTime,
  };
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

// -------------------------------
// 상자 열기: POST /api/box/open (충전 1개 소모)
// -------------------------------
router.post('/open', handle('서버 오류로 상자를 열지 못했습니다.', async (req) => {
  const userId = req.user.userId;

  return withTransaction(async (client) => {
    const mode = await store.getActiveMode(client, userId);
    const chargeInfo = await requireCharges(client, userId, mode);
    if (chargeInfo.charges < 1) {
      throw new HttpError(429, '충전된 상자가 없습니다. 잠시 후 다시 시도해주세요.', {
        charges: chargeInfo.charges,
        maxCharges: chargeInfo.maxCharges,
        nextChargeInMs: chargeInfo.nextChargeInMs,
      });
    }

    const claim = await store.getClaim(client, userId, mode, ['mythic_pity', 'total_treasure']);
    const roll = rollWithPity(claim.mythic_pity);

    await client.query(
      'UPDATE box_claims SET box_charges = box_charges - 1, mythic_pity = $3 WHERE user_id = $1 AND mode = $2',
      [userId, mode, roll.pity]
    );
    await store.addItems(client, userId, mode, { [roll.treasure.key]: 1 });

    return {
      message: '상자를 열었습니다!',
      mode,
      treasure: roll.treasure,
      ...pityResponse(roll.pity, roll.guaranteed),
      totalTreasure: parseInt(claim.total_treasure, 10),
      ...chargeResponse(chargeInfo, 1),
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
    MAX_BULK_OPEN_QUANTITY,
    `한 번에 최대 ${MAX_BULK_OPEN_QUANTITY}개까지만 열 수 있습니다.`
  );

  return withTransaction(async (client) => {
    const mode = await store.getActiveMode(client, userId);
    const chargeInfo = await requireCharges(client, userId, mode);
    if (quantity > chargeInfo.charges) {
      throw new HttpError(400, `충전된 상자가 부족합니다. (요청: ${quantity}개, 보유: ${chargeInfo.charges}개)`, {
        maxAffordable: chargeInfo.charges,
      });
    }

    const claim = await store.getClaim(client, userId, mode, ['mythic_pity', 'total_treasure']);
    const { counts, pity, pityTriggered } = rollBoxes(claim.mythic_pity, quantity);

    await client.query(
      'UPDATE box_claims SET box_charges = box_charges - $1, mythic_pity = $4 WHERE user_id = $2 AND mode = $3',
      [quantity, userId, mode, pity]
    );
    await store.addItems(client, userId, mode, counts);

    return {
      message: `상자 ${quantity}개를 열었습니다!`,
      mode,
      quantity,
      ...pityResponse(pity, pityTriggered),
      totalTreasure: parseInt(claim.total_treasure, 10),
      obtained: toObtainedList(counts),
      ...chargeResponse(chargeInfo, quantity),
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

  return withTransaction(async (client) => {
    const mode = await store.getActiveMode(client, userId);
    const claim = await store.getClaim(client, userId, mode, ['total_treasure', 'mythic_pity'], { forUpdate: true });
    if (!claim) throw new HttpError(400, NOT_STARTED_MESSAGE);

    const currentGold = parseInt(claim.total_treasure, 10);
    const totalCost = GOLD_PER_BOX_PURCHASE * quantity;
    if (currentGold < totalCost) {
      throw new HttpError(400, `골드가 부족합니다. (필요: ${totalCost}, 보유: ${currentGold})`, {
        maxAffordable: Math.floor(currentGold / GOLD_PER_BOX_PURCHASE),
      });
    }

    const { counts, pity, pityTriggered } = rollBoxes(claim.mythic_pity, quantity);
    await store.addItems(client, userId, mode, counts);

    const remainingGold = currentGold - totalCost;
    await client.query(
      'UPDATE box_claims SET total_treasure = $1, mythic_pity = $4 WHERE user_id = $2 AND mode = $3',
      [remainingGold, userId, mode, pity]
    );

    return {
      message: `골드로 상자 ${quantity}개를 구매해서 열었습니다!`,
      mode,
      quantity,
      totalCost,
      ...pityResponse(pity, pityTriggered),
      totalTreasure: remainingGold,
      obtained: toObtainedList(counts),
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

    const chargeInfo = await store.syncBoxCharges(client, userId, mode);
    if (!chargeInfo) {
      return { mode, isRecordMode, charges: 0, maxCharges: MAX_BOX_CHARGES, totalTreasure: 0 };
    }

    const claim = await store.getClaim(client, userId, mode, [
      'total_treasure', 'last_income_collected_at', 'rebirth_count',
      'run_started_at', 'mythic_pity', 'completion_bonus_claimed',
    ]);
    const breakdown = await store.computeIncomeBreakdown(client, userId, mode);

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
      charges: chargeInfo.charges,
      maxCharges: chargeInfo.maxCharges,
      nextChargeInMs: chargeInfo.nextChargeInMs,
      totalTreasure: parseInt(claim.total_treasure, 10),
      mythicPity: claim.mythic_pity,
      mythicPityLimit: MYTHIC_PITY_LIMIT,
      serverTime: chargeInfo.serverTime,
      passiveIncomePreview: {
        ...breakdown,
        lastCollectedAt: claim.last_income_collected_at,
      },
      collectorRank: getCollectorRank(obtainedCount),
      rebirthCount: claim.rebirth_count,
      runStartedAt: claim.run_started_at,
    };
  });
}));

// -------------------------------
// 패시브 골드 받기: POST /api/box/collect-income
// -------------------------------
router.post('/collect-income', handle('서버 오류로 수령에 실패했습니다.', async (req) => {
  const userId = req.user.userId;

  return withTransaction(async (client) => {
    const mode = await store.getActiveMode(client, userId);
    const income = await store.collectPassiveIncome(client, userId, mode);
    if (!income) throw new HttpError(400, NOT_STARTED_MESSAGE);

    return {
      message: income.earned > 0 ? `${income.earned}G를 받았습니다!` : '아직 쌓인 골드가 없습니다.',
      mode,
      earned: income.earned,
      totalTreasure: income.newTotal,
      perSecondIncome: income.perSecondIncome,
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

  return withTransaction(async (client) => {
    const mode = await store.getActiveMode(client, userId);

    const ownedResult = await client.query(
      'SELECT count FROM user_items WHERE user_id = $1 AND mode = $2 AND item_key = $3 FOR UPDATE',
      [userId, mode, itemKey]
    );
    const ownedCount = ownedResult.rows[0]?.count || 0;
    if (ownedCount < CRAFT_COST) {
      throw new HttpError(400, `합성하려면 ${sourceItem.name}이(가) ${CRAFT_COST}개 필요합니다. (현재 ${ownedCount}개)`);
    }

    await client.query(
      'UPDATE user_items SET count = count - $1 WHERE user_id = $2 AND mode = $3 AND item_key = $4',
      [CRAFT_COST, userId, mode, itemKey]
    );

    const resultItem = pickRandomFromRarity(nextRarity);
    await store.addItems(client, userId, mode, { [resultItem.key]: 1 });

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
router.post('/craft-all', handle('서버 오류로 일괄 합성에 실패했습니다.', async (req) => {
  const userId = req.user.userId;

  return withTransaction(async (client) => {
    const mode = await store.getActiveMode(client, userId);

    const ownedResult = await client.query(
      'SELECT item_key, count FROM user_items WHERE user_id = $1 AND mode = $2 AND count >= $3 FOR UPDATE',
      [userId, mode, CRAFT_COST]
    );

    const results = [];
    let totalCrafts = 0;

    for (const row of ownedResult.rows) {
      const sourceItem = TREASURE_BY_KEY.get(row.item_key);
      if (!sourceItem) continue;

      const nextRarity = getNextCraftRarity(sourceItem);
      if (!nextRarity) continue; // 전설/신화는 합성 불가

      const craftCount = Math.floor(row.count / CRAFT_COST);
      if (craftCount === 0) continue;

      await client.query(
        'UPDATE user_items SET count = count - $1 WHERE user_id = $2 AND mode = $3 AND item_key = $4',
        [craftCount * CRAFT_COST, userId, mode, row.item_key]
      );

      const obtainedCounts = rollCraftResults(nextRarity, craftCount);
      await store.addItems(client, userId, mode, obtainedCounts);

      totalCrafts += craftCount;
      results.push({
        consumedKey: sourceItem.key,
        consumedName: sourceItem.name,
        craftCount,
        obtained: toObtainedList(obtainedCounts, ['name', 'emoji']),
      });
    }

    if (totalCrafts === 0) {
      return { message: '합성 가능한 아이템이 없습니다.', mode, totalCrafts: 0, results: [] };
    }
    return { message: `총 ${totalCrafts}번 합성했습니다!`, mode, totalCrafts, results };
  });
}));

// -------------------------------
// 도감 조회: GET /api/box/collection
// -------------------------------
router.get('/collection', handle('서버 오류가 발생했습니다.', async (req) => {
  const userId = req.user.userId;
  const mode = await store.getActiveMode(db, userId);

  const [discoveryResult, itemsResult, claim, breakdown] = await Promise.all([
    // 발견 기록: 기록모드에선 "이번 판" 한정, 수집모드에선 영구
    db.query('SELECT item_key, first_discovered_at FROM user_discoveries WHERE user_id = $1 AND mode = $2', [userId, mode]),
    // 보유 개수 (현재 모드 기준)
    db.query('SELECT item_key, count FROM user_items WHERE user_id = $1 AND mode = $2', [userId, mode]),
    store.getClaim(db, userId, mode, ['total_treasure', 'completion_bonus_claimed', 'last_income_collected_at']),
    store.computeIncomeBreakdown(db, userId, mode),
  ]);

  const discoveryMap = {};
  discoveryResult.rows.forEach(row => { discoveryMap[row.item_key] = row.first_discovered_at; });
  const countMap = {};
  itemsResult.rows.forEach(row => { countMap[row.item_key] = row.count; });

  // 아이템 숙련도(★): 같은 아이템을 많이 모을수록 붙는 표시용 등급입니다.
  const collection = TREASURES.map(item => {
    const count = countMap[item.key] || 0;
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
    };
  });

  const obtainedCount = collection.filter(item => item.obtained).length;

  return {
    mode,
    isRecordMode: mode === MODES.RECORD,
    collection,
    totalTreasure: parseInt(claim?.total_treasure || 0, 10),
    progress: { obtained: obtainedCount, total: TREASURES.length },
    isComplete: obtainedCount === TREASURES.length,
    bonusClaimed: claim?.completion_bonus_claimed || false,
    collectorRank: getCollectorRank(obtainedCount),
    passiveIncomePreview: {
      ...breakdown,
      lastCollectedAt: claim?.last_income_collected_at,
    },
  };
}));

// -------------------------------
// 도감 완성 보상 수령: POST /api/box/collection/claim-bonus
// -------------------------------
router.post('/collection/claim-bonus', handle('서버 오류가 발생했습니다.', async (req) => {
  const userId = req.user.userId;

  return withTransaction(async (client) => {
    const mode = await store.getActiveMode(client, userId);

    const claim = await store.getClaim(client, userId, mode, ['total_treasure', 'completion_bonus_claimed'], { forUpdate: true });
    if (!claim) throw new HttpError(400, '아직 상자를 한 번도 열지 않았습니다.');
    if (claim.completion_bonus_claimed) throw new HttpError(400, '이미 완성 보상을 받으셨습니다.');

    const discoveredResult = await client.query(
      'SELECT item_key FROM user_discoveries WHERE user_id = $1 AND mode = $2',
      [userId, mode]
    );
    const discoveredKeys = new Set(discoveredResult.rows.map(r => r.item_key));
    if (!TREASURES.every(t => discoveredKeys.has(t.key))) {
      throw new HttpError(400, '아직 모든 아이템을 모으지 못했습니다.');
    }

    const newTotal = parseInt(claim.total_treasure, 10) + COMPLETION_BONUS_GOLD;
    await client.query(
      'UPDATE box_claims SET total_treasure = $1, completion_bonus_claimed = TRUE WHERE user_id = $2 AND mode = $3',
      [newTotal, userId, mode]
    );

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
// - 기록모드: 골드·아이템·도감을 전부 초기화합니다 ("이번 판" 자체를 새로 시작하는 것이므로).
// - 수집모드: 사용할 수 없습니다. (도감/천장이 영구라서 초기화가 무한 파밍 통로가 됨)
// 환생과 달리 "성공한 기록"이 아니라서 rebirth_count나 랭킹에는 남지 않습니다.
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
router.post('/rebirth', handle('서버 오류로 환생에 실패했습니다.', async (req) => {
  const userId = req.user.userId;

  return withTransaction(async (client) => {
    const mode = await store.getActiveMode(client, userId);
    if (mode !== MODES.RECORD) {
      throw new HttpError(400, '수집모드에서는 환생할 수 없습니다. 기록모드로 전환해주세요.');
    }

    const claim = await store.getClaim(client, userId, mode, ['total_treasure', 'rebirth_count', 'run_started_at'], { forUpdate: true });
    if (!claim) throw new HttpError(400, NOT_STARTED_MESSAGE);

    const currentGold = parseInt(claim.total_treasure, 10);
    if (currentGold < REBIRTH_GOLD_REQUIRED) {
      throw new HttpError(400, `10만 골드가 필요합니다. (현재 ${currentGold}G)`);
    }

    const now = new Date();
    const durationMs = now - new Date(claim.run_started_at);
    const rebirthNumber = claim.rebirth_count + 1;

    await client.query(
      `INSERT INTO rebirth_history (user_id, mode, rebirth_number, duration_ms, completed_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, mode, rebirthNumber, durationMs, now]
    );

    // 환생은 "이번 판"을 완전히 새로 시작하는 것이므로, 보유 아이템뿐 아니라
    // 도감(발견기록)도 함께 초기화합니다.
    await store.resetSave(client, userId, mode, now, { rebirthCount: rebirthNumber });

    return {
      message: `${rebirthNumber}번째 환생을 달성했습니다! 처음부터 다시 시작합니다.`,
      mode,
      rebirthNumber,
      durationMs,
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
