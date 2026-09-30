// routes/auth.js
// 회원가입(signup)과 로그인(login) API를 담당하는 파일입니다.

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../db');

const router = express.Router();

// 로그인 타이밍 공격 방지용 더미 해시. (가입 시 만들어지는 실제 해시와 같은 형태의, 아무도 알 수 없는 값)
// 실제 값이 무엇인지는 중요하지 않고, "매번 bcrypt.compare를 한 번은 돌린다"는 점만 중요합니다.
const DUMMY_PASSWORD_HASH = '$2b$10$CwTycUXWue0Thq9StjUM0uJ8n0J8n0J8n0J8n0J8n0J8n0J8n0J8n';

// -------------------------------
// 무차별 대입/계정 대량 생성 방지 (rate limiting)
// -------------------------------
// 둘 다 "같은 IP 기준"으로 셉니다. 사무실/공용 와이파이처럼 IP를 공유하는 경우
// 여러 명이 겹치면 조금 빡빡할 수 있는데, 그럴 땐 max 값을 올리면 됩니다.
// Render 등 프록시 뒤에서 실제 클라이언트 IP를 인식하려면 server.js에 app.set('trust proxy', 1)이 필요합니다.
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1시간
  max: 5,                   // 같은 IP에서 1시간에 5번까지만 회원가입 시도 가능
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '회원가입 시도가 너무 많습니다. 1시간 후 다시 시도해주세요.' },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15분
  max: 10,                  // 같은 IP에서 15분에 10번까지만 로그인 시도 가능
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.' },
  skipSuccessfulRequests: true, // 성공한 로그인은 카운트에서 빼서, 정상 유저가 실수로 막히는 걸 줄임
});

// 이메일 형식이 올바른지 확인하는 정규식
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 닉네임 허용 문자: 한글, 영문, 숫자, 공백, 밑줄, 하이픈, 점
const NICKNAME_REGEX = /^[가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9 _.\-]+$/;

// 회원가입/로그인 입력값을 검증하는 함수
function validateSignupInput({ email, password, nickname }) {
  if (!email || !password || !nickname) {
    return '이메일, 비밀번호, 닉네임을 모두 입력해주세요.';
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
    return '닉네임은 2자 이상 20자 이하로 입력해주세요.';
  }
  // 닉네임은 랭킹 등 다른 사람 화면에 노출되므로, HTML 특수문자(< > & 따옴표 등)는 아예 막습니다.
  if (!NICKNAME_REGEX.test(nickname.trim())) {
    return '닉네임은 한글, 영문, 숫자, 공백, _ - . 만 사용할 수 있습니다.';
  }
  // bcrypt는 72바이트까지만 사용하고, 지나치게 긴 입력은 서버 자원만 낭비합니다.
  if (Buffer.byteLength(password, 'utf8') > 72) {
    return '비밀번호는 72바이트(영문 기준 72자) 이하로 입력해주세요.';
  }
  return null; // 문제 없음
}

