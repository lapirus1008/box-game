// routes/box.js
// 로그인한 사용자가 1시간마다 상자를 열어 보물을 얻는 API입니다.

const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/auth');

const router = express.Router();

const COOLDOWN_MS = 15 * 1000; // 15초 (밀리초 단위)

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
  // 전설 (legendary) - 매우 희귀
  { key: 'phoenix_feather', name: '불사조의 깃털', rarity: 'legendary', emoji: '🔥', amount: 500, weight: 0.3, flavor: '전설 속에서만 존재한다던 그 깃털.' },
  { key: 'hourglass_sand',  name: '시간의 모래',   rarity: 'legendary', emoji: '⏳', amount: 600, weight: 0.2, flavor: '만지는 순간 시간이 멈춘 듯한 착각이 든다.' },
];

// 등급별 구매 가격입니다. 상자 뽑기보다는 비싸게 잡아서, "직접 사는 것"이
// 확률에 기대는 것보다 확실하지만 비용이 크다는 느낌을 주도록 했습니다.
const SHOP_PRICES = { common: 60, rare: 250, epic: 900, legendary: 3000 };

// 전설 등급 아이템 1개당, 초당 자동으로 벌어들이는 골드
const LEGENDARY_INCOME_PER_SECOND = 1;

// 마지막 정산 이후 쌓인 패시브 수입을 계산해서 골드에 더하고, 정산 시각을 갱신합니다.
// client는 이미 BEGIN된 트랜잭션의 client를 넘겨받습니다 (동시 요청에도 안전하도록).
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

  // 보유한 전설 등급 아이템 개수(중복 포함) 조회
  const legendaryKeys = TREASURES.filter(t => t.rarity === 'legendary').map(t => t.key);
  const itemsResult = await client.query(
    'SELECT COALESCE(SUM(count), 0) AS total FROM user_items WHERE user_id = $1 AND item_key = ANY($2)',
    [userId, legendaryKeys]
  );
  const legendaryCount = parseInt(itemsResult.rows[0].total, 10);

  const earned = Math.floor(elapsedSeconds * legendaryCount * LEGENDARY_INCOME_PER_SECOND);
  const newTotal = parseInt(total_treasure, 10) + earned;

  await client.query(
    'UPDATE box_claims SET total_treasure = $1, last_income_collected_at = $2 WHERE user_id = $3',
    [newTotal, now, userId]
  );

  return { earned, newTotal, legendaryCount, perSecondIncome: legendaryCount * LEGENDARY_INCOME_PER_SECOND };
}
// 15초 쿨다운을 다 스킵하면 75골드가 되도록 초당 5골드로 잡았습니다.
const INSTANT_OPEN_PRICE_PER_SECOND = 5;
const RARITY_ORDER = ['common', 'rare', 'epic', 'legendary'];
const CRAFT_COST = 3; // 같은 아이템 몇 개를 모아야 합성할 수 있는지

// 특정 등급 안에서만 weight 기반으로 랜덤하게 하나를 뽑는 함수
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
function pickRandomTreasure() {
  const totalWeight = TREASURES.reduce((sum, t) => sum + t.weight, 0);
  let rand = Math.random() * totalWeight;

  for (const treasure of TREASURES) {
    if (rand < treasure.weight) return treasure;
    rand -= treasure.weight;
  }
  return TREASURES[0]; // 혹시 모를 예외 상황 대비
}

// 아이템을 얻을 때마다 도감(user_items)에 기록/카운트 증가
async function recordItemObtained(userId, itemKey){
  await db.query(
    `INSERT INTO user_items (user_id, item_key, count, first_obtained_at)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (user_id, item_key)
     DO UPDATE SET count = user_items.count + 1`,
    [userId, itemKey]
  );
}

