// routes/box.js
// 로그인한 사용자가 1시간마다 상자를 열어 보물을 얻는 API입니다.

const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/auth');

const router = express.Router();

const COOLDOWN_MS = 60 * 60 * 1000; // 1시간 (밀리초 단위)

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

// 등급이 오르는 순서. 합성할 때 "다음 등급이 뭔지" 여기서 찾습니다.
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
      // 2-A. 이 사용자가 한 번도 상자를 연 적이 없는 경우 → 바로 지급 + 새 기록 생성
      const treasure = pickRandomTreasure();

      await db.query(
        `INSERT INTO box_claims (user_id, last_opened_at, total_treasure)
         VALUES ($1, $2, $3)`,
        [userId, now, treasure.amount]
      );
      await recordItemObtained(userId, treasure.key);

      return res.json({
        message: '상자를 열었습니다!',
        treasure,
        totalTreasure: treasure.amount,
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

    // 3. 1시간이 지났으므로 보물 지급 + 기록 갱신
    const treasure = pickRandomTreasure();
    // pg는 NUMERIC/BIGINT 값을 문자열로 반환하므로, 반드시 숫자로 변환한 뒤 더해야 합니다.
    // (그냥 + 연산을 하면 "10" + 100 이 "10100"처럼 문자열로 이어붙여집니다.)
    const currentTotal = parseInt(result.rows[0].total_treasure, 10);
    const newTotal = currentTotal + treasure.amount;

    await db.query(
      `UPDATE box_claims
       SET last_opened_at = $1, total_treasure = $2
       WHERE user_id = $3`,
      [now, newTotal, userId]
    );
    await recordItemObtained(userId, treasure.key);

    res.json({
      message: '상자를 열었습니다!',
      treasure,
      totalTreasure: newTotal,
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
    const result = await db.query(
      'SELECT last_opened_at, total_treasure FROM box_claims WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.json({ canOpen: true, totalTreasure: 0 });
    }

    const lastOpened = new Date(result.rows[0].last_opened_at);
    const now = new Date();
    const elapsedMs = now - lastOpened;
    const canOpen = elapsedMs >= COOLDOWN_MS;

    res.json({
      canOpen,
      totalTreasure: parseInt(result.rows[0].total_treasure, 10),
      nextAvailableAt: canOpen
        ? null
        : new Date(lastOpened.getTime() + COOLDOWN_MS),
      serverTime: now,
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
    }));

    res.json({ collection });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
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

module.exports = router;