// -------------------------------
// 회원가입: POST /api/auth/signup
// -------------------------------
// 프론트엔드에서 이렇게 요청을 보낼 겁니다:
// { "email": "test@test.com", "password": "1234", "nickname": "홍길동" }
router.post('/signup', signupLimiter, async (req, res) => {
  const { email, password, nickname } = req.body;

  // 1. 입력값 검증 (형식, 길이까지 확인)
  const validationError = validateSignupInput({ email, password, nickname });
  if (validationError) {
    return res.status(400).json({ message: validationError });
  }

  let client = null;
  try {
    // 2. 이미 가입된 이메일인지 확인
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ message: '이미 가입된 이메일입니다.' });
    }

    // 3. 비밀번호 암호화
    // 절대로 비밀번호를 그대로 DB에 저장하면 안 됩니다. bcrypt로 해시(암호화)합니다.
    // 숫자 10은 "얼마나 강하게 암호화할지"를 정하는 값입니다 (보통 10~12 사용).
    const passwordHash = await bcrypt.hash(password, 10);

    // 4. DB에 새 사용자 저장
    // users와 box_claims는 함께 만들어져야 하므로 하나의 트랜잭션으로 묶습니다.
    // (중간에 실패해서 세이브 없는 계정이 남는 것을 방지)
    client = await db.getClient();
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO users (email, password_hash, nickname, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id, email, nickname`,
      [email, passwordHash, nickname.trim()]
    );

    const newUser = result.rows[0];

    // 5. 시작할 때 바로 체험해볼 수 있도록 초기 골드를 지급하고,
    //    last_opened_at을 아주 예전으로 넣어서 가입 직후 바로 상자를 열 수 있게 합니다.
    // 기록모드/수집모드는 완전히 독립된 세이브라, 가입 시점에 둘 다 만들어둡니다.
    // (기본 활성 모드는 users.active_mode 컬럼의 DEFAULT 'record'를 따릅니다.)
    const INITIAL_GOLD = 2000;
    await client.query(
      `INSERT INTO box_claims (user_id, mode, last_opened_at, total_treasure)
       VALUES ($1, 'record', $2, $3), ($1, 'collection', $2, $3)`,
      [newUser.id, new Date(0), INITIAL_GOLD]
    );

    await client.query('COMMIT');

    // 6. 회원가입과 동시에 로그인 토큰도 바로 발급 (선택사항이지만 편리함)
    const token = jwt.sign(
      { userId: newUser.id, email: newUser.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' } // 토큰 유효기간 7일
    );

    res.status(201).json({
      message: '회원가입 성공',
      user: newUser,
      token,
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    // 동시에 같은 이메일로 가입이 들어온 경우(UNIQUE 위반)도 중복 가입으로 안내
    if (err.code === '23505') {
      return res.status(409).json({ message: '이미 가입된 이메일입니다.' });
    }
    console.error(err);
    res.status(500).json({ message: '서버 오류로 회원가입에 실패했습니다.' });
  } finally {
    if (client) client.release();
  }
});

// -------------------------------
// 로그인: POST /api/auth/login
// -------------------------------
// 요청 형태: { "email": "test@test.com", "password": "1234" }
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: '이메일과 비밀번호를 입력해주세요.' });
  }
  if (!EMAIL_REGEX.test(email)) {
    return res.status(400).json({ message: '올바른 이메일 형식이 아닙니다.' });
  }

  try {
    // 1. 이메일로 사용자 찾기
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    // 2. 입력한 비밀번호와 저장된 해시를 비교
    // 존재하지 않는 이메일이면 즉시 401을 반환하지 않고, 가짜 해시로라도 bcrypt.compare를 실행합니다.
    // bcrypt는 일부러 느리게 동작하도록 설계돼 있어서, "가입 안 된 이메일 → 곧바로 실패"와
    // "가입은 됐지만 비번 틀림 → bcrypt 비교 후 실패"의 응답 시간 차이로 이메일 존재 여부를
    // 추측(타이밍 공격)할 수 있기 때문입니다.
    const passwordHashToCheck = user ? user.password_hash : DUMMY_PASSWORD_HASH;
    const isMatch = await bcrypt.compare(password, passwordHashToCheck);

    if (!user || !isMatch) {
      // 보안을 위해 "이메일이 없다"와 "비밀번호가 틀렸다"를 구분해서 알려주지 않습니다.
      return res.status(401).json({ message: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    }

    // 3. 로그인 성공 → JWT 토큰 발급
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: '로그인 성공',
      user: { id: user.id, email: user.email, nickname: user.nickname },
      token,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 오류로 로그인에 실패했습니다.' });
  }
});

const verifyToken = require('../middleware/auth');

// -------------------------------
// 내 정보 조회: GET /api/auth/me
// -------------------------------
// 새로고침 후에도 로그인 상태를 유지하기 위해, 저장해둔 토큰이 아직
// 유효한지 확인하고 사용자 정보를 다시 받아오는 용도로 씁니다.
router.get('/me', verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, email, nickname, active_mode FROM users WHERE id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: '사용자를 찾을 수 없습니다.' });
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '서버 오류가 발생했습니다.' });
  }
});

module.exports = router;