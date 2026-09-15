// routes/auth.js
// 회원가입(signup)과 로그인(login) API를 담당하는 파일입니다.

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();

// 이메일 형식이 올바른지 확인하는 정규식
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 회원가입/로그인 입력값을 검증하는 함수
function validateSignupInput({ email, password, nickname }) {
  if (!email || !password || !nickname) {
    return '이메일, 비밀번호, 닉네임을 모두 입력해주세요.';
  }
  if (!EMAIL_REGEX.test(email)) {
    return '올바른 이메일 형식이 아닙니다.';
  }
  if (password.length < 8) {
    return '비밀번호는 8자 이상이어야 합니다.';
  }
  if (nickname.trim().length < 2 || nickname.trim().length > 20) {
    return '닉네임은 2자 이상 20자 이하로 입력해주세요.';
  }
  return null; // 문제 없음
}

// -------------------------------
// 회원가입: POST /api/auth/signup
// -------------------------------
// 프론트엔드에서 이렇게 요청을 보낼 겁니다:
// { "email": "test@test.com", "password": "1234", "nickname": "홍길동" }
router.post('/signup', async (req, res) => {
  const { email, password, nickname } = req.body;

  // 1. 입력값 검증 (형식, 길이까지 확인)
  const validationError = validateSignupInput({ email, password, nickname });
  if (validationError) {
    return res.status(400).json({ message: validationError });
  }

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
    const result = await db.query(
      `INSERT INTO users (email, password_hash, nickname, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id, email, nickname`,
      [email, passwordHash, nickname]
    );

    const newUser = result.rows[0];

    // 5. 시작할 때 바로 체험해볼 수 있도록 초기 골드를 지급하고,
    //    last_opened_at을 아주 예전으로 넣어서 가입 직후 바로 상자를 열 수 있게 합니다.
    const INITIAL_GOLD = 2000;
    await db.query(
      `INSERT INTO box_claims (user_id, last_opened_at, total_treasure)
       VALUES ($1, $2, $3)`,
      [newUser.id, new Date(0), INITIAL_GOLD]
    );

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
    console.error(err);
    res.status(500).json({ message: '서버 오류로 회원가입에 실패했습니다.' });
  }
});

// -------------------------------
// 로그인: POST /api/auth/login
// -------------------------------
// 요청 형태: { "email": "test@test.com", "password": "1234" }
router.post('/login', async (req, res) => {
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

    if (!user) {
      // 보안을 위해 "이메일이 없다"와 "비밀번호가 틀렸다"를 구분해서 알려주지 않습니다.
      return res.status(401).json({ message: '이메일 또는 비밀번호가 올바르지 않습니다.' });
    }

    // 2. 입력한 비밀번호와 저장된 해시를 비교
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
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
      'SELECT id, email, nickname FROM users WHERE id = $1',
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