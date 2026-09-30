// server.js
// 이 프로젝트의 진입점(entry point)입니다.
// "node server.js"로 실행하면 이 파일부터 시작해서 서버가 켜집니다.

// 1. 필요한 모듈 불러오기
require('dotenv').config(); // .env 파일의 값을 process.env로 읽어올 수 있게 함
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const db = require('./db'); // 방금 만든 db.js를 불러옴

// 2. express 앱 생성
const app = express();

// Render 같은 서비스는 요청이 프록시를 한 번 거쳐서 들어오기 때문에, 이 설정이 없으면
// express-rate-limit이 모든 요청을 "프록시 서버 IP 하나"로 착각해서 한 사람이 실수해도
// 전체 사용자가 같이 차단될 수 있습니다. 이 값을 켜야 실제 접속자의 IP를 구분합니다.
app.set('trust proxy', 1);

// 3. 미들웨어 설정
// 미들웨어란 요청(request)이 실제 처리되기 전에 거치는 중간 단계입니다.
app.use(cors()); // 다른 주소(프론트엔드)에서 오는 요청을 허용
app.use(express.json({ limit: '10kb' })); // 요청 body를 JSON으로 자동 해석. 크기를 제한해서 일부러 거대한
                                           // body를 보내 서버 메모리/CPU를 소모시키는 공격을 막습니다.

// 모든 API에 적용되는 기본 방어선. IP 하나가 짧은 시간에 너무 많은 요청을 보내는 걸 막습니다.
// (로그인/가입은 이보다 더 엄격한 자체 제한이 routes/auth.js에 따로 있습니다.)
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1분
  max: 120,            // 같은 IP에서 분당 120회까지
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
});
app.use(globalLimiter);

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

// 골드/아이템 계산은 전부 서버가 하고 있어서 값 자체를 조작당할 위험은 없지만,
// 초당 수십~수백 번씩 스크립트로 두드리는 건 서버 부하와 DB 커넥션을 불필요하게 소모시키므로 별도로 더 제한합니다.
const boxLimiter = rateLimit({
  windowMs: 60 * 1000, // 1분
  max: 60,             // 같은 IP에서 분당 60회까지 (초당 1회꼴 - 정상적인 클릭 플레이로는 충분한 수치)
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
});

const boxRoutes = require('./routes/box');
app.use('/api/box', boxLimiter, boxRoutes);

// 6. 서버 실행
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] 서버가 포트 ${PORT} 에서 실행 중입니다`);
});