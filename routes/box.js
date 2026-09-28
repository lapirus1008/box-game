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
const MYTHIC_INCOME_PER_SECOND = 5;    // 신화 아이템 1개당 추가되는 초당 골드 (훨씬 희귀해서 더 많이 줌)
const RARITY_ORDER = ['common', 'rare', 'epic', 'legendary', 'mythic'];
// 합성으로 올라갈 수 있는 등급은 일반→희귀→영웅→전설까지입니다.
// 신화는 합성으로 절대 얻을 수 없고, 오직 상자에서만 나옵니다. (전설은 더 이상 합성 재료가 될 수 없음)
const CRAFTABLE_RARITIES = ['common', 'rare', 'epic'];
const CRAFT_COST = 3;                 // 합성에 필요한 같은 아이템 개수
const COMPLETION_BONUS_GOLD = 2000;   // 도감 완성 보상
const REBIRTH_GOLD_REQUIRED = 100000; // 환생에 필요한 골드 (기록모드 전용)
const MAX_BULK_OPEN_QUANTITY = MAX_BOX_CHARGES; // 한 번에 열 수 있는 최대 개수 (충전 최대치와 동일)
const GOLD_PER_BOX_PURCHASE = 75; // 충전과 별개로, 골드를 내고 상자를 즉시 구매할 때의 개당 가격
const MAX_GOLD_BOX_PURCHASE = 2000;
const RESET_GOLD = 2000; // 초심으로 돌아가기 / 새 세이브 시작 골드

// 신화 천장(피티): 마지막 신화 이후 이만큼 상자를 열면 그 상자는 신화가 100% 확정입니다.
// 신화 자연 확률은 전체 가중치 대비 약 1/5,400 입니다. 3,000개는 자연 확률만으로
// 이 안에 신화를 얻을 확률이 약 42%인 지점이라, "운이 없어도 하루 이틀 열심히 하면 반드시 본다"는
// 느낌을 주면서도 신화의 희소성은 유지합니다. (충전+골드 구매를 병행하면 대략 10시간 안팎)
const MYTHIC_PITY_LIMIT = 3000;

const VALID_MODES = ['record', 'collection'];
const DEFAULT_MODE = 'record';

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
  // 신화 (mythic) - 극악의 확률, 전설보다도 훨씬 희귀하고 훨씬 많은 초당 골드를 줍니다
  { key: 'astral_compass', name: '천체의 나침반', rarity: 'mythic', emoji: '🧭', amount: 5000, weight: 0.02, flavor: '전설조차 가리키지 못하는 곳을 가리킨다는, 전해지기만 하던 나침반.' },
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

// 상자 하나를 뽑되, 천장 카운터를 반영합니다.
// pity = 지금까지 신화 없이 연 상자 수. 이번이 천장 번째 상자면 신화 확정.
function rollWithPity(pity) {
  if (pity + 1 >= MYTHIC_PITY_LIMIT) {
    return { treasure: pickRandomFromRarity('mythic'), pity: 0, guaranteed: true };
  }
  const treasure = pickRandomTreasure();
  return { treasure, pity: treasure.rarity === 'mythic' ? 0 : pity + 1, guaranteed: false };
}

