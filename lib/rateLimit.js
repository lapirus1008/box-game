// lib/rateLimit.js
// 같은 IP에서 짧은 시간에 너무 많은 요청을 보내는 것을 막는 limiter를 만드는 공용 함수입니다.
// Render 등 프록시 뒤에서 실제 클라이언트 IP를 인식하려면 server.js에 app.set('trust proxy', 1)이 필요합니다.

const rateLimit = require('express-rate-limit');

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

module.exports = { createLimiter };
