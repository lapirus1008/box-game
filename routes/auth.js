// routes/auth.js
// 회원가입(signup)과 로그인(login) API를 담당하는 파일입니다.

const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const verifyToken = require('../middleware/auth');
const { signToken } = require('../lib/token');
const { createLimiter } = require('../lib/rateLimit');
const { HttpError, withTransaction, handle } = require('../lib/http');
const { INITIAL_GOLD } = require('../game/config');
const { getSeason } = require('../game/season');
const crypto = require('crypto');
const { sendMail, isMailConfigured, maskEmail } = require('../lib/mail');

const router = express.Router();

// 로그인 타이밍 공격 방지용 더미 해시. (가입 시 만들어지는 실제 해시와 같은 형태의, 아무도 알 수 없는 값)
// 실제 값이 무엇인지는 중요하지 않고, "매번 bcrypt.compare를 한 번은 돌린다"는 점만 중요합니다.
const DUMMY_PASSWORD_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8n0J8n0J8n0J8n0J8n0J8n0J8n0J8n';
const BCRYPT_ROUNDS = 10; // "얼마나 강하게 암호화할지"를 정하는 값입니다 (보통 10~12 사용).

// -------------------------------
// 무차별 대입/계정 대량 생성 방지 (rate limiting)
// -------------------------------
// 둘 다 "같은 IP 기준"으로 셉니다. 사무실/공용 와이파이처럼 IP를 공유하는 경우
// 여러 명이 겹치면 조금 빡빡할 수 있는데, 그럴 땐 max 값을 올리면 됩니다.
// Render 등 프록시 뒤에서 실제 클라이언트 IP를 인식하려면 server.js에 app.set('trust proxy', 1)이 필요합니다.
const signupLimiter = createLimiter({
  name: 'signup',
  windowMs: 60 * 60 * 1000, // 1시간
  max: 5,                   // 같은 IP에서 1시간에 5번까지만 회원가입 시도 가능
  message: '회원가입 시도가 너무 많습니다. 1시간 후 다시 시도해 주십시오.',
});

const loginLimiter = createLimiter({
  name: 'login',
  windowMs: 15 * 60 * 1000, // 15분
  max: 10,                  // 같은 IP에서 15분에 10번까지만 로그인 시도 가능
  message: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주십시오.',
  skipSuccessfulRequests: true, // 성공한 로그인은 카운트에서 빼서, 정상 유저가 실수로 막히는 걸 줄임
});

// 이메일 형식이 올바른지 확인하는 정규식
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 닉네임 허용 문자: 한글, 영문, 숫자, 공백, 밑줄, 하이픈, 점
const NICKNAME_REGEX = /^[가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9 _.\-]+$/;

// 회원가입/로그인 입력값을 검증하는 함수
function validateSignupInput({ email, password, nickname }) {
  if (!email || !password || !nickname) {
    return '이메일, 비밀번호, 닉네임을 모두 입력해 주십시오.';
  }
  // 길이(.length)를 확인하기 전에 타입부터 검사합니다.
  // (숫자나 배열처럼 문자열이 아닌 값이 오면 .length가 엉뚱하게 동작하거나 에러가 날 수 있어서)
  if (typeof nickname !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
    return '입력 형식이 올바르지 않습니다.';
  }
  if (!EMAIL_REGEX.test(email)) {
    return '올바른 이메일 형식이 아닙니다.';
  }
  if (password.length < 4) {
    return '비밀번호는 4자 이상이어야 합니다.';
  }
  if (nickname.trim().length < 2 || nickname.trim().length > 20) {
    return '닉네임은 2자 이상 20자 이하로 입력해 주십시오.';
  }
  // 닉네임은 랭킹 등 다른 사람 화면에 노출되므로, HTML 특수문자(< > & 따옴표 등)는 아예 막습니다.
  if (!NICKNAME_REGEX.test(nickname.trim())) {
    return '닉네임은 한글, 영문, 숫자, 공백, _ - . 만 사용할 수 있습니다.';
  }
  // bcrypt는 72바이트까지만 사용하고, 지나치게 긴 입력은 서버 자원만 낭비합니다.
  if (Buffer.byteLength(password, 'utf8') > 72) {
    return '비밀번호는 72바이트(영문 기준 72자) 이하로 입력해 주십시오.';
  }
  return null; // 문제 없음
}

