// lib/http.js
// 라우트 핸들러에서 반복되는 "트랜잭션 열기/닫기"와 "에러 응답" 코드를 한곳에 모았습니다.

const db = require('../db');

// 사용자에게 그대로 보여줄 에러(400, 409 등)를 던질 때 사용합니다.
// extra에 넣은 값은 응답 JSON에 message와 함께 실려 나갑니다.
class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// fn(client)를 하나의 트랜잭션 안에서 실행합니다.
// 정상 종료 → COMMIT, 에러(HttpError 포함) → ROLLBACK. 커넥션은 항상 반납됩니다.
async function withTransaction(fn) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// 라우트 핸들러를 감싸서, 반환값은 JSON으로 응답하고 에러는 알맞은 상태코드로 응답합니다.
// - HttpError: 지정한 상태코드 + 메시지
// - 그 외 예상치 못한 에러: 로그를 남기고 500 + fallbackMessage
function handle(fallbackMessage, fn) {
  return async (req, res) => {
    try {
      const body = await fn(req, res);
      if (body !== undefined && !res.headersSent) res.json(body);
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).json({ message: err.message, ...err.extra });
      }
      console.error(err);
      res.status(500).json({ message: fallbackMessage });
    }
  };
}

module.exports = { HttpError, withTransaction, handle };
