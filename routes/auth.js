// routes/auth.js
// 회원가입(signup)과 로그인(login) API를 담당하는 파일입니다.

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();

// -------------------------------
// 회원가입: POST /api/auth/signup
// -------------------------------
// 프론트엔드에서 이렇게 요청을 보낼 겁니다:
// { "email": "test@test.com", "password": "1234", "nickname": "홍길동" }
router.post('/signup', async (req, res) => {
  const { email, password, nickname } = req.body;

  // 1. 입력값 검증 (없으면 바로 에러 응답)
  if (!email || !password || !nickname) {
    return res.status(400).json({ message: '이메일, 비밀번호, 닉네임을 모두 입력해주세요.' });
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

    // 5. 회원가입과 동시에 로그인 토큰도 바로 발급 (선택사항이지만 편리함)
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

module.exports = router;