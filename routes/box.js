// routes/box.js
// 로그인한 사용자가 상자를 열어 아이템을 모으는 API입니다.
//
// [핵심 구조]
// - 상자는 "충전"이 다 돼야 열 수 있는 게 아니라, 시간이 지날수록 충전이 쌓입니다 (최대 100개).
//   원할 때 한 번에 몰아서 열 수도, 조금씩 열 수도 있습니다.
// - 골드는 기본적으로 초당 1골드씩 자동으로 쌓이고, 전설 등급 아이템을 갖고 있으면 개당 추가로 더 쌓입니다.
// - 10만 골드를 모으면 "환생"으로 기록을 남기고 처음부터 다시 시작할 수 있습니다.

const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/auth');

const router = express.Router();

// -------------------------------
// 기본 설정값
// -------------------------------
const CHARGE_INTERVAL_MS = 15 * 1000; // 충전 1개가 쌓이는 데 걸리는 시간
const MAX_BOX_CHARGES = 100;          // 충전은 최대 이만큼만 쌓입니다
const BASE_INCOME_PER_SECOND = 1;     // 누구나 기본으로 받는 초당 골드
const LEGENDARY_INCOME_PER_SECOND = 1; // 전설 아이템 1개당 추가되는 초당 골드
const RARITY_ORDER = ['common', 'rare', 'epic', 'legendary'];
const CRAFT_COST = 3;                 // 합성에 필요한 같은 아이템 개수
const COMPLETION_BONUS_GOLD = 2000;   // 도감 완성 보상
const REBIRTH_GOLD_REQUIRED = 100000; // 환생에 필요한 골드
const MAX_BULK_OPEN_QUANTITY = MAX_BOX_CHARGES; // 한 번에 열 수 있는 최대 개수 (충전 최대치와 동일)
const GOLD_PER_BOX_PURCHASE = 75; // 충전과 별개로, 골드를 내고 상자를 즉시 구매할 때의 개당 가격
const MAX_GOLD_BOX_PURCHASE = 500; // 한 번에 골드로 구매할 수 있는 최대 개수 (서버 보호용 상한선)

// 수집 가능한 아이템 목록입니다. weight가 클수록 자주 나옵니다.
// key는 DB(user_items 테이블)에 저장될 고유 식별자라 나중에 함부로 바꾸면 안 됩니다.
const TREASURES = [
  // 일반 (common) - 자주 나옴
  { key: 'rusty_coin',    name: '녹슨 동전',      rarity: 'common',    emoji: '🟤', amount: 10, weight: 30, flavor: '오래된 상인의 지갑에서 나온 듯한 동전.' },
  { key: 'stone_carving', name: '돌 조각상',      rarity: 'common',    emoji: '🗿', amount: 8,  weight: 25, flavor: '투박하지만 정성이 느껴지는 조각.' },
  { key: 'torn_map',      name: '낡은 지도 조각', rarity: 'common',    emoji: '🗺️', amount: 12, weight: 20, flavor: '나머지 조각은 어디에 있을까?' },
  { key: 'small_gem',     name: '작은 보석',      rarity: 'common',    emoji: '💎', amount: 15, weight: 15, flavor: '작지만 은은하게 빛난다.' },
  // 희귀 (rare)
  { key: 'silver_pouch',  name: '은화 주머니',    rarity: 'rare',      emoji: '👛', amount: 40, weight: 6,  flavor: '묵직한 소리가 나는 주머니.' },
  { key: 'lucky_charm',   name: '행운의 부적',    rarity: 'rare',      emoji: '🍀', amount: 45, weight: 5,  flavor: '지니고 있으면 왠지 좋은 일이 생길 것 같다.' },
  { key: 'fairy_wing',    name: '요정의 날개',    rarity: 'rare',      emoji: '🧚', amount: 50, weight: 4,  flavor: '만지면 반짝이는 가루가 떨어진다.' },
  // 영웅 (epic)
  { key: 'dragon_scale',  name: '용의 비늘',      rarity: 'epic',      emoji: '🐉', amount: 150, weight: 1.5, flavor: '믿기 힘들 정도로 단단하다.' },
  { key: 'star_fragment', name: '별의 파편',      rarity: 'epic',      emoji: '✨', amount: 180, weight: 1,   flavor: '밤하늘에서 떨어진 조각이라고 전해진다.' },
  // 전설 (legendary) - 매우 희귀, 갖고 있으면 초당 골드도 추가로 벌립니다
  { key: 'phoenix_feather', name: '불사조의 깃털', rarity: 'legendary', emoji: '🔥', amount: 500, weight: 0.3, flavor: '전설 속에서만 존재한다던 그 깃털.' },
  { key: 'hourglass_sand',  name: '시간의 모래',   rarity: 'legendary', emoji: '⏳', amount: 600, weight: 0.2, flavor: '만지는 순간 시간이 멈춘 듯한 착각이 든다.' },
];

