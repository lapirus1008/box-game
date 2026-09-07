// middleware/auth.js
// 로그인이 필요한 API(예: 상자 열기)에서 공통으로 쓸 "토큰 검증" 미들웨어입니다.
// 요청 헤더에 담긴 JWT 토큰을 확인해서, 유효하면 req.user에 사용자 정보를 넣어줍니다.

const jwt = require('jsonwebtoken');

function verifyToken(req, res, next) {
  // 프론트엔드는 요청 헤더에 이렇게 담아서 보내야 합니다:
  // Authorization: Bearer <토큰값>
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: '로그인이 필요합니다.' });
  }

  const token = authHeader.split(' ')[1]; // "Bearer 토큰값" 에서 토큰값만 추출

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { userId, email } 형태로 다음 라우트에서 사용 가능
    next(); // 검증 통과 → 다음 로직(실제 라우트 핸들러)으로 진행
  } catch (err) {
    return res.status(401).json({ message: '토큰이 유효하지 않거나 만료되었습니다.' });
  }
}

module.exports = verifyToken;