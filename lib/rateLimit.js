// lib/rateLimit.js
// 같은 IP에서 짧은 시간에 너무 많은 요청을 보내는 것을 막는 limiter를 만드는 공용 함수입니다.
// Render 등 프록시 뒤에서 실제 클라이언트 IP를 인식하려면 server.js에 app.set('trust proxy', 1)이 필요합니다.

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { verifyTokenString } = require('./token');

function createLimiter({ windowMs, max, message = '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.', ...rest }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message },
    ...rest,
  });
}

// 로그인한 요청은 계정마다, 아니면 IP마다 셉니다.
// 모바일 통신망·같은 와이파이는 여러 사람이 IP 하나를 같이 쓰기 때문에, IP로만 세면
// 남의 요청 때문에 내 게임이 막힐 수 있습니다.
function userOrIpKey(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) {
    try {
      const payload = verifyTokenString(header.slice(7));
      if (payload && payload.userId) return `user:${payload.userId}`;
    } catch (err) {
      // 잘못된 토큰은 IP로 셉니다
    }
  }
  return ipKeyGenerator(req.ip);
}

module.exports = { createLimiter, userOrIpKey };
