// lib/token.js
// JWT 로그인 토큰 발급/검증을 한곳에서 처리합니다.

const jwt = require('jsonwebtoken');

const TOKEN_ALGORITHM = 'HS256';
const TOKEN_EXPIRES_IN = '7d'; // 토큰 유효기간 7일

function signToken(user) {
  return jwt.sign(
    { userId: user.id, email: user.email },
    process.env.JWT_SECRET,
    { algorithm: TOKEN_ALGORITHM, expiresIn: TOKEN_EXPIRES_IN }
  );
}

// 허용할 서명 알고리즘을 명시적으로 고정합니다. (alg 변조/none 공격 방어)
function verifyTokenString(token) {
  return jwt.verify(token, process.env.JWT_SECRET, { algorithms: [TOKEN_ALGORITHM] });
}

module.exports = { signToken, verifyTokenString };