// -------------------------------
// 공용 헬퍼 함수들
// -------------------------------

// weight 기반으로 전체 아이템 중 하나를 랜덤하게 뽑습니다.
function pickRandomTreasure() {
  const totalWeight = TREASURES.reduce((sum, t) => sum + t.weight, 0);
  let rand = Math.random() * totalWeight;
  for (const treasure of TREASURES) {
    if (rand < treasure.weight) return treasure;
    rand -= treasure.weight;
  }
  return TREASURES[0];
}

// 특정 등급 안에서만 weight 기반으로 하나를 뽑습니다 (합성 결과용).
function pickRandomFromRarity(rarity) {
  const pool = TREASURES.filter(t => t.rarity === rarity);
  const totalWeight = pool.reduce((sum, t) => sum + t.weight, 0);
  let rand = Math.random() * totalWeight;
  for (const treasure of pool) {
    if (rand < treasure.weight) return treasure;
    rand -= treasure.weight;
  }
  return pool[0];
}

// 충전 개수를 최신 상태로 계산해서 필요하면 DB에 반영합니다.
// client는 이미 BEGIN된 트랜잭션의 client여야 합니다 (동시 요청 안전성을 위해 FOR UPDATE 사용).
async function syncBoxCharges(client, userId) {
  const result = await client.query(
    'SELECT box_charges, last_charge_calculated_at FROM box_claims WHERE user_id = $1 FOR UPDATE',
    [userId]
  );
  if (result.rows.length === 0) return null;

  const { box_charges, last_charge_calculated_at } = result.rows[0];
  const now = new Date();
  const lastCalc = new Date(last_charge_calculated_at);
  const gained = Math.floor((now - lastCalc) / CHARGE_INTERVAL_MS);

  let newCharges = box_charges;
  let newLastCalc = lastCalc;

  if (gained > 0) {
    newCharges = Math.min(MAX_BOX_CHARGES, box_charges + gained);
    // 꽉 찼으면 더 이상 시간을 쌓아둘 필요가 없으니 기준 시각을 지금으로 당겨둡니다.
    newLastCalc = newCharges >= MAX_BOX_CHARGES ? now : new Date(lastCalc.getTime() + gained * CHARGE_INTERVAL_MS);

    await client.query(
      'UPDATE box_claims SET box_charges = $1, last_charge_calculated_at = $2 WHERE user_id = $3',
      [newCharges, newLastCalc, userId]
    );
  }

  const nextChargeInMs = newCharges >= MAX_BOX_CHARGES ? null : CHARGE_INTERVAL_MS - (now - newLastCalc);

  return { charges: newCharges, maxCharges: MAX_BOX_CHARGES, nextChargeInMs, serverTime: now };
}

