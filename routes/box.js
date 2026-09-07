// routes/box.js
// 로그인한 사용자가 1시간마다 상자를 열어 보물을 얻는 API입니다.

const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/auth');

const router = express.Router();

const COOLDOWN_MS = 60 * 60 * 1000; // 1시간 (밀리초 단위)

// 지급할 보물 후보 목록입니다. 원하는 대로 자유롭게 바꾸세요.
const TREASURES = [
  { name: '동화 10개', amount: 10, weight: 50 },   // weight가 클수록 자주 나옴
  { name: '동화 30개', amount: 30, weight: 30 },
  { name: '동화 100개', amount: 100, weight: 15 },
  { name: '전설 아이템', amount: 500, weight: 5 },
];

// weight(가중치)를 기반으로 랜덤하게 보물 하나를 뽑는 함수
function pickRandomTreasure() {
  const totalWeight = TREASURES.reduce((sum, t) => sum + t.weight, 0);
  let rand = Math.random() * totalWeight;

  for (const treasure of TREASURES) {
    if (rand < treasure.weight) return treasure;
    rand -= treasure.weight;
  }
  return TREASURES[0]; // 혹시 모를 예외 상황 대비
}

// -------------------------------
// 상자 열기: POST /api/box/open
// -------------------------------
// verifyToken 미들웨어를 먼저 거치기 때문에, 로그인한 사용자만 이 라우트에 도달할 수 있습니다.
// 미들웨어를 통과하면 req.user에 { userId, email }이 들어있습니다.
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

      return res.json({
        message: '상자를 열었습니다!',
        treasure,
        totalTreasure: treasure.amount,
        nextAvailableAt: new Date(now.getTime() + COOLDOWN_MS),
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
    const newTotal = result.rows[0].total_treasure + treasure.amount;

    await db.query(
      `UPDATE box_claims
       SET last_opened_at = $1, total_treasure = $2
       WHERE user_id = $3`,
      [now, newTotal, userId]
    );

    res.json({
      message: '상자를 열었습니다!',
      treasure,
      totalTreasure: newTotal,
      nextAvailableAt: new Date(now.getTime() + COOLDOWN_MS),
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
      totalTreasure: result.rows[0].total_treasure,
      nextAvailableAt: canOpen
        ? null
        : new Date(lastOpened.getTime() + COOLDOWN_MS),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;