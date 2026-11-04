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
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // ROLLBACK마저 실패한 연결은 상태를 믿을 수 없으니 풀에 돌려놓지 않고 버립니다.
    broken = await client.query('ROLLBACK').then(() => false, () => true);
    throw err;
  } finally {
    client.release(broken);
  }
}

// 같은 계정의 트랜잭션을 서버 안에서 하나씩 차례로 실행합니다.
// 같은 세이브를 FOR UPDATE로 잠그는 요청이 동시에 여러 개 오면, 기다리는 요청마다 DB 연결을 하나씩
// 붙잡고 있게 됩니다. 연결 풀(10개)이 바닥나면 다른 계정까지 "연결 대기 시간 초과"로 500이 났습니다.
// 여기서 먼저 줄을 세우면 기다리는 동안 DB 연결을 쓰지 않습니다. (Render 서버 한 대 기준)
const userQueues = new Map();
function withUserTransaction(userId, fn) {
  const previous = userQueues.get(userId) || Promise.resolve();
  const run = previous.then(() => withTransaction(fn));
  const tail = run.catch(() => {});
  userQueues.set(userId, tail);
  tail.then(() => { if (userQueues.get(userId) === tail) userQueues.delete(userId); });
  return run;
}

// PostgreSQL 오류에서 원인을 알 수 있는 정보만 한 줄로 모읍니다.
// (어떤 제약에 걸렸는지, 어느 테이블·컬럼인지 → Render 로그만 보고 원인을 찾을 수 있게)
function describeError(err) {
  if (!err) return String(err);
  const parts = [err.message];
  if (err.code) parts.push(`code=${err.code}`);
  for (const key of ['constraint', 'table', 'column', 'hint']) {
    if (err[key]) parts.push(`${key}=${err[key]}`);
  }
  // detail에는 저장하려던 행 전체가 들어 있어 길고, users 테이블이면 이메일·비밀번호 해시가 섞일 수 있어 뺍니다.
  if (err.detail && err.table !== 'users') parts.push(`detail=${String(err.detail).slice(0, 300)}`);
  // 연결을 못 얻은 경우: 연결 풀 상태를 같이 남겨서 "몰려서 막힌 것"인지 바로 알 수 있게 합니다.
  if (/timeout|Connection terminated/i.test(err.message || '')) {
    const p = db.poolStats();
    parts.push(`pool(total=${p.total} idle=${p.idle} waiting=${p.waiting})`);
  }
  return parts.join(' · ');
}

// 요청 정보(어느 API, 어느 계정)와 오류 원인을 한 줄 머리말로 남기고, 그 아래 위치(stack)를 붙입니다.
function logRequestError(req, err, label = '[API 500]') {
  const user = req.user && req.user.userId ? `user=${req.user.userId}` : 'user=-';
  const stack = err && err.stack ? `\n${err.stack.split('\n').slice(1, 6).join('\n')}` : '';
  console.error(`${label} ${req.method} ${req.originalUrl} ${user} · ${describeError(err)}${stack}`);
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
      logRequestError(req, err);
      if (!res.headersSent) res.status(500).json({ message: fallbackMessage });
    }
  };
}

module.exports = { HttpError, withTransaction, withUserTransaction, handle, describeError, logRequestError };