// 마지막 정산 이후 쌓인 패시브 골드(기본 + 전설 아이템 보너스)를 계산해서 반영합니다.
async function collectPassiveIncome(client, userId) {
  const claimResult = await client.query(
    'SELECT total_treasure, last_income_collected_at FROM box_claims WHERE user_id = $1 FOR UPDATE',
    [userId]
  );
  if (claimResult.rows.length === 0) return null;

  const { total_treasure, last_income_collected_at } = claimResult.rows[0];
  const now = new Date();
  const lastCollected = new Date(last_income_collected_at);
  const elapsedSeconds = (now - lastCollected) / 1000;

  const legendaryKeys = TREASURES.filter(t => t.rarity === 'legendary').map(t => t.key);
  const itemsResult = await client.query(
    'SELECT COALESCE(SUM(count), 0) AS total FROM user_items WHERE user_id = $1 AND item_key = ANY($2)',
    [userId, legendaryKeys]
  );
  const legendaryCount = parseInt(itemsResult.rows[0].total, 10);
  const perSecondIncome = BASE_INCOME_PER_SECOND + legendaryCount * LEGENDARY_INCOME_PER_SECOND;

  const earned = Math.floor(elapsedSeconds * perSecondIncome);
  const newTotal = parseInt(total_treasure, 10) + earned;

  await client.query(
    'UPDATE box_claims SET total_treasure = $1, last_income_collected_at = $2 WHERE user_id = $3',
    [newTotal, now, userId]
  );

  return {
    earned,
    newTotal,
    legendaryCount,
    baseIncome: BASE_INCOME_PER_SECOND,
    legendaryIncome: legendaryCount * LEGENDARY_INCOME_PER_SECOND,
    perSecondIncome,
  };
}

// 아이템을 얻을 때마다 도감(user_items)에 기록/카운트 증가
async function recordItemObtained(client, userId, itemKey) {
  await client.query(
    `INSERT INTO user_items (user_id, item_key, count, first_obtained_at)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (user_id, item_key)
     DO UPDATE SET count = user_items.count + 1`,
    [userId, itemKey]
  );
}

// -------------------------------
// 상자 열기: POST /api/box/open (충전 1개 소모)
// -------------------------------
router.post('/open', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const chargeInfo = await syncBoxCharges(client, userId);
    if (!chargeInfo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: '아직 게임을 시작하지 않았습니다.' });
    }
    if (chargeInfo.charges < 1) {
      await client.query('ROLLBACK');
      return res.status(429).json({
        message: '충전된 상자가 없습니다. 잠시 후 다시 시도해주세요.',
        charges: chargeInfo.charges,
        maxCharges: chargeInfo.maxCharges,
        nextChargeInMs: chargeInfo.nextChargeInMs,
      });
    }

    await client.query('UPDATE box_claims SET box_charges = box_charges - 1 WHERE user_id = $1', [userId]);

    const treasure = pickRandomTreasure();
    await recordItemObtained(client, userId, treasure.key);

    const goldResult = await client.query('SELECT total_treasure FROM box_claims WHERE user_id = $1', [userId]);

    await client.query('COMMIT');

    res.json({
      message: '상자를 열었습니다!',
      treasure,
      totalTreasure: parseInt(goldResult.rows[0].total_treasure, 10),
      charges: chargeInfo.charges - 1,
      maxCharges: chargeInfo.maxCharges,
      nextChargeInMs: chargeInfo.nextChargeInMs,
      serverTime: chargeInfo.serverTime,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ message: '서버 오류로 상자를 열지 못했습니다.' });
  } finally {
    client.release();
  }
});