// 이 요청 시점에 유저가 어떤 모드(기록/수집)를 쓰고 있는지 확인합니다.
// client가 주어지면 그 트랜잭션 커넥션으로, 아니면 그냥 db.query로 조회합니다.
async function getActiveMode(userId, client) {
  const runner = client || db;
  const result = await runner.query('SELECT active_mode FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.active_mode || DEFAULT_MODE;
}

// 충전 개수를 최신 상태로 계산해서 필요하면 DB에 반영합니다.
// client는 이미 BEGIN된 트랜잭션의 client여야 합니다 (동시 요청 안전성을 위해 FOR UPDATE 사용).
async function syncBoxCharges(client, userId, mode) {
  const result = await client.query(
    'SELECT box_charges, last_charge_calculated_at FROM box_claims WHERE user_id = $1 AND mode = $2 FOR UPDATE',
    [userId, mode]
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
    newLastCalc = newCharges >= MAX_BOX_CHARGES ? now : new Date(lastCalc.getTime() + gained * CHARGE_INTERVAL_MS);

    await client.query(
      'UPDATE box_claims SET box_charges = $1, last_charge_calculated_at = $2 WHERE user_id = $3 AND mode = $4',
      [newCharges, newLastCalc, userId, mode]
    );
  }

  const nextChargeInMs = newCharges >= MAX_BOX_CHARGES ? null : CHARGE_INTERVAL_MS - (now - newLastCalc);

  return { charges: newCharges, maxCharges: MAX_BOX_CHARGES, nextChargeInMs, serverTime: now };
}

// 마지막 정산 이후 쌓인 패시브 골드(기본 + 전설 아이템 보너스)를 계산해서 반영합니다.
async function collectPassiveIncome(client, userId, mode) {
  const claimResult = await client.query(
    'SELECT total_treasure, last_income_collected_at FROM box_claims WHERE user_id = $1 AND mode = $2 FOR UPDATE',
    [userId, mode]
  );
  if (claimResult.rows.length === 0) return null;

  const { total_treasure, last_income_collected_at } = claimResult.rows[0];
  const now = new Date();
  const lastCollected = new Date(last_income_collected_at);
  const elapsedSeconds = (now - lastCollected) / 1000;

  const legendaryKeys = TREASURES.filter(t => t.rarity === 'legendary').map(t => t.key);
  const mythicKeys = TREASURES.filter(t => t.rarity === 'mythic').map(t => t.key);

  const legendaryResult = await client.query(
    'SELECT COALESCE(SUM(count), 0) AS total FROM user_items WHERE user_id = $1 AND mode = $2 AND item_key = ANY($3)',
    [userId, mode, legendaryKeys]
  );
  const mythicResult = await client.query(
    'SELECT COALESCE(SUM(count), 0) AS total FROM user_items WHERE user_id = $1 AND mode = $2 AND item_key = ANY($3)',
    [userId, mode, mythicKeys]
  );
  const legendaryCount = parseInt(legendaryResult.rows[0].total, 10);
  const mythicCount = parseInt(mythicResult.rows[0].total, 10);
  const perSecondIncome = BASE_INCOME_PER_SECOND
    + legendaryCount * LEGENDARY_INCOME_PER_SECOND
    + mythicCount * MYTHIC_INCOME_PER_SECOND;

  const earned = Math.floor(elapsedSeconds * perSecondIncome);
  const newTotal = parseInt(total_treasure, 10) + earned;

  await client.query(
    'UPDATE box_claims SET total_treasure = $1, last_income_collected_at = $2 WHERE user_id = $3 AND mode = $4',
    [newTotal, now, userId, mode]
  );

  return {
    earned,
    newTotal,
    legendaryCount,
    mythicCount,
    baseIncome: BASE_INCOME_PER_SECOND,
    legendaryIncome: legendaryCount * LEGENDARY_INCOME_PER_SECOND,
    mythicIncome: mythicCount * MYTHIC_INCOME_PER_SECOND,
    perSecondIncome,
  };
}

// 아이템을 하나 "발견했다"는 사실을 기록합니다.
// - 기록모드: 이번 판 한정 기록이라, 환생/초심으로 돌아가면 지워집니다.
// - 수집모드: 절대 지워지지 않는 영구 기록입니다.
// 같은 아이템을 또 발견해도 딱 한 번만 기록됩니다 (최초 발견일만 남김).
async function recordDiscovery(client, userId, mode, itemKey) {
  await client.query(
    `INSERT INTO user_discoveries (user_id, mode, item_key, first_discovered_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, mode, item_key) DO NOTHING`,
    [userId, mode, itemKey]
  );
}

// 아이템을 얻을 때마다 "보유 개수"(user_items)에 반영 + 발견 기록도 함께 남김 (모두 현재 모드 기준)
async function recordItemObtained(client, userId, mode, itemKey) {
  await client.query(
    `INSERT INTO user_items (user_id, mode, item_key, count, first_obtained_at)
     VALUES ($1, $2, $3, 1, NOW())
     ON CONFLICT (user_id, mode, item_key)
     DO UPDATE SET count = user_items.count + 1`,
    [userId, mode, itemKey]
  );
  await recordDiscovery(client, userId, mode, itemKey);
}

// -------------------------------
// 모드 조회 / 전환: GET, POST /api/box/mode
// -------------------------------
router.get('/mode', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  try {
    const mode = await getActiveMode(userId);
    res.json({ mode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

router.post('/mode', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const { mode } = req.body;

  if (!VALID_MODES.includes(mode)) {
    return res.status(400).json({ message: '올바르지 않은 모드입니다.' });
  }

  try {
    await db.query('UPDATE users SET active_mode = $1 WHERE id = $2', [mode, userId]);
    res.json({
      message: mode === 'record' ? '기록모드로 전환했습니다.' : '수집모드로 전환했습니다.',
      mode,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 오류로 모드를 전환하지 못했습니다.' });
  }
});

// -------------------------------
// 상자 열기: POST /api/box/open (충전 1개 소모)
// -------------------------------
router.post('/open', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const client = await db.getClient();

  try {
    await client.query('BEGIN');
    const mode = await getActiveMode(userId, client);

    const chargeInfo = await syncBoxCharges(client, userId, mode);
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

    const pityRow = await client.query('SELECT mythic_pity FROM box_claims WHERE user_id = $1 AND mode = $2', [userId, mode]);
    const roll = rollWithPity(pityRow.rows[0].mythic_pity);
    const treasure = roll.treasure;

    await client.query(
      'UPDATE box_claims SET box_charges = box_charges - 1, mythic_pity = $3 WHERE user_id = $1 AND mode = $2',
      [userId, mode, roll.pity]
    );
    await recordItemObtained(client, userId, mode, treasure.key);

    const goldResult = await client.query('SELECT total_treasure FROM box_claims WHERE user_id = $1 AND mode = $2', [userId, mode]);

    await client.query('COMMIT');

    res.json({
      message: '상자를 열었습니다!',
      mode,
      treasure,
      mythicPity: roll.pity,
      mythicPityLimit: MYTHIC_PITY_LIMIT,
      mythicPityTriggered: roll.guaranteed,
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
    const mode = await getActiveMode(userId, client);

    const chargeInfo = await syncBoxCharges(client, userId, mode);
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

    const pityRow = await client.query('SELECT mythic_pity FROM box_claims WHERE user_id = $1 AND mode = $2', [userId, mode]);
    let pity = pityRow.rows[0].mythic_pity;
    let pityTriggered = false;

    const obtainedCounts = {};
    for (let i = 0; i < quantity; i++) {
      const roll = rollWithPity(pity);
      pity = roll.pity;
      if (roll.guaranteed) pityTriggered = true;
      obtainedCounts[roll.treasure.key] = (obtainedCounts[roll.treasure.key] || 0) + 1;
    }

    await client.query(
      'UPDATE box_claims SET box_charges = box_charges - $1, mythic_pity = $4 WHERE user_id = $2 AND mode = $3',
      [quantity, userId, mode, pity]
    );

    for (const [itemKey, count] of Object.entries(obtainedCounts)) {
      await client.query(
        `INSERT INTO user_items (user_id, mode, item_key, count, first_obtained_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id, mode, item_key)
         DO UPDATE SET count = user_items.count + $4`,
        [userId, mode, itemKey, count]
      );
      await recordDiscovery(client, userId, mode, itemKey);
    }

    const goldResult = await client.query('SELECT total_treasure FROM box_claims WHERE user_id = $1 AND mode = $2', [userId, mode]);

    await client.query('COMMIT');

    const obtainedList = Object.entries(obtainedCounts).map(([key, count]) => {
      const item = TREASURES.find(t => t.key === key);
      return { key, name: item.name, emoji: item.emoji, rarity: item.rarity, flavor: item.flavor, count };
    });

    res.json({
      message: `상자 ${quantity}개를 열었습니다!`,
      mode,
      quantity,
      mythicPity: pity,
      mythicPityLimit: MYTHIC_PITY_LIMIT,
      mythicPityTriggered: pityTriggered,
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
    const mode = await getActiveMode(userId, client);

    const result = await client.query(
      'SELECT total_treasure, mythic_pity FROM box_claims WHERE user_id = $1 AND mode = $2 FOR UPDATE',
      [userId, mode]
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

    let pity = result.rows[0].mythic_pity;
    let pityTriggered = false;

    const obtainedCounts = {};
    for (let i = 0; i < quantity; i++) {
      const roll = rollWithPity(pity);
      pity = roll.pity;
      if (roll.guaranteed) pityTriggered = true;
      obtainedCounts[roll.treasure.key] = (obtainedCounts[roll.treasure.key] || 0) + 1;
    }

    for (const [itemKey, count] of Object.entries(obtainedCounts)) {
      await client.query(
        `INSERT INTO user_items (user_id, mode, item_key, count, first_obtained_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id, mode, item_key)
         DO UPDATE SET count = user_items.count + $4`,
        [userId, mode, itemKey, count]
      );
      await recordDiscovery(client, userId, mode, itemKey);
    }

    const remainingGold = currentGold - totalCost;
    await client.query('UPDATE box_claims SET total_treasure = $1, mythic_pity = $4 WHERE user_id = $2 AND mode = $3', [remainingGold, userId, mode, pity]);

    await client.query('COMMIT');

    const obtainedList = Object.entries(obtainedCounts).map(([key, count]) => {
      const item = TREASURES.find(t => t.key === key);
      return { key, name: item.name, emoji: item.emoji, rarity: item.rarity, flavor: item.flavor, count };
    });

    res.json({
      message: `골드로 상자 ${quantity}개를 구매해서 열었습니다!`,
      mode,
      quantity,
      totalCost,
      mythicPity: pity,
      mythicPityLimit: MYTHIC_PITY_LIMIT,
      mythicPityTriggered: pityTriggered,
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
    const mode = await getActiveMode(userId, client);

    const chargeInfo = await syncBoxCharges(client, userId, mode);
    if (!chargeInfo) {
      await client.query('COMMIT');
      return res.json({ mode, isRecordMode: mode === 'record', charges: 0, maxCharges: MAX_BOX_CHARGES, totalTreasure: 0 });
    }

    const row = await client.query(
      `SELECT total_treasure, last_income_collected_at, rebirth_count, run_started_at, mythic_pity, completion_bonus_claimed
       FROM box_claims WHERE user_id = $1 AND mode = $2`,
      [userId, mode]
    );

    const legendaryKeys = TREASURES.filter(t => t.rarity === 'legendary').map(t => t.key);
    const mythicKeys = TREASURES.filter(t => t.rarity === 'mythic').map(t => t.key);
    const legendaryResult = await client.query(
      'SELECT COALESCE(SUM(count), 0) AS total FROM user_items WHERE user_id = $1 AND mode = $2 AND item_key = ANY($3)',
      [userId, mode, legendaryKeys]
    );
    const mythicResult = await client.query(
      'SELECT COALESCE(SUM(count), 0) AS total FROM user_items WHERE user_id = $1 AND mode = $2 AND item_key = ANY($3)',
      [userId, mode, mythicKeys]
    );
    const legendaryCount = parseInt(legendaryResult.rows[0].total, 10);
    const mythicCount = parseInt(mythicResult.rows[0].total, 10);
    const perSecondIncome = BASE_INCOME_PER_SECOND
      + legendaryCount * LEGENDARY_INCOME_PER_SECOND
      + mythicCount * MYTHIC_INCOME_PER_SECOND;

    // 도감을 다 채웠는지 (메인 화면의 "도감 완료" 버튼 표시용)
    const discoveredResult = await client.query(
      'SELECT COUNT(*) AS total FROM user_discoveries WHERE user_id = $1 AND mode = $2',
      [userId, mode]
    );
    const collectionComplete = parseInt(discoveredResult.rows[0].total, 10) >= TREASURES.length;

    await client.query('COMMIT');

    res.json({
      mode,
      isRecordMode: mode === 'record',
      collectionComplete,
      bonusClaimed: row.rows[0].completion_bonus_claimed,
      charges: chargeInfo.charges,
      maxCharges: chargeInfo.maxCharges,
      nextChargeInMs: chargeInfo.nextChargeInMs,
      totalTreasure: parseInt(row.rows[0].total_treasure, 10),
      mythicPity: row.rows[0].mythic_pity,
      mythicPityLimit: MYTHIC_PITY_LIMIT,
      serverTime: chargeInfo.serverTime,
      passiveIncomePreview: {
        legendaryCount,
        mythicCount,
        baseIncome: BASE_INCOME_PER_SECOND,
        legendaryIncome: legendaryCount * LEGENDARY_INCOME_PER_SECOND,
        mythicIncome: mythicCount * MYTHIC_INCOME_PER_SECOND,
        perSecondIncome,
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
// 패시브 골드 받기: POST /api/box/collect-income
// -------------------------------
router.post('/collect-income', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const client = await db.getClient();

  try {
    await client.query('BEGIN');
    const mode = await getActiveMode(userId, client);
    const income = await collectPassiveIncome(client, userId, mode);
    await client.query('COMMIT');

    if (!income) {
      return res.status(400).json({ message: '아직 게임을 시작하지 않았습니다.' });
    }

    res.json({
      message: income.earned > 0 ? `${income.earned}G를 받았습니다!` : '아직 쌓인 골드가 없습니다.',
      mode,
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

  if (!CRAFTABLE_RARITIES.includes(sourceItem.rarity)) {
    return res.status(400).json({
      message: sourceItem.rarity === 'legendary'
        ? '신화 아이템은 합성으로 얻을 수 없어요. 오직 상자에서만 나옵니다!'
        : '이미 최고 등급이라 더 합성할 수 없습니다.',
    });
  }
  const rarityIndex = RARITY_ORDER.indexOf(sourceItem.rarity);
  const nextRarity = RARITY_ORDER[rarityIndex + 1];

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const mode = await getActiveMode(userId, client);

    const ownedResult = await client.query(
      'SELECT count FROM user_items WHERE user_id = $1 AND mode = $2 AND item_key = $3 FOR UPDATE',
      [userId, mode, itemKey]
    );
    const ownedCount = ownedResult.rows[0]?.count || 0;
    if (ownedCount < CRAFT_COST) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `합성하려면 ${sourceItem.name}이(가) ${CRAFT_COST}개 필요합니다. (현재 ${ownedCount}개)`,
      });
    }

    await client.query(
      'UPDATE user_items SET count = count - $1 WHERE user_id = $2 AND mode = $3 AND item_key = $4',
      [CRAFT_COST, userId, mode, itemKey]
    );

    const resultItem = pickRandomFromRarity(nextRarity);
    await client.query(
      `INSERT INTO user_items (user_id, mode, item_key, count, first_obtained_at)
       VALUES ($1, $2, $3, 1, NOW())
       ON CONFLICT (user_id, mode, item_key)
       DO UPDATE SET count = user_items.count + 1`,
      [userId, mode, resultItem.key]
    );
    await recordDiscovery(client, userId, mode, resultItem.key);

    await client.query('COMMIT');

    res.json({
      message: '합성 성공!',
      mode,
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
    const mode = await getActiveMode(userId, client);

    const ownedResult = await client.query(
      'SELECT item_key, count FROM user_items WHERE user_id = $1 AND mode = $2 AND count >= $3 FOR UPDATE',
      [userId, mode, CRAFT_COST]
    );

    const results = [];
    let totalCrafts = 0;

    for (const row of ownedResult.rows) {
      const sourceItem = TREASURES.find(t => t.key === row.item_key);
      if (!sourceItem) continue;

      if (!CRAFTABLE_RARITIES.includes(sourceItem.rarity)) continue; // 전설/신화는 합성 불가

      const rarityIndex = RARITY_ORDER.indexOf(sourceItem.rarity);

      const nextRarity = RARITY_ORDER[rarityIndex + 1];
      const craftCount = Math.floor(row.count / CRAFT_COST);
      if (craftCount === 0) continue;

      await client.query(
        'UPDATE user_items SET count = count - $1 WHERE user_id = $2 AND mode = $3 AND item_key = $4',
        [craftCount * CRAFT_COST, userId, mode, row.item_key]
      );

      const obtainedItems = {};
      for (let i = 0; i < craftCount; i++) {
        const resultItem = pickRandomFromRarity(nextRarity);
        obtainedItems[resultItem.key] = (obtainedItems[resultItem.key] || 0) + 1;
      }

      for (const [obtainedKey, obtainedQty] of Object.entries(obtainedItems)) {
        await client.query(
          `INSERT INTO user_items (user_id, mode, item_key, count, first_obtained_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (user_id, mode, item_key)
           DO UPDATE SET count = user_items.count + $4`,
          [userId, mode, obtainedKey, obtainedQty]
        );
        await recordDiscovery(client, userId, mode, obtainedKey);
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
      return res.json({ message: '합성 가능한 아이템이 없습니다.', mode, totalCrafts: 0, results: [] });
    }

    res.json({ message: `총 ${totalCrafts}번 합성했습니다!`, mode, totalCrafts, results });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ message: '서버 오류로 일괄 합성에 실패했습니다.' });
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
    const mode = await getActiveMode(userId);

    // 발견 기록: 기록모드에선 "이번 판" 한정, 수집모드에선 영구
    const discoveryResult = await db.query(
      'SELECT item_key, first_discovered_at FROM user_discoveries WHERE user_id = $1 AND mode = $2',
      [userId, mode]
    );
    const discoveryMap = {};
    discoveryResult.rows.forEach(row => {
      discoveryMap[row.item_key] = row.first_discovered_at;
    });

    // 보유 개수 (현재 모드 기준)
    const itemsResult = await db.query(
      'SELECT item_key, count FROM user_items WHERE user_id = $1 AND mode = $2',
      [userId, mode]
    );
    const countMap = {};
    itemsResult.rows.forEach(row => { countMap[row.item_key] = row.count; });

    const collection = TREASURES.map(item => ({
      key: item.key,
      name: item.name,
      rarity: item.rarity,
      emoji: item.emoji,
      flavor: item.flavor,
      count: countMap[item.key] || 0,
      obtained: Boolean(discoveryMap[item.key]),
      firstDiscoveredAt: discoveryMap[item.key] || null,
    }));

    const treasureResult = await db.query(
      'SELECT total_treasure, completion_bonus_claimed, last_income_collected_at FROM box_claims WHERE user_id = $1 AND mode = $2',
      [userId, mode]
    );
    const totalTreasure = parseInt(treasureResult.rows[0]?.total_treasure || 0, 10);
    const bonusClaimed = treasureResult.rows[0]?.completion_bonus_claimed || false;

    const obtainedCount = collection.filter(item => item.obtained).length;
    const isComplete = obtainedCount === TREASURES.length;

    const legendaryKeys = TREASURES.filter(t => t.rarity === 'legendary').map(t => t.key);
    const mythicKeys = TREASURES.filter(t => t.rarity === 'mythic').map(t => t.key);
    const legendaryCount = collection.filter(i => legendaryKeys.includes(i.key)).reduce((s, i) => s + i.count, 0);
    const mythicCount = collection.filter(i => mythicKeys.includes(i.key)).reduce((s, i) => s + i.count, 0);
    const perSecondIncome = BASE_INCOME_PER_SECOND
      + legendaryCount * LEGENDARY_INCOME_PER_SECOND
      + mythicCount * MYTHIC_INCOME_PER_SECOND;

    res.json({
      mode,
      isRecordMode: mode === 'record',
      collection,
      totalTreasure,
      progress: { obtained: obtainedCount, total: TREASURES.length },
      isComplete,
      bonusClaimed,
      passiveIncomePreview: {
        legendaryCount,
        mythicCount,
        baseIncome: BASE_INCOME_PER_SECOND,
        legendaryIncome: legendaryCount * LEGENDARY_INCOME_PER_SECOND,
        mythicIncome: mythicCount * MYTHIC_INCOME_PER_SECOND,
        perSecondIncome,
        lastCollectedAt: treasureResult.rows[0]?.last_income_collected_at,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
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
    const mode = await getActiveMode(userId, client);

    const claimResult = await client.query(
      'SELECT total_treasure, completion_bonus_claimed FROM box_claims WHERE user_id = $1 AND mode = $2 FOR UPDATE',
      [userId, mode]
    );
    if (claimResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: '아직 상자를 한 번도 열지 않았습니다.' });
    }
    if (claimResult.rows[0].completion_bonus_claimed) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: '이미 완성 보상을 받으셨습니다.' });
    }

    const itemsResult = await client.query(
      'SELECT item_key FROM user_discoveries WHERE user_id = $1 AND mode = $2',
      [userId, mode]
    );
    const obtainedKeys = new Set(itemsResult.rows.map(r => r.item_key));
    const isComplete = TREASURES.every(t => obtainedKeys.has(t.key));

    if (!isComplete) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: '아직 모든 아이템을 모으지 못했습니다.' });
    }

    const currentGold = parseInt(claimResult.rows[0].total_treasure, 10);
    await client.query(
      `UPDATE box_claims SET total_treasure = $1, completion_bonus_claimed = TRUE WHERE user_id = $2 AND mode = $3`,
      [currentGold + COMPLETION_BONUS_GOLD, userId, mode]
    );

    await client.query('COMMIT');

    res.json({
      message: '도감 완성 보상을 받았습니다!',
      mode,
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
// 언제든 지금 세이브(현재 모드)를 포기하고 처음부터 다시 시작할 수 있습니다.
// - 기록모드: 골드·아이템·도감을 전부 초기화합니다 ("이번 판" 자체를 새로 시작하는 것이므로).
// - 수집모드: 골드·아이템만 초기화되고, 도감(영구 발견기록)은 절대 지워지지 않습니다.
// 환생과 달리 "성공한 기록"이 아니라서 rebirth_count나 랭킹에는 남지 않습니다.
router.post('/reset-run', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const client = await db.getClient();

  try {
    await client.query('BEGIN');
    const mode = await getActiveMode(userId, client);

    await client.query('DELETE FROM user_items WHERE user_id = $1 AND mode = $2', [userId, mode]);
    if (mode === 'record') {
      // 기록모드는 도감도 "이번 판" 한정이라 같이 초기화합니다.
      await client.query('DELETE FROM user_discoveries WHERE user_id = $1 AND mode = $2', [userId, mode]);
    }

    const now = new Date();
    await client.query(
      `UPDATE box_claims
       SET total_treasure = $1,
           completion_bonus_claimed = FALSE,
           last_income_collected_at = $2,
           run_started_at = $2,
           box_charges = 1,
           last_charge_calculated_at = $2,
           mythic_pity = CASE WHEN mode = 'record' THEN 0 ELSE mythic_pity END
       WHERE user_id = $3 AND mode = $4`,
      [RESET_GOLD, now, userId, mode]
    );

    await client.query('COMMIT');

    res.json({
      message: mode === 'record'
        ? '초심으로 돌아갔습니다. 도감도 함께 초기화됐어요. 다시 도전해보세요!'
        : '초심으로 돌아갔습니다. 도감은 그대로 남아있어요. 다시 모아보세요!',
      mode,
      totalTreasure: RESET_GOLD,
      runStartedAt: now,
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
// 환생: POST /api/box/rebirth (기록모드 전용)
// -------------------------------
router.post('/rebirth', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const client = await db.getClient();

  try {
    await client.query('BEGIN');
    const mode = await getActiveMode(userId, client);

    if (mode !== 'record') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: '수집모드에서는 환생할 수 없습니다. 기록모드로 전환해주세요.' });
    }

    const result = await client.query(
      'SELECT total_treasure, rebirth_count, run_started_at FROM box_claims WHERE user_id = $1 AND mode = $2 FOR UPDATE',
      [userId, mode]
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
      `INSERT INTO rebirth_history (user_id, mode, rebirth_number, duration_ms, completed_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, mode, newRebirthNumber, durationMs, now]
    );

    // 환생은 "이번 판"을 완전히 새로 시작하는 것이므로, 보유 아이템뿐 아니라
    // 도감(발견기록)도 함께 초기화합니다.
    await client.query('DELETE FROM user_items WHERE user_id = $1 AND mode = $2', [userId, mode]);
    await client.query('DELETE FROM user_discoveries WHERE user_id = $1 AND mode = $2', [userId, mode]);
    await client.query(
      `UPDATE box_claims
       SET total_treasure = $1,
           completion_bonus_claimed = FALSE,
           last_income_collected_at = $2,
           rebirth_count = $3,
           run_started_at = $2,
           box_charges = 1,
           last_charge_calculated_at = $2,
           mythic_pity = 0
       WHERE user_id = $4 AND mode = $5`,
      [RESET_GOLD, now, newRebirthNumber, userId, mode]
    );

    await client.query('COMMIT');

    res.json({
      message: `${newRebirthNumber}번째 환생을 달성했습니다! 처음부터 다시 시작합니다.`,
      mode,
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
// 환생 기록 조회: GET /api/box/rebirth/history (기록모드 전용 개념)
// -------------------------------
router.get('/rebirth/history', verifyToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    const historyResult = await db.query(
      `SELECT rebirth_number, duration_ms, completed_at FROM rebirth_history
       WHERE user_id = $1 AND mode = 'record' ORDER BY rebirth_number ASC`,
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
// 랭킹 조회: GET /api/box/leaderboard (페이지네이션, 기록모드 전용)
// -------------------------------
router.get('/leaderboard', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const pageSize = 10;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * pageSize;

  try {
    const totalResult = await db.query(
      `SELECT COUNT(*) AS total FROM (
         SELECT user_id FROM rebirth_history WHERE mode = 'record' GROUP BY user_id
       ) t`
    );
    const totalPlayers = parseInt(totalResult.rows[0].total, 10);
    const totalPages = Math.max(1, Math.ceil(totalPlayers / pageSize));

    const result = await db.query(
      `SELECT u.id AS user_id, u.nickname, MIN(rh.duration_ms) AS best_duration_ms
       FROM rebirth_history rh
       JOIN users u ON u.id = rh.user_id
       WHERE rh.mode = 'record'
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

    let myRank = leaderboard.find(r => r.isMe) || null;
    if (!myRank) {
      const myBestResult = await db.query(
        `SELECT MIN(duration_ms) AS best_duration_ms FROM rebirth_history WHERE user_id = $1 AND mode = 'record'`,
        [userId]
      );
      const myBest = myBestResult.rows[0]?.best_duration_ms;
      if (myBest) {
        const rankResult = await db.query(
          `SELECT COUNT(*) + 1 AS rank FROM (
             SELECT user_id, MIN(duration_ms) AS best FROM rebirth_history WHERE mode = 'record' GROUP BY user_id
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