// -------------------------------
// 상자 열기: POST /api/box/open
// -------------------------------
router.post('/open', verifyToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    // 1. 이 사용자의 마지막 오픈 기록 조회
    const result = await db.query(
      'SELECT last_opened_at, total_treasure FROM box_claims WHERE user_id = $1',
      [userId]
    );

    const now = new Date();

    if (result.rows.length === 0) {
      // 2-A. 이 사용자가 한 번도 상자를 연 적이 없는 경우 → 아이템만 지급 + 새 기록 생성
      // (보통은 회원가입 때 이미 box_claims가 만들어지므로, 이 분기는 예전 계정을 위한 예외 처리입니다.)
      const treasure = pickRandomTreasure();

      await db.query(
        `INSERT INTO box_claims (user_id, last_opened_at, total_treasure)
         VALUES ($1, $2, $3)`,
        [userId, now, 0]
      );
      await recordItemObtained(userId, treasure.key);

      return res.json({
        message: '상자를 열었습니다!',
        treasure,
        totalTreasure: 0,
        nextAvailableAt: new Date(now.getTime() + COOLDOWN_MS),
        serverTime: now,
      });
    }

    // 2-B. 이미 기록이 있는 경우 → 1시간이 지났는지 확인
    const lastOpened = new Date(result.rows[0].last_opened_at);
    const elapsedMs = now - lastOpened;

    if (elapsedMs < COOLDOWN_MS) {
      // 아직 1시간이 지나지 않음 → 거부하고 남은 시간을 알려줌
      const remainingMs = COOLDOWN_MS - elapsedMs;
      const remainingMinutes = Math.ceil(remainingMs / 60000);

      return res.status(429).json({
        message: `아직 상자를 열 수 없습니다. ${remainingMinutes}분 후에 다시 시도해주세요.`,
        nextAvailableAt: new Date(lastOpened.getTime() + COOLDOWN_MS),
      });
    }

    // 3. 1시간이 지났으므로 아이템 지급 (골드는 더 이상 상자에서 직접 나오지 않습니다.
    //    대신 도감에서 중복 아이템을 팔아 골드로 바꾸는 방식으로 바뀌었습니다.)
    const treasure = pickRandomTreasure();
    const currentGold = parseInt(result.rows[0].total_treasure, 10);

    await db.query(
      `UPDATE box_claims SET last_opened_at = $1 WHERE user_id = $2`,
      [now, userId]
    );
    await recordItemObtained(userId, treasure.key);

    res.json({
      message: '상자를 열었습니다!',
      treasure,
      totalTreasure: currentGold,
      nextAvailableAt: new Date(now.getTime() + COOLDOWN_MS),
      serverTime: now,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 오류로 상자를 열지 못했습니다.' });
  }
});