// -------------------------------
// 수량 지정 일괄 열기: POST /api/box/bulk-open (충전 quantity개 소모)
// -------------------------------
router.post('/bulk-open', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const quantity = parseInt(req.body.quantity, 10);

  if (!Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ message: '수량은 1 이상의 정수여야 합니다.' });
  }
  if (quantity > MAX_BULK_OPEN_QUANTITY) {
    return res.status(400).json({ message: `한 번에 최대 ${MAX_BULK_OPEN_QUANTITY}개까지만 열 수 있습니다.` });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const chargeInfo = await syncBoxCharges(client, userId);
    if (!chargeInfo) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: '아직 게임을 시작하지 않았습니다.' });
    }
    if (quantity > chargeInfo.charges) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `충전된 상자가 부족합니다. (요청: ${quantity}개, 보유: ${chargeInfo.charges}개)`,
        maxAffordable: chargeInfo.charges,
      });
    }

    await client.query('UPDATE box_claims SET box_charges = box_charges - $1 WHERE user_id = $2', [quantity, userId]);

    // quantity번 랜덤으로 뽑되, DB에는 아이템별로 합산해서 반영 (효율적으로)
    const obtainedCounts = {};
    for (let i = 0; i < quantity; i++) {
      const treasure = pickRandomTreasure();
      obtainedCounts[treasure.key] = (obtainedCounts[treasure.key] || 0) + 1;
    }

    for (const [itemKey, count] of Object.entries(obtainedCounts)) {
      await client.query(
        `INSERT INTO user_items (user_id, item_key, count, first_obtained_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, item_key)
         DO UPDATE SET count = user_items.count + $3`,
        [userId, itemKey, count]
      );
    }

    const goldResult = await client.query('SELECT total_treasure FROM box_claims WHERE user_id = $1', [userId]);

    await client.query('COMMIT');

    const obtainedList = Object.entries(obtainedCounts).map(([key, count]) => {
      const item = TREASURES.find(t => t.key === key);
      return { key, name: item.name, emoji: item.emoji, rarity: item.rarity, count };
    });

    res.json({
      message: `상자 ${quantity}개를 열었습니다!`,
      quantity,
      totalTreasure: parseInt(goldResult.rows[0].total_treasure, 10),
      obtained: obtainedList,
      charges: chargeInfo.charges - quantity,
      maxCharges: chargeInfo.maxCharges,
      nextChargeInMs: chargeInfo.nextChargeInMs,
      serverTime: chargeInfo.serverTime,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ message: '서버 오류로 일괄 열기에 실패했습니다.' });
  } finally {
    client.release();
  }
});

// -------------------------------
// 골드로 상자 구매해서 열기: POST /api/box/buy-boxes (충전과 무관, 골드만 소모)
// -------------------------------
router.post('/buy-boxes', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const quantity = parseInt(req.body.quantity, 10);

  if (!Number.isInteger(quantity) || quantity < 1) {
    return res.status(400).json({ message: '수량은 1 이상의 정수여야 합니다.' });
  }
  if (quantity > MAX_GOLD_BOX_PURCHASE) {
    return res.status(400).json({ message: `한 번에 최대 ${MAX_GOLD_BOX_PURCHASE}개까지만 구매할 수 있습니다.` });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      'SELECT total_treasure FROM box_claims WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: '아직 게임을 시작하지 않았습니다.' });
    }

    const currentGold = parseInt(result.rows[0].total_treasure, 10);
    const totalCost = GOLD_PER_BOX_PURCHASE * quantity;

    if (currentGold < totalCost) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `골드가 부족합니다. (필요: ${totalCost}, 보유: ${currentGold})`,
        maxAffordable: Math.floor(currentGold / GOLD_PER_BOX_PURCHASE),
      });
    }

    // quantity번 랜덤으로 뽑되, DB에는 아이템별로 합산해서 반영 (효율적으로)
    const obtainedCounts = {};
    for (let i = 0; i < quantity; i++) {
      const treasure = pickRandomTreasure();
      obtainedCounts[treasure.key] = (obtainedCounts[treasure.key] || 0) + 1;
    }

    for (const [itemKey, count] of Object.entries(obtainedCounts)) {
      await client.query(
        `INSERT INTO user_items (user_id, item_key, count, first_obtained_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, item_key)
         DO UPDATE SET count = user_items.count + $3`,
        [userId, itemKey, count]
      );
    }

    const remainingGold = currentGold - totalCost;
    // 주의: 이건 충전(box_charges)과 완전히 무관합니다. 골드만 쓰고, 충전은 그대로 유지됩니다.
    await client.query('UPDATE box_claims SET total_treasure = $1 WHERE user_id = $2', [remainingGold, userId]);

    await client.query('COMMIT');

    const obtainedList = Object.entries(obtainedCounts).map(([key, count]) => {
      const item = TREASURES.find(t => t.key === key);
      return { key, name: item.name, emoji: item.emoji, rarity: item.rarity, count };
    });

    res.json({
      message: `골드로 상자 ${quantity}개를 구매해서 열었습니다!`,
      quantity,
      totalCost,
      totalTreasure: remainingGold,
      obtained: obtainedList,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ message: '서버 오류로 구매에 실패했습니다.' });
  } finally {
    client.release();
  }
});

