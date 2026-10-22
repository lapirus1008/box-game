// routes/guestbook.js
// 방명록: 로그인한 사람끼리 짧은 글을 남기고 읽습니다.
//   GET    /api/guestbook?before=<id>  최신 글부터 GUESTBOOK_PAGE_SIZE개 (before보다 오래된 글 = 더 보기)
//   POST   /api/guestbook { message }  글쓰기 (최대 GUESTBOOK_MAX_LENGTH자, GUESTBOOK_COOLDOWN_MS마다 1번)
//   DELETE /api/guestbook/:id          내 글 삭제
//   POST   /api/guestbook/:id/report   신고 (신고한 사람에게는 바로 숨김, GUESTBOOK_HIDE_REPORTS명 이상이면 모두에게 숨김)

const express = require('express');
const db = require('../db');
const verifyToken = require('../middleware/auth');
const { HttpError, handle } = require('../lib/http');
const { collectorTitlesFor } = require('./box');
const { normalizeMissionState } = require('../game/collection');
const { getDay } = require('../game/season');

const GUESTBOOK_PAGE_SIZE = 30;
const GUESTBOOK_MAX_LENGTH = 200;
const GUESTBOOK_COOLDOWN_MS = 30 * 1000;
const GUESTBOOK_HIDE_REPORTS = 3;

const router = express.Router();
router.use(verifyToken);

router.get('/', handle('방명록을 불러오지 못했습니다.', async (req) => {
  const userId = req.user.userId;
  const before = parseInt(req.query.before, 10);
  const result = await db.query(
    `SELECT g.id, g.user_id, g.message, g.created_at, u.nickname
     FROM guestbook_entries g
     JOIN users u ON u.id = g.user_id
     WHERE ($1::int IS NULL OR g.id < $1)
       AND NOT EXISTS (SELECT 1 FROM guestbook_reports r WHERE r.entry_id = g.id AND r.user_id = $2)
       AND (SELECT COUNT(*) FROM guestbook_reports r WHERE r.entry_id = g.id) < $3
     ORDER BY g.id DESC
     LIMIT $4`,
    [Number.isFinite(before) ? before : null, userId, GUESTBOOK_HIDE_REPORTS, GUESTBOOK_PAGE_SIZE + 1]
  );
  const rows = result.rows.slice(0, GUESTBOOK_PAGE_SIZE);
  const titles = await collectorTitlesFor([...new Set(rows.map(r => r.user_id))]);
  return {
    entries: rows.map(r => ({
      id: r.id,
      nickname: r.nickname,
      title: titles[r.user_id],
      message: r.message,
      createdAt: r.created_at,
      isMine: r.user_id === userId,
    })),
    hasMore: result.rows.length > GUESTBOOK_PAGE_SIZE,
    maxLength: GUESTBOOK_MAX_LENGTH,
  };
}));

router.post('/', handle('글을 남기지 못했습니다.', async (req) => {
  const userId = req.user.userId;
  const raw = typeof req.body.message === 'string' ? req.body.message : '';
  // 줄바꿈은 3줄 연속까지만, 앞뒤 공백은 지웁니다.
  const message = raw.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!message) throw new HttpError(400, '내용을 입력해주세요.');
  if ([...message].length > GUESTBOOK_MAX_LENGTH) throw new HttpError(400, `${GUESTBOOK_MAX_LENGTH}자까지 작성할 수 있습니다.`);

  const last = await db.query(
    'SELECT created_at FROM guestbook_entries WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [userId]
  );
  if (last.rows[0]) {
    const waitMs = GUESTBOOK_COOLDOWN_MS - (Date.now() - new Date(last.rows[0].created_at).getTime());
    if (waitMs > 0) throw new HttpError(429, `${Math.ceil(waitMs / 1000)}초 후 다시 작성할 수 있습니다.`);
  }

  const inserted = await db.query(
    `INSERT INTO guestbook_entries (user_id, message) VALUES ($1, $2)
     RETURNING id, created_at, (SELECT nickname FROM users WHERE id = $1) AS nickname`,
    [userId, message]
  );
  const row = inserted.rows[0];
  // 수집모드 일일 미션 '방명록에 한마디' 진행 (그날 미션이 아니어도 기록만 해 둠)
  const claimRow = await db.query(`SELECT daily_missions FROM box_claims WHERE user_id = $1 AND mode = 'collection'`, [userId]);
  if (claimRow.rows[0]) {
    const state = normalizeMissionState(claimRow.rows[0].daily_missions, getDay());
    state.progress.guestbook = (state.progress.guestbook || 0) + 1;
    await db.query(`UPDATE box_claims SET daily_missions = $2 WHERE user_id = $1 AND mode = 'collection'`, [userId, JSON.stringify(state)]);
  }
  const titles = await collectorTitlesFor([userId]);
  // 방금 쓴 글을 그대로 돌려줘서 화면이 목록을 다시 불러오지 않고 맨 위에 끼워 넣게 합니다.
  return {
    message: '방명록에 글을 남겼습니다.',
    entry: { id: row.id, nickname: row.nickname, title: titles[userId], message, createdAt: row.created_at, isMine: true },
  };
}));

router.delete('/:id', handle('글을 지우지 못했습니다.', async (req) => {
  const result = await db.query(
    'DELETE FROM guestbook_entries WHERE id = $1 AND user_id = $2',
    [parseInt(req.params.id, 10) || 0, req.user.userId]
  );
  if (result.rowCount === 0) throw new HttpError(404, '삭제할 수 있는 글이 없습니다.');
  return { message: '글을 삭제했습니다.' };
}));

router.post('/:id/report', handle('신고하지 못했습니다.', async (req) => {
  const entryId = parseInt(req.params.id, 10) || 0;
  const entry = await db.query('SELECT user_id FROM guestbook_entries WHERE id = $1', [entryId]);
  if (!entry.rows[0]) throw new HttpError(404, '이미 삭제된 글입니다.');
  if (entry.rows[0].user_id === req.user.userId) throw new HttpError(400, '내 글은 신고할 수 없습니다.');
  await db.query(
    'INSERT INTO guestbook_reports (entry_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [entryId, req.user.userId]
  );
  return { message: '신고 완료. 이 글은 더 이상 표시되지 않습니다.' };
}));

module.exports = router;