// -------------------------------
// 상태 조회: GET /api/box/status
// -------------------------------
// 프론트엔드에서 "지금 열 수 있는지, 몇 분 남았는지"를 표시할 때 씁니다.
router.get('/status', verifyToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    // status는 정산(트랜잭션)하지 않고 조회만 합니다.
    // 실제 정산은 도감(/collection)에 들어갈 때 이루어지고,
    // 여기서는 프론트엔드가 "지금까지 얼마나 쌓였는지"를 스스로 계산할 수 있도록
    // 필요한 원재료(전설 아이템 개수, 마지막 정산 시각)만 내려줍니다.
    const result = await db.query(
      `SELECT last_opened_at, total_treasure, last_income_collected_at,
              rebirth_count, run_started_at
       FROM box_claims WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.json({ canOpen: true, totalTreasure: 0 });
    }

    const row = result.rows[0];
    const lastOpened = new Date(row.last_opened_at);
    const now = new Date();
    const elapsedMs = now - lastOpened;
    const canOpen = elapsedMs >= COOLDOWN_MS;

    const legendaryKeys = TREASURES.filter(t => t.rarity === 'legendary').map(t => t.key);
    const itemsResult = await db.query(
      'SELECT COALESCE(SUM(count), 0) AS total FROM user_items WHERE user_id = $1 AND item_key = ANY($2)',
      [userId, legendaryKeys]
    );
    const legendaryCount = parseInt(itemsResult.rows[0].total, 10);

    res.json({
      canOpen,
      totalTreasure: parseInt(row.total_treasure, 10),
      nextAvailableAt: canOpen
        ? null
        : new Date(lastOpened.getTime() + COOLDOWN_MS),
      serverTime: now,
      passiveIncomePreview: {
        legendaryCount,
        perSecondIncome: legendaryCount * LEGENDARY_INCOME_PER_SECOND,
        lastCollectedAt: row.last_income_collected_at,
      },
      rebirthCount: row.rebirth_count,
      runStartedAt: row.run_started_at,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

// -------------------------------
// 도감 조회: GET /api/box/collection
// -------------------------------
// 전체 아이템 목록과, 이 사용자가 각 아이템을 몇 개 모았는지 함께 반환합니다.
// 아직 못 모은 아이템은 count가 0으로 내려가서, 프론트엔드에서 실루엣 처리할 수 있습니다.
router.get('/collection', verifyToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    // 이제 자동으로 정산하지 않고, "받기" 버튼을 눌러야만 정산됩니다 (/api/box/collect-income).
    // 여기서는 미리보기 계산에 필요한 원자료(전설 아이템 개수, 마지막 정산 시각)만 내려줍니다.
    const result = await db.query(
      'SELECT item_key, count, first_obtained_at FROM user_items WHERE user_id = $1',
      [userId]
    );

    // key로 빠르게 찾을 수 있도록 맵으로 변환
    const obtainedMap = {};
    result.rows.forEach(row => {
      obtainedMap[row.item_key] = {
        count: row.count,
        firstObtainedAt: row.first_obtained_at,
      };
    });

    // 전체 아이템 목록에 획득 여부를 합쳐서 반환 (아직 못 모은 아이템도 목록엔 포함, count만 0)
    const collection = TREASURES.map(item => ({
      key: item.key,
      name: item.name,
      rarity: item.rarity,
      emoji: item.emoji,
      flavor: item.flavor,
      count: obtainedMap[item.key]?.count || 0,
      obtained: Boolean(obtainedMap[item.key]),
      price: SHOP_PRICES[item.rarity],
      sellPrice: item.amount, // 판매 시 받는 골드
    }));

    // 화면 상단에 보유 골드를 같이 보여주기 위해 조회
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
        perSecondIncome: legendaryCount * LEGENDARY_INCOME_PER_SECOND,
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
// 메인 화면/도감 화면의 "받기" 버튼에서 호출합니다. 실제 정산은 여기서만 일어납니다.
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
// 같은 아이템을 CRAFT_COST(3)개 모으면 소모하고, 한 등급 위의 랜덤 아이템 1개로 바꿔줍니다.
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

  // 여러 쿼리(차감 + 지급)를 하나의 트랜잭션으로 묶어서, 중간에 문제가 생기면
  // 아이템만 사라지고 보상은 못 받는 상황을 방지합니다.
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // 1. 보유 개수 확인 (다른 요청과 동시에 실행돼도 안전하도록 FOR UPDATE로 잠금)
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

    // 2. 재료 소모
    await client.query(
      'UPDATE user_items SET count = count - $1 WHERE user_id = $2 AND item_key = $3',
      [CRAFT_COST, userId, itemKey]
    );

    // 3. 다음 등급 아이템 랜덤 지급
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
// 상점 구매: POST /api/box/shop/buy
// -------------------------------
// 누적 골드(total_treasure)를 소모해서 원하는 아이템을 확정으로 얻습니다.
router.post('/shop/buy', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const { itemKey } = req.body;

  const item = TREASURES.find(t => t.key === itemKey);
  if (!item) {
    return res.status(400).json({ message: '존재하지 않는 아이템입니다.' });
  }
  const price = SHOP_PRICES[item.rarity];

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // 1. 현재 골드 확인 (동시 요청에도 안전하도록 잠금)
    const goldResult = await client.query(
      'SELECT total_treasure FROM box_claims WHERE user_id = $1 FOR UPDATE',
      [userId]
    );

    const currentGold = parseInt(goldResult.rows[0]?.total_treasure || 0, 10);
    if (currentGold < price) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `골드가 부족합니다. (필요: ${price}, 보유: ${currentGold})`,
      });
    }

    // 2. 골드 차감
    await client.query(
      'UPDATE box_claims SET total_treasure = total_treasure - $1 WHERE user_id = $2',
      [price, userId]
    );

    // 3. 아이템 지급
    await client.query(
      `INSERT INTO user_items (user_id, item_key, count, first_obtained_at)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (user_id, item_key)
       DO UPDATE SET count = user_items.count + 1`,
      [userId, item.key]
    );

    await client.query('COMMIT');

    res.json({
      message: '구매 성공!',
      item,
      pricePaid: price,
      remainingGold: currentGold - price,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ message: '서버 오류로 구매에 실패했습니다.' });
  } finally {
    client.release();
  }
});

const COMPLETION_BONUS_GOLD = 2000; // 도감을 다 채웠을 때 지급할 골드

// -------------------------------
// 도감 완성 보상 수령: POST /api/box/collection/claim-bonus
// -------------------------------
router.post('/collection/claim-bonus', verifyToken, async (req, res) => {
  const userId = req.user.userId;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // 1. 이미 받았는지, 그리고 현재 골드를 확인 (잠금)
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

    // 2. 정말로 다 모았는지 서버에서 다시 확인 (클라이언트를 신뢰하지 않음)
    const itemsResult = await client.query(
      'SELECT item_key FROM user_items WHERE user_id = $1 AND count > 0',
      [userId]
    );
    const obtainedKeys = new Set(itemsResult.rows.map(r => r.item_key));
    const isComplete = TREASURES.every(t => obtainedKeys.has(t.key));

    if (!isComplete) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: '아직 모든 아이템을 모으지 못했습니다.' });
    }

    // 3. 보상 지급 + 수령 표시
    const currentGold = parseInt(claimResult.rows[0].total_treasure, 10);
    await client.query(
      `UPDATE box_claims
       SET total_treasure = $1, completion_bonus_claimed = TRUE
       WHERE user_id = $2`,
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
// 즉시 오픈권: POST /api/box/instant-open
// -------------------------------
// 쿨다운이 남아있어도 골드를 내고 바로 상자를 엽니다. 가격은 남은 시간에 비례합니다.
// 상자 1개를 "그냥 사서" 즉시 여는 가격 (쿨다운 전체를 스킵하는 값과 동일하게 맞춤: 15초 x 초당 5골드)
const FULL_OPEN_PRICE = (COOLDOWN_MS / 1000) * INSTANT_OPEN_PRICE_PER_SECOND;
const MAX_BULK_OPEN_QUANTITY = 500; // 한 번 요청에 허용하는 최대 수량 (서버 보호용 상한선)

// -------------------------------
// 수량 지정 일괄 열기: POST /api/box/bulk-open
// -------------------------------
// 쿨다운을 신경쓰지 않고, 골드로 상자를 원하는 개수만큼 한 번에 삽니다.
// 상자 1개당 가격은 FULL_OPEN_PRICE로 고정입니다.
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

    const result = await client.query(
      'SELECT total_treasure FROM box_claims WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: '아직 게임을 시작하지 않았습니다.' });
    }

    const currentGold = parseInt(result.rows[0].total_treasure, 10);
    const totalCost = FULL_OPEN_PRICE * quantity;

    if (currentGold < totalCost) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `골드가 부족합니다. (필요: ${totalCost}, 보유: ${currentGold})`,
        maxAffordable: Math.floor(currentGold / FULL_OPEN_PRICE),
      });
    }

    // quantity번 랜덤으로 뽑되, DB에는 아이템별로 합산해서 한 번씩만 반영 (효율적으로)
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

    const now = new Date();
    const remainingGold = currentGold - totalCost;
    await client.query(
      'UPDATE box_claims SET last_opened_at = $1, total_treasure = $2 WHERE user_id = $3',
      [now, remainingGold, userId]
    );

    await client.query('COMMIT');

    const obtainedList = Object.entries(obtainedCounts).map(([key, count]) => {
      const item = TREASURES.find(t => t.key === key);
      return { key, name: item.name, emoji: item.emoji, rarity: item.rarity, count };
    });

    res.json({
      message: `상자 ${quantity}개를 열었습니다!`,
      quantity,
      totalCost,
      totalTreasure: remainingGold,
      obtained: obtainedList,
      nextAvailableAt: new Date(now.getTime() + COOLDOWN_MS),
      serverTime: now,
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
// 아이템 판매: POST /api/box/sell
// -------------------------------
// 보유한 아이템 1개를 팔아서 골드로 바꿉니다. (item.amount 값이 판매가로 쓰입니다)
router.post('/sell', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const { itemKey } = req.body;

  const item = TREASURES.find(t => t.key === itemKey);
  if (!item) {
    return res.status(400).json({ message: '존재하지 않는 아이템입니다.' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const ownedResult = await client.query(
      'SELECT count FROM user_items WHERE user_id = $1 AND item_key = $2 FOR UPDATE',
      [userId, itemKey]
    );
    const ownedCount = ownedResult.rows[0]?.count || 0;

    if (ownedCount < 1) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: '판매할 아이템이 없습니다.' });
    }

    await client.query(
      'UPDATE user_items SET count = count - 1 WHERE user_id = $1 AND item_key = $2',
      [userId, itemKey]
    );
    await client.query(
      'UPDATE box_claims SET total_treasure = total_treasure + $1 WHERE user_id = $2',
      [item.amount, userId]
    );

    await client.query('COMMIT');

    res.json({
      message: '판매 완료!',
      sold: { key: item.key, name: item.name, emoji: item.emoji },
      goldEarned: item.amount,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ message: '서버 오류로 판매에 실패했습니다.' });
  } finally {
    client.release();
  }
});

const REBIRTH_GOLD_REQUIRED = 100000;

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
           last_opened_at = $2,
           last_income_collected_at = $3,
           run_started_at = $3
       WHERE user_id = $4`,
      [RESET_GOLD, new Date(0), now, userId]
    );

    res.json({
      message: '초심으로 돌아갔습니다. 다시 도전해보세요!',
      totalTreasure: RESET_GOLD,
      runStartedAt: now,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

// -------------------------------
// 환생: POST /api/box/rebirth
// -------------------------------
// 10만 골드를 모으면 "환생석"을 써서 이번 판을 기록으로 남기고 다시 시작합니다.
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
      return res.status(400).json({
        message: `10만 골드가 필요합니다. (현재 ${currentGold}G)`,
      });
    }

    const now = new Date();
    const runStartedAt = new Date(result.rows[0].run_started_at);
    const durationMs = now - runStartedAt;
    const newRebirthNumber = result.rows[0].rebirth_count + 1;

    // 이번 판 기록 남기기
    await client.query(
      `INSERT INTO rebirth_history (user_id, rebirth_number, duration_ms, completed_at)
       VALUES ($1, $2, $3, $4)`,
      [userId, newRebirthNumber, durationMs, now]
    );

    // 환생: 완전히 처음부터 다시 시작 (아이템 전부 삭제, 골드는 초기값으로, 쿨다운도 즉시 열 수 있게 초기화)
    const RESET_GOLD = 2000; // 회원가입 때와 동일한 시작 골드
    await client.query('DELETE FROM user_items WHERE user_id = $1', [userId]);
    await client.query(
      `UPDATE box_claims
       SET total_treasure = $1,
           completion_bonus_claimed = FALSE,
           last_opened_at = $2,
           last_income_collected_at = $3,
           rebirth_count = $4,
           run_started_at = $3
       WHERE user_id = $5`,
      [RESET_GOLD, new Date(0), now, newRebirthNumber, userId]
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
// 일괄 합성: POST /api/box/craft-all
// -------------------------------
// 3개 이상 모인 아이템을 전부 찾아서, 가능한 만큼 반복적으로 합성합니다.
// (예: 어떤 아이템이 7개 있으면 2번 합성하고 1개가 남습니다)
router.post('/craft-all', verifyToken, async (req, res) => {
  const userId = req.user.userId;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const ownedResult = await client.query(
      'SELECT item_key, count FROM user_items WHERE user_id = $1 AND count >= $2 FOR UPDATE',
      [userId, CRAFT_COST]
    );

    const results = []; // 어떤 아이템을 몇 번 합성해서 뭘 얻었는지 기록
    let totalCrafts = 0;

    for (const row of ownedResult.rows) {
      const sourceItem = TREASURES.find(t => t.key === row.item_key);
      if (!sourceItem) continue;

      const rarityIndex = RARITY_ORDER.indexOf(sourceItem.rarity);
      if (rarityIndex === RARITY_ORDER.length - 1) continue; // 이미 최고 등급이면 스킵

      const nextRarity = RARITY_ORDER[rarityIndex + 1];
      const craftCount = Math.floor(row.count / CRAFT_COST); // 몇 번 합성 가능한지
      if (craftCount === 0) continue;

      // 재료 한 번에 소모
      await client.query(
        'UPDATE user_items SET count = count - $1 WHERE user_id = $2 AND item_key = $3',
        [craftCount * CRAFT_COST, userId, row.item_key]
      );

      // 합성 횟수만큼 반복해서 결과 아이템 지급 (매번 랜덤이라 한 번씩 뽑아야 함)
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

    res.json({
      message: `총 ${totalCrafts}번 합성했습니다!`,
      totalCrafts,
      results,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ message: '서버 오류로 일괄 합성에 실패했습니다.' });
  } finally {
    client.release();
  }
});

// -------------------------------
// 랭킹 조회: GET /api/box/leaderboard
// -------------------------------
// 모든 유저의 "가장 빨랐던 환생 기록"을 뽑아서 순위를 매깁니다.
router.get('/leaderboard', verifyToken, async (req, res) => {
  const userId = req.user.userId;

  try {
    const result = await db.query(
      `SELECT u.id AS user_id, u.nickname, MIN(rh.duration_ms) AS best_duration_ms
       FROM rebirth_history rh
       JOIN users u ON u.id = rh.user_id
       GROUP BY u.id, u.nickname
       ORDER BY best_duration_ms ASC
       LIMIT 20`
    );

    const leaderboard = result.rows.map((row, index) => ({
      rank: index + 1,
      userId: row.user_id,
      nickname: row.nickname,
      bestDurationMs: parseInt(row.best_duration_ms, 10),
      isMe: row.user_id === userId,
    }));

    // 내가 top 20 밖이면, 내 순위를 별도로 계산해서 같이 내려줌
    let myRank = leaderboard.find(r => r.isMe) || null;
    if (!myRank) {
      const myBestResult = await db.query(
        `SELECT MIN(duration_ms) AS best_duration_ms FROM rebirth_history WHERE user_id = $1`,
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
          outsideTop20: true,
        };
      }
    }

    res.json({ leaderboard, myRank });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;