// -------------------------------
// 상태 조회: GET /api/box/status
// -------------------------------
router.get('/status', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const chargeInfo = await syncBoxCharges(client, userId);
    if (!chargeInfo) {
      await client.query('COMMIT');
      return res.json({ charges: 0, maxCharges: MAX_BOX_CHARGES, totalTreasure: 0 });
    }

    const row = await client.query(
      `SELECT total_treasure, last_income_collected_at, rebirth_count, run_started_at
       FROM box_claims WHERE user_id = $1`,
      [userId]
    );

    const legendaryKeys = TREASURES.filter(t => t.rarity === 'legendary').map(t => t.key);
    const itemsResult = await client.query(
      'SELECT COALESCE(SUM(count), 0) AS total FROM user_items WHERE user_id = $1 AND item_key = ANY($2)',
      [userId, legendaryKeys]
    );
    const legendaryCount = parseInt(itemsResult.rows[0].total, 10);

    await client.query('COMMIT');

    res.json({
      charges: chargeInfo.charges,
      maxCharges: chargeInfo.maxCharges,
      nextChargeInMs: chargeInfo.nextChargeInMs,
      totalTreasure: parseInt(row.rows[0].total_treasure, 10),
      serverTime: chargeInfo.serverTime,
      passiveIncomePreview: {
        legendaryCount,
        baseIncome: BASE_INCOME_PER_SECOND,
        legendaryIncome: legendaryCount * LEGENDARY_INCOME_PER_SECOND,
        perSecondIncome: BASE_INCOME_PER_SECOND + legendaryCount * LEGENDARY_INCOME_PER_SECOND,
        lastCollectedAt: row.rows[0].last_income_collected_at,
      },
      rebirthCount: row.rows[0].rebirth_count,
      runStartedAt: row.rows[0].run_started_at,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  } finally {
    client.release();
  }
});

