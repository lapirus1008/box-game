// server.js
// 이 프로젝트의 진입점(entry point)입니다.
// "node server.js"로 실행하면 이 파일부터 시작해서 서버가 켜집니다.

// 1. 필요한 모듈 불러오기
require('dotenv').config(); // .env 파일의 값을 process.env로 읽어올 수 있게 함
const express = require('express');
const cors = require('cors');
const db = require('./db'); // 방금 만든 db.js를 불러옴

// 2. express 앱 생성
const app = express();

// 3. 미들웨어 설정
// 미들웨어란 요청(request)이 실제 처리되기 전에 거치는 중간 단계입니다.
app.use(cors()); // 다른 주소(프론트엔드)에서 오는 요청을 허용
app.use(express.json()); // 요청 body를 JSON으로 자동 해석 (회원가입 시 이메일/비번 등을 받을 때 필요)

// 4. 기본 상태 확인용 라우트
// 브라우저에서 http://localhost:3000/health 로 접속하면 이 코드가 실행됩니다.
app.get('/health', async (req, res) => {
  try {
    // DB에도 실제로 잘 연결되는지 간단한 쿼리로 확인
    const result = await db.query('SELECT NOW()');
    res.json({
      status: 'ok',
      serverTime: new Date(),
      dbTime: result.rows[0].now,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: 'DB 연결에 실패했습니다.' });
  }
});

// 5. 라우트 연결
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

const boxRoutes = require('./routes/box');
app.use('/api/box', boxRoutes);

// 6. 서버 실행
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다`);
});