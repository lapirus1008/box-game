// lib/mailGuard.js
// 메일 폭탄 방지: 받는 주소마다 발송 횟수를 셉니다. (비밀번호 찾기 · 이메일 인증 · 이메일 변경 합산)
// 계정을 여러 개 만들어도, 이메일 변경으로 남의 주소를 넣어도, 결국 "받는 주소" 한도에 걸립니다.
// 주소는 비밀 키로 만든 해시만 저장하고, 2일 지난 기록은 지웁니다.

const crypto = require('crypto');

const ADDRESS_GAP_MS = 60 * 1000;   // 같은 주소에는 1분에 1통
const ADDRESS_PER_HOUR = 5;
const ADDRESS_PER_DAY = 10;
const KEEP_DAYS = 2;

function emailHash(email) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(`mail:${String(email).trim().toLowerCase()}`).digest('hex');
}

// 이 주소로 지금 메일을 보내도 되는지. 반환: null(보내도 됨) 또는 이유
async function addressQuotaReason(runner, email) {
  const result = await runner.query(
    `SELECT MAX(created_at) AS last,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') AS hour,
            COUNT(*) AS day
     FROM mail_sends WHERE email_hash = $1 AND created_at > NOW() - INTERVAL '1 day'`,
    [emailHash(email)]
  );
  const row = result.rows[0];
  const last = row.last ? new Date(row.last).getTime() : 0;
  if (Date.now() - last < ADDRESS_GAP_MS) return 'gap';
  if (Number(row.hour) >= ADDRESS_PER_HOUR) return 'hour';
  if (Number(row.day) >= ADDRESS_PER_DAY) return 'day';
  return null;
}

// 한 계정이 이 종류의 메일을 하루에 몇 번 요청했는지 (예: 이메일 변경으로 여러 주소에 보내기 방지)
async function userSendsToday(runner, userId, purpose) {
  const result = await runner.query(
    `SELECT COUNT(*) AS n FROM mail_sends WHERE user_id = $1 AND purpose = $2 AND created_at > NOW() - INTERVAL '1 day'`,
    [userId, purpose]
  );
  return Number(result.rows[0].n);
}

async function recordMailSend(runner, email, userId, purpose) {
  await runner.query(
    'INSERT INTO mail_sends (email_hash, user_id, purpose) VALUES ($1, $2, $3)',
    [emailHash(email), userId || null, purpose]
  );
  // 오래된 기록 정리 (가끔만)
  if (Math.random() < 0.05) {
    await runner.query(`DELETE FROM mail_sends WHERE created_at < NOW() - ($1 || ' days')::interval`, [String(KEEP_DAYS)]);
  }
}

module.exports = { addressQuotaReason, userSendsToday, recordMailSend, ADDRESS_PER_DAY };