// -------------------------------
// 도감 조회: GET /api/box/collection
// -------------------------------
router.get('/collection', verifyToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    const result = await db.query(
      'SELECT item_key, count, first_obtained_at FROM user_items WHERE user_id = $1',
      [userId]
    );

    // key로 빠르게 찾을 수 있도록 맵으로 변환 (한 번이라도 얻었으면 count가 0이어도 존재함 = 획득한 것으로 침)
    const obtainedMap = {};
    result.rows.forEach(row => {
      obtainedMap[row.item_key] = { count: row.count, firstObtainedAt: row.first_obtained_at };
    });

    const collection = TREASURES.map(item => ({
      key: item.key,
      name: item.name,
      rarity: item.rarity,
      emoji: item.emoji,
      flavor: item.flavor,
      count: obtainedMap[item.key]?.count || 0,
      obtained: Boolean(obtainedMap[item.key]), // 존재 여부 기준 (합성으로 0개가 돼도 계속 true)
    }));

    const treasureResult = await db.query(
      'SELECT total_treasure, completion_bonus_claimed, last_income_collected_at FROM box_claims WHERE user_id = $1',
      [userId]
    );
    const totalTreasure = parseInt(treasureResult.rows[0]?.total_treasure || 0, 10);
    const bonusClaimed = treasureResult.rows[0]?.completion_bonus_claimed || false;

    const obtainedCount = collection.filter(item => item.obtained).length;
    const isComplete = obtainedCount === TREASURES.length;

    const legendaryKeys = TREASURES.filter(t => t.rarity === 'legendary').map(t => t.key);
    const legendaryCount = collection
      .filter(item => legendaryKeys.includes(item.key))
      .reduce((sum, item) => sum + item.count, 0);

    res.json({
      collection,
      totalTreasure,
      progress: { obtained: obtainedCount, total: TREASURES.length },
      isComplete,
      bonusClaimed,
      passiveIncomePreview: {
        legendaryCount,
        baseIncome: BASE_INCOME_PER_SECOND,
        legendaryIncome: legendaryCount * LEGENDARY_INCOME_PER_SECOND,
        perSecondIncome: BASE_INCOME_PER_SECOND + legendaryCount * LEGENDARY_INCOME_PER_SECOND,
        lastCollectedAt: treasureResult.rows[0]?.last_income_collected_at,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

// -------------------------------
// 패시브 골드 받기: POST /api/box/collect-income
// -------------------------------
router.post('/collect-income', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const client = await db.getClient();

  try {
    await client.query('BEGIN');
    const income = await collectPassiveIncome(client, userId);
    await client.query('COMMIT');

    if (!income) {
      return res.status(400).json({ message: '아직 게임을 시작하지 않았습니다.' });
    }

    res.json({
      message: income.earned > 0 ? `${income.earned}G를 받았습니다!` : '아직 쌓인 골드가 없습니다.',
      earned: income.earned,
      totalTreasure: income.newTotal,
      perSecondIncome: income.perSecondIncome,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ message: '서버 오류로 수령에 실패했습니다.' });
  } finally {
    client.release();
  }
});

// -------------------------------
// 아이템 합성: POST /api/box/craft
// -------------------------------
router.post('/craft', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const { itemKey } = req.body;

  const sourceItem = TREASURES.find(t => t.key === itemKey);
  if (!sourceItem) {
    return res.status(400).json({ message: '존재하지 않는 아이템입니다.' });
  }

  const rarityIndex = RARITY_ORDER.indexOf(sourceItem.rarity);
  if (rarityIndex === RARITY_ORDER.length - 1) {
    return res.status(400).json({ message: '이미 최고 등급이라 더 합성할 수 없습니다.' });
  }
  const nextRarity = RARITY_ORDER[rarityIndex + 1];

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const ownedResult = await client.query(
      'SELECT count FROM user_items WHERE user_id = $1 AND item_key = $2 FOR UPDATE',
      [userId, itemKey]
    );
    const ownedCount = ownedResult.rows[0]?.count || 0;
    if (ownedCount < CRAFT_COST) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `합성하려면 ${sourceItem.name}이(가) ${CRAFT_COST}개 필요합니다. (현재 ${ownedCount}개)`,
      });
    }

    await client.query(
      'UPDATE user_items SET count = count - $1 WHERE user_id = $2 AND item_key = $3',
      [CRAFT_COST, userId, itemKey]
    );

    const resultItem = pickRandomFromRarity(nextRarity);
    await client.query(
      `INSERT INTO user_items (user_id, item_key, count, first_obtained_at)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (user_id, item_key)
       DO UPDATE SET count = user_items.count + 1`,
      [userId, resultItem.key]
    );

    await client.query('COMMIT');

    res.json({
      message: '합성 성공!',
      consumed: { key: sourceItem.key, name: sourceItem.name, amount: CRAFT_COST },
      result: resultItem,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ message: '서버 오류로 합성에 실패했습니다.' });
  } finally {
    client.release();
  }
});

// -------------------------------
// 일괄 합성: POST /api/box/craft-all
// -------------------------------
router.post('/craft-all', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const ownedResult = await client.query(
      'SELECT item_key, count FROM user_items WHERE user_id = $1 AND count >= $2 FOR UPDATE',
      [userId, CRAFT_COST]
    );

    const results = [];
    let totalCrafts = 0;

    for (const row of ownedResult.rows) {
      const sourceItem = TREASURES.find(t => t.key === row.item_key);
      if (!sourceItem) continue;

      const rarityIndex = RARITY_ORDER.indexOf(sourceItem.rarity);
      if (rarityIndex === RARITY_ORDER.length - 1) continue;

      const nextRarity = RARITY_ORDER[rarityIndex + 1];
      const craftCount = Math.floor(row.count / CRAFT_COST);
      if (craftCount === 0) continue;

      await client.query(
        'UPDATE user_items SET count = count - $1 WHERE user_id = $2 AND item_key = $3',
        [craftCount * CRAFT_COST, userId, row.item_key]
      );

      const obtainedItems = {};
      for (let i = 0; i < craftCount; i++) {
        const resultItem = pickRandomFromRarity(nextRarity);
        obtainedItems[resultItem.key] = (obtainedItems[resultItem.key] || 0) + 1;
        await client.query(
          `INSERT INTO user_items (user_id, item_key, count, first_obtained_at)
           VALUES ($1, $2, 1, NOW())
           ON CONFLICT (user_id, item_key)
           DO UPDATE SET count = user_items.count + 1`,
          [userId, resultItem.key]
        );
      }

      totalCrafts += craftCount;
      results.push({
        consumedKey: sourceItem.key,
        consumedName: sourceItem.name,
        craftCount,
        obtained: Object.entries(obtainedItems).map(([key, count]) => {
          const item = TREASURES.find(t => t.key === key);
          return { key, name: item.name, emoji: item.emoji, count };
        }),
      });
    }

    await client.query('COMMIT');

    if (totalCrafts === 0) {
      return res.json({ message: '합성 가능한 아이템이 없습니다.', totalCrafts: 0, results: [] });
    }

    res.json({ message: `총 ${totalCrafts}번 합성했습니다!`, totalCrafts, results });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ message: '서버 오류로 일괄 합성에 실패했습니다.' });
  } finally {
    client.release();
  }
});

