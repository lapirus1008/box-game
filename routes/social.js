// routes/social.js
// 차단 목록: 차단한 사람의 광장 캐릭터·채팅과 방명록 글은 나에게 보이지 않습니다.
//   GET    /api/social/blocks          내 차단 목록 [{ id, nickname }]
//   POST   /api/social/block { userId } 차단
//   DELETE /api/social/block/:id       차단 해제
// (광장 채팅 신고는 실시간 연결로 받습니다: lib/lobby.js)

const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/auth');
const { HttpError, handle } = require('../lib/http');

const MAX_BLOCKS = 500;
const MAX_INT = 2147483647;
const router = express.Router();
router.use(verifyToken);

function parseUserId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id >= 1 && id <= MAX_INT ? id : null;
}

router.get('/blocks', handle('차단 목록을 불러오지 못했습니다.', async (req) => {
  const result = await db.query(
    `SELECT u.id, u.nickname FROM user_blocks b JOIN users u ON u.id = b.blocked_id
     WHERE b.user_id = $1 ORDER BY b.created_at DESC`,
    [req.user.userId]
  );
  return { blocks: result.rows };
}));

router.post('/block', handle('차단하지 못했습니다.', async (req) => {
  const me = req.user.userId;
  const target = parseUserId(req.body.userId);
  if (!target) throw new HttpError(400, '잘못된 사용자입니다.');
  if (target === me) throw new HttpError(400, '나 자신은 차단할 수 없습니다.');
  const user = await db.query('SELECT nickname FROM users WHERE id = $1', [target]);
  if (!user.rows[0]) throw new HttpError(404, '없는 사용자입니다.');
  const count = await db.query('SELECT COUNT(*) AS n FROM user_blocks WHERE user_id = $1', [me]);
  if (Number(count.rows[0].n) >= MAX_BLOCKS) throw new HttpError(400, `차단은 ${MAX_BLOCKS}명까지 할 수 있습니다.`);
  await db.query(
    'INSERT INTO user_blocks (user_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [me, target]
  );
  return { message: `${user.rows[0].nickname}님을 차단했어요. 광장·방명록에서 보이지 않습니다.`, blocked: { id: target, nickname: user.rows[0].nickname } };
}));

router.delete('/block/:id', handle('차단을 풀지 못했습니다.', async (req) => {
  const target = parseUserId(req.params.id);
  if (!target) throw new HttpError(400, '잘못된 사용자입니다.');
  await db.query('DELETE FROM user_blocks WHERE user_id = $1 AND blocked_id = $2', [req.user.userId, target]);
  return { message: '차단을 해제했어요.' };
}));

module.exports = router;