// -------------------------------
// 회원가입: POST /api/auth/signup
// -------------------------------
// 프론트엔드에서 이렇게 요청을 보낼 겁니다:
// { "email": "test@test.com", "password": "1234", "nickname": "홍길동" }
const DUPLICATE_EMAIL_MESSAGE = '이미 가입된 이메일입니다.';
const UNIQUE_VIOLATION = '23505'; // PostgreSQL UNIQUE 제약 위반 에러 코드

router.post('/signup', signupLimiter, handle('서버 오류로 회원가입에 실패했습니다.', async (req, res) => {
  const { email, password, nickname } = req.body;

  // 1. 입력값 검증 (형식, 길이까지 확인)
  const validationError = validateSignupInput({ email, password, nickname });
  if (validationError) throw new HttpError(400, validationError);

  // 2. 이미 가입된 이메일인지 확인
  const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) throw new HttpError(409, DUPLICATE_EMAIL_MESSAGE);

  // 3. 비밀번호 암호화
  // 절대로 비밀번호를 그대로 DB에 저장하면 안 됩니다. bcrypt로 해시(암호화)합니다.
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  // 4. DB에 새 사용자 저장
  // users와 box_claims는 함께 만들어져야 하므로 하나의 트랜잭션으로 묶습니다.
  // (중간에 실패해서 세이브 없는 계정이 남는 것을 방지)
  let newUser;
  try {
    newUser = await withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO users (email, password_hash, nickname, created_at)
         VALUES ($1, $2, $3, NOW())
         RETURNING id, email, nickname`,
        [email, passwordHash, nickname.trim()]
      );
      const user = result.rows[0];

      // 5. 시작할 때 바로 체험해볼 수 있도록 초기 골드를 지급하고,
      //    last_opened_at을 아주 예전으로 넣어서 가입 직후 바로 상자를 열 수 있게 합니다.
      // 기록모드/수집모드는 완전히 독립된 세이브라, 가입 시점에 둘 다 만들어둡니다.
      // (기본 활성 모드는 users.active_mode 컬럼의 DEFAULT 'record'를 따릅니다.)
      // season: 지금 시즌으로 시작해야 첫 접속 때 "새 시즌 초기화"가 일어나지 않습니다.
      await client.query(
        `INSERT INTO box_claims (user_id, mode, last_opened_at, total_treasure, season)
         VALUES ($1, 'record', $2, $3, $4), ($1, 'collection', $2, $3, $4)`,
        [user.id, new Date(0), INITIAL_GOLD, getSeason()]
      );
      return user;
    });
  } catch (err) {
    // 동시에 같은 이메일로 가입이 들어온 경우(UNIQUE 위반)도 중복 가입으로 안내
    if (err.code === UNIQUE_VIOLATION) throw new HttpError(409, DUPLICATE_EMAIL_MESSAGE);
    throw err;
  }

  // 6. 회원가입과 동시에 로그인 토큰도 바로 발급 (선택사항이지만 편리함)
  res.status(201);
  return {
    message: '회원가입 성공',
    user: newUser,
    token: signToken(newUser),
  };
}));

// -------------------------------
// 로그인: POST /api/auth/login
// -------------------------------
// 요청 형태: { "email": "test@test.com", "password": "1234" }
router.post('/login', loginLimiter, handle('서버 오류로 로그인에 실패했습니다.', async (req) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw new HttpError(400, '이메일과 비밀번호를 입력해 주십시오.');
  }
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw new HttpError(400, '입력 형식이 올바르지 않습니다.');
  }
  if (!EMAIL_REGEX.test(email)) {
    throw new HttpError(400, '올바른 이메일 형식이 아닙니다.');
  }

  // 1. 이메일로 사용자 찾기
  const result = await db.query('SELECT id, email, nickname, password_hash FROM users WHERE email = $1', [email]);
  const user = result.rows[0];

  // 2. 입력한 비밀번호와 저장된 해시를 비교
  // 존재하지 않는 이메일이면 즉시 401을 반환하지 않고, 가짜 해시로라도 bcrypt.compare를 실행합니다.
  // bcrypt는 일부러 느리게 동작하도록 설계돼 있어서, "가입 안 된 이메일 → 곧바로 실패"와
  // "가입은 됐지만 비번 틀림 → bcrypt 비교 후 실패"의 응답 시간 차이로 이메일 존재 여부를
  // 추측(타이밍 공격)할 수 있기 때문입니다.
  const isMatch = await bcrypt.compare(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);

  if (!user || !isMatch) {
    // 보안을 위해 "이메일이 없다"와 "비밀번호가 틀렸다"를 구분해서 알려주지 않습니다.
    throw new HttpError(401, '이메일 또는 비밀번호가 올바르지 않습니다.');
  }

  // 3. 로그인 성공 → JWT 토큰 발급
  return {
    message: '로그인 성공',
    user: { id: user.id, email: user.email, nickname: user.nickname },
    token: signToken(user),
  };
}));

// -------------------------------
// 내 정보 조회: GET /api/auth/me
// -------------------------------
// 새로고침 후에도 로그인 상태를 유지하기 위해, 저장해둔 토큰이 아직
// 유효한지 확인하고 사용자 정보를 다시 받아오는 용도로 씁니다.
router.get('/me', verifyToken, handle('서버 오류가 발생했습니다.', async (req) => {
  const result = await db.query(
    'SELECT id, email, nickname, active_mode, transcend_count FROM users WHERE id = $1',
    [req.user.userId]
  );
  if (result.rows.length === 0) throw new HttpError(404, '사용자를 찾을 수 없습니다.');

  // 들어올 때마다 유효기간을 새로 늘린 토큰을 함께 돌려줍니다(자주 하는 사람은 다시 로그인할 일이 없게).
  return { user: result.rows[0], token: signToken(result.rows[0]) };
}));

// -------------------------------
// 비밀번호 찾기
//   POST /api/auth/forgot { email }                      이메일로 6자리 인증 코드 보내기
//   POST /api/auth/reset  { email, code, newPassword }    코드 확인 후 새 비밀번호로 바꾸고 바로 로그인
// - 가입 여부를 알 수 없도록, 없는 이메일이어도 같은 안내를 돌려줍니다.
// - 코드는 비밀 키로 만든 해시만 저장, 15분 뒤 만료, 5번 틀리면 무효.
// - 같은 계정은 1분에 한 번, 1시간에 5번까지만 코드를 보냅니다.
// -------------------------------
const RESET_CODE_TTL_MIN = 15;
const RESET_MAX_ATTEMPTS = 5;
const RESET_RESEND_GAP_MS = 60 * 1000;
const RESET_MAX_PER_HOUR = 5;
const FORGOT_SENT_MESSAGE = '가입된 이메일이면 인증 코드를 보냈습니다. 메일함(스팸함 포함)을 확인해 주십시오. 코드는 15분 동안 쓸 수 있습니다.';
const RESET_INVALID_MESSAGE = '인증 코드가 만료되었거나 없습니다. 코드를 다시 받아 주십시오.';

const forgotLimiter = createLimiter({
  name: 'forgot',
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: '비밀번호 찾기 요청이 너무 많습니다. 잠시 후 다시 시도해 주십시오.',
});
const resetLimiter = createLimiter({
  name: 'reset',
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: '시도가 너무 많습니다. 잠시 후 다시 시도해 주십시오.',
});

function hashResetCode(userId, code) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${userId}:${code}`).digest('hex');
}

router.post('/forgot', forgotLimiter, handle('서버 오류로 인증 코드를 보내지 못했습니다.', async (req) => {
  const { email } = req.body;
  if (typeof email !== 'string' || !EMAIL_REGEX.test(email)) throw new HttpError(400, '올바른 이메일 형식이 아닙니다.');
  if (!isMailConfigured()) {
    console.error('[MAIL] 비밀번호 찾기 요청이 왔지만 메일 발송 설정(BREVO_API_KEY, MAIL_FROM)이 없습니다');
    throw new HttpError(503, '지금은 비밀번호 찾기를 쓸 수 없습니다. 개인정보처리방침의 문의처로 연락해 주십시오.');
  }

  const result = await db.query('SELECT id, nickname FROM users WHERE email = $1', [email]);
  const user = result.rows[0];
  // 메일이 안 왔다는 문의를 확인할 수 있도록, 보낸 경우·건너뛴 경우 모두 로그로 남깁니다 (주소는 가림)
  if (!user) {
    console.log(`[MAIL] 비밀번호 찾기: 가입되지 않은 이메일 ${maskEmail(email)} → 발송 안 함`);
    return { message: FORGOT_SENT_MESSAGE };
  }

  const recent = await db.query(
    `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM password_resets
     WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [user.id]
  );
  const last = recent.rows[0].last ? new Date(recent.rows[0].last).getTime() : 0;
  if (Date.now() - last < RESET_RESEND_GAP_MS || Number(recent.rows[0].n) >= RESET_MAX_PER_HOUR) {
    // 너무 자주 요청하면 새 코드를 보내지 않음 (안내는 같게 해서 가입 여부를 숨김)
    console.log(`[MAIL] 비밀번호 찾기: 1분 안 재요청 또는 1시간 ${RESET_MAX_PER_HOUR}번 초과 → 발송 생략 user=${user.id}`);
    return { message: FORGOT_SENT_MESSAGE };
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.query(
    `INSERT INTO password_resets (user_id, code_hash, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)`,
    [user.id, hashResetCode(user.id, code), String(RESET_CODE_TTL_MIN)]
  );
  try {
    const messageId = await sendMail({
      to: email,
      subject: `[시간의 상자] 비밀번호 재설정 인증 코드 ${code}`,
      text: `${user.nickname}님, 비밀번호 재설정 인증 코드는 ${code} 입니다.\n${RESET_CODE_TTL_MIN}분 안에 게임의 비밀번호 찾기 화면에 입력해 주십시오.\n직접 요청하지 않으셨다면 이 메일은 무시하셔도 됩니다.`,
      html: `<div style="font-family:sans-serif;line-height:1.6">
        <p>${escapeHtmlText(user.nickname)}님, 「시간의 상자」 비밀번호 재설정 인증 코드입니다.</p>
        <p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p>
        <p>${RESET_CODE_TTL_MIN}분 안에 게임의 비밀번호 찾기 화면에 입력해 주십시오.<br>직접 요청하지 않으셨다면 이 메일은 무시하셔도 됩니다.</p>
      </div>`,
    });
    console.log(`[MAIL] 인증 코드 메일을 메일 서비스에 넘김 user=${user.id} → ${maskEmail(email)} (id ${messageId})`);
  } catch (err) {
    console.error(`[MAIL] 인증 코드 메일 발송 실패 user=${user.id} · ${err.message}`);
  }
  return { message: FORGOT_SENT_MESSAGE };
}));

router.post('/reset', resetLimiter, handle('서버 오류로 비밀번호를 바꾸지 못했습니다.', async (req) => {
  const { email, code, newPassword } = req.body;
  if (typeof email !== 'string' || typeof code !== 'string' || typeof newPassword !== 'string') {
    throw new HttpError(400, '입력 형식이 올바르지 않습니다.');
  }
  if (!/^\d{6}$/.test(code.trim())) throw new HttpError(400, '인증 코드는 숫자 6자리입니다.');
  if (newPassword.length < 4) throw new HttpError(400, '비밀번호는 4자 이상이어야 합니다.');
  if (Buffer.byteLength(newPassword, 'utf8') > 72) throw new HttpError(400, '비밀번호는 72바이트(영문 기준 72자) 이하로 입력해 주십시오.');

  const userResult = await db.query('SELECT id, email, nickname FROM users WHERE email = $1', [email]);
  const user = userResult.rows[0];
  if (!user) throw new HttpError(400, RESET_INVALID_MESSAGE);

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  return withTransaction(async (client) => {
    const resetResult = await client.query(
      `SELECT id, code_hash, attempts FROM password_resets
       WHERE user_id = $1 AND expires_at > NOW() AND attempts < $2
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [user.id, RESET_MAX_ATTEMPTS]
    );
    const reset = resetResult.rows[0];
    if (!reset) throw new HttpError(400, RESET_INVALID_MESSAGE);

    const expected = Buffer.from(reset.code_hash, 'hex');
    const given = Buffer.from(hashResetCode(user.id, code.trim()), 'hex');
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      // 틀린 횟수는 트랜잭션 밖에서도 남아야 해서 바로 올리고 커밋합니다 (오류는 아래에서 응답)
      await client.query('UPDATE password_resets SET attempts = attempts + 1 WHERE id = $1', [reset.id]);
      const left = RESET_MAX_ATTEMPTS - reset.attempts - 1;
      return { wrongCode: true, left };
    }

    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, user.id]);
    await client.query('DELETE FROM password_resets WHERE user_id = $1', [user.id]);
    console.log(`[AUTH] 비밀번호 재설정 완료 user=${user.id}`);
    return {
      message: '비밀번호를 바꿨습니다. 새 비밀번호로 로그인되었습니다.',
      user: { id: user.id, email: user.email, nickname: user.nickname },
      token: signToken(user),
    };
  }).then((result) => {
    if (result.wrongCode) {
      throw new HttpError(400, result.left > 0
        ? `인증 코드가 맞지 않습니다. (남은 시도 ${result.left}번)`
        : '인증 코드를 여러 번 틀려 무효가 되었습니다. 코드를 다시 받아 주십시오.');
    }
    return result;
  });
}));