// -------------------------------
// 도감 완성 보상 수령: POST /api/box/collection/claim-bonus
// -------------------------------
router.post('/collection/claim-bonus', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const claimResult = await client.query(
      'SELECT total_treasure, completion_bonus_claimed FROM box_claims WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (claimResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: '아직 상자를 한 번도 열지 않았습니다.' });
    }
    if (claimResult.rows[0].completion_bonus_claimed) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: '이미 완성 보상을 받으셨습니다.' });
    }

    // 한 번이라도 얻은 적 있으면 인정 (합성으로 소모돼서 지금 0개여도 상관없음)
    const itemsResult = await client.query(
      'SELECT item_key FROM user_items WHERE user_id = $1',
      [userId]
    );
    const obtainedKeys = new Set(itemsResult.rows.map(r => r.item_key));
    const isComplete = TREASURES.every(t => obtainedKeys.has(t.key));

    if (!isComplete) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: '아직 모든 아이템을 모으지 못했습니다.' });
    }

    const currentGold = parseInt(claimResult.rows[0].total_treasure, 10);
    await client.query(
      `UPDATE box_claims SET total_treasure = $1, completion_bonus_claimed = TRUE WHERE user_id = $2`,
      [currentGold + COMPLETION_BONUS_GOLD, userId]
    );

    await client.query('COMMIT');

    res.json({
      message: '도감 완성 보상을 받았습니다!',
      bonusGold: COMPLETION_BONUS_GOLD,
      totalTreasure: currentGold + COMPLETION_BONUS_GOLD,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  } finally {
    client.release();
  }
});

// -------------------------------
// 초심으로 돌아가기: POST /api/box/reset-run
// -------------------------------
// 10만 골드를 못 모았어도, 언제든 지금 판을 포기하고 처음부터 다시 시작할 수 있습니다.
// 환생과 달리 "성공한 기록"이 아니라서 rebirth_count나 기록에는 남기지 않습니다.
router.post('/reset-run', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const RESET_GOLD = 2000;

  try {
    await db.query('DELETE FROM user_items WHERE user_id = $1', [userId]);
    const now = new Date();
    await db.query(
      `UPDATE box_claims
       SET total_treasure = $1,
           completion_bonus_claimed = FALSE,
           last_income_collected_at = $2,
           run_started_at = $2,
           box_charges = 1,
           last_charge_calculated_at = $2
       WHERE user_id = $3`,
      [RESET_GOLD, now, userId]
    );

    res.json({ message: '초심으로 돌아갔습니다. 다시 도전해보세요!', totalTreasure: RESET_GOLD, runStartedAt: now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

// -------------------------------
// 환생: POST /api/box/rebirth
// -------------------------------
router.post('/rebirth', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      'SELECT total_treasure, rebirth_count, run_started_at FROM box_claims WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: '아직 게임을 시작하지 않았습니다.' });
    }

    const currentGold = parseInt(result.rows[0].total_treasure, 10);
    if (currentGold < REBIRTH_GOLD_REQUIRED) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: `10만 골드가 필요합니다. (현재 ${currentGold}G)` });
    }

    const now = new Date();
    const runStartedAt = new Date(result.rows[0].run_started_at);
    const durationMs = now - runStartedAt;
    const newRebirthNumber = result.rows[0].rebirth_count + 1;

    await client.query(
      `INSERT INTO rebirth_history (user_id, rebirth_number, duration_ms, completed_at)
       VALUES ($1, $2, $3, $4)`,
      [userId, newRebirthNumber, durationMs, now]
    );

    const RESET_GOLD = 2000;
    await client.query('DELETE FROM user_items WHERE user_id = $1', [userId]);
    await client.query(
      `UPDATE box_claims
       SET total_treasure = $1,
           completion_bonus_claimed = FALSE,
           last_income_collected_at = $2,
           rebirth_count = $3,
           run_started_at = $2,
           box_charges = 1,
           last_charge_calculated_at = $2
       WHERE user_id = $4`,
      [RESET_GOLD, now, newRebirthNumber, userId]
    );

    await client.query('COMMIT');

    res.json({
      message: `${newRebirthNumber}번째 환생을 달성했습니다! 처음부터 다시 시작합니다.`,
      rebirthNumber: newRebirthNumber,
      durationMs,
      totalTreasure: RESET_GOLD,
      runStartedAt: now,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ message: '서버 오류로 환생에 실패했습니다.' });
  } finally {
    client.release();
  }
});

