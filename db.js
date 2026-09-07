// db.js
// PostgreSQL과의 연결을 담당하는 파일입니다.
// 다른 파일들(routes/auth.js, routes/box.js 등)에서는 이 파일을 불러와서
// db.query(...) 형태로 SQL을 실행하게 됩니다.

const { Pool } = require('pg');
require('dotenv').config();

// Pool은 DB 연결을 여러 개 미리 만들어두고 재사용하는 방식입니다.
// 매번 새로 연결하는 것보다 훨씬 효율적입니다.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    // Neon 같은 클라우드 DB는 SSL 연결이 필수인 경우가 많습니다.
    // 로컬 PostgreSQL을 쓰는 경우 이 옵션 때문에 에러가 나면
    // ssl 옵션 자체를 지우고 다시 시도해보세요.
    rejectUnauthorized: false,
  },
});

// 연결이 잘 되는지 서버 시작 시 한 번 확인합니다.
pool.connect((err, client, release) => {
  if (err) {
    console.error('데이터베이스 연결 실패:', err.stack);
    return;
  }
  console.log('데이터베이스 연결 성공');
  release(); // 확인용으로 잠깐 빌린 연결을 다시 반납
});

// 다른 파일에서 db.query('SELECT ...') 형태로 쓸 수 있도록 내보냅니다.
module.exports = {
  query: (text, params) => pool.query(text, params),
};