// 메일 본문(HTML)에 닉네임을 넣을 때 이스케이프
function escapeHtmlText(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// -------------------------------
// 계정 삭제: POST /api/auth/delete-account
// -------------------------------
// 요청 형태: { "email": "...", "password": "..." }
// 앱 스토어 정책상 계정을 만들 수 있는 앱은 앱 안(과 웹)에서 계정을 지울 수 있어야 합니다.
// 로그인 없이도(웹 페이지에서) 쓸 수 있도록 이메일+비밀번호로 본인 확인을 합니다.
// 랭킹 기록·세이브·신화 도감 등 이 계정의 모든 데이터를 즉시 지우며, 되돌릴 수 없습니다.
const deleteLimiter = createLimiter({
  name: 'delete-account',
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: '시도가 너무 많습니다. 잠시 후 다시 시도해 주십시오.',
});

router.post('/delete-account', deleteLimiter, handle('서버 오류로 계정을 삭제하지 못했습니다.', async (req) => {
  const { email, password } = req.body;
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    throw new HttpError(400, '이메일과 비밀번호를 입력해 주십시오.');
  }

  const result = await db.query('SELECT id, password_hash FROM users WHERE email = $1', [email]);
  const user = result.rows[0];
  const isMatch = await bcrypt.compare(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);
  if (!user || !isMatch) throw new HttpError(401, '이메일 또는 비밀번호가 올바르지 않습니다.');

  await withTransaction(async (client) => {
    // users를 참조하는 테이블부터 지웁니다.
    for (const table of ['guestbook_reports', 'guestbook_entries', 'user_items', 'user_discoveries', 'rebirth_history', 'box_claims']) {
      await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [user.id]);
    }
    await client.query('DELETE FROM users WHERE id = $1', [user.id]);
  });

  return { message: '계정과 모든 게임 데이터를 삭제했습니다.' };
}));

module.exports = router;