// -------------------------------
// 환생 기록 조회: GET /api/box/rebirth/history
// -------------------------------
router.get('/rebirth/history', verifyToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    const historyResult = await db.query(
      'SELECT rebirth_number, duration_ms, completed_at FROM rebirth_history WHERE user_id = $1 ORDER BY rebirth_number ASC',
      [userId]
    );

    res.json({
      history: historyResult.rows.map(r => ({
        rebirthNumber: r.rebirth_number,
        durationMs: parseInt(r.duration_ms, 10),
        completedAt: r.completed_at,
      })),
      goldRequired: REBIRTH_GOLD_REQUIRED,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

// -------------------------------
// 랭킹 조회: GET /api/box/leaderboard (페이지네이션)
// -------------------------------
router.get('/leaderboard', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const pageSize = 10;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * pageSize;

  try {
    const totalResult = await db.query(
      `SELECT COUNT(*) AS total FROM (SELECT user_id FROM rebirth_history GROUP BY user_id) t`
    );
    const totalPlayers = parseInt(totalResult.rows[0].total, 10);
    const totalPages = Math.max(1, Math.ceil(totalPlayers / pageSize));

    const result = await db.query(
      `SELECT u.id AS user_id, u.nickname, MIN(rh.duration_ms) AS best_duration_ms
       FROM rebirth_history rh
       JOIN users u ON u.id = rh.user_id
       GROUP BY u.id, u.nickname
       ORDER BY best_duration_ms ASC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset]
    );

    const leaderboard = result.rows.map((row, index) => ({
      rank: offset + index + 1,
      userId: row.user_id,
      nickname: row.nickname,
      bestDurationMs: parseInt(row.best_duration_ms, 10),
      isMe: row.user_id === userId,
    }));

    // 이 페이지 안에 내가 없으면, 내 순위를 별도로 계산해서 같이 내려줌
    let myRank = leaderboard.find(r => r.isMe) || null;
    if (!myRank) {
      const myBestResult = await db.query(
        'SELECT MIN(duration_ms) AS best_duration_ms FROM rebirth_history WHERE user_id = $1',
        [userId]
      );
      const myBest = myBestResult.rows[0]?.best_duration_ms;
      if (myBest) {
        const rankResult = await db.query(
          `SELECT COUNT(*) + 1 AS rank FROM (
             SELECT user_id, MIN(duration_ms) AS best FROM rebirth_history GROUP BY user_id
           ) t WHERE t.best < $1`,
          [myBest]
        );
        myRank = {
          rank: parseInt(rankResult.rows[0].rank, 10),
          bestDurationMs: parseInt(myBest, 10),
          isMe: true,
          outsideCurrentPage: true,
        };
      }
    }

    res.json({ leaderboard, myRank, page, pageSize, totalPlayers, totalPages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;