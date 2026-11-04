// lib/migrate.js
// 서버가 켜질 때 migrations/ 폴더의 SQL 파일을 이름 순서대로 실행합니다.
// 모든 SQL은 여러 번 실행해도 안전하게(IF NOT EXISTS 등) 작성해야 합니다.
// 덕분에 새 기능을 배포할 때 Neon 콘솔에서 SQL을 따로 실행하지 않아도 됩니다.

const fs = require('fs');
const path = require('path');
const db = require('../db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function runMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await db.query(sql);
    } catch (err) {
      // 어느 파일에서 멈췄는지 알아야 Neon 콘솔에서 그 파일부터 직접 실행할 수 있습니다.
      err.message = `${file} 실행 중 오류: ${err.message}`;
      err.migrationFile = file;
      throw err;
    }
    console.log(`[MIGRATE] ${file} 적용 완료`);
  }
}

// 게임 테이블에 걸린 CHECK 제약을 서버 시작 때 로그로 남깁니다.
// 운영 DB에는 migrations 밖에서 직접 만든 제약(예: 예전 box_charges 0~100 제한)이 있을 수 있어서,
// 저장이 거부되는 500 오류가 나면 Render 로그에서 바로 어떤 제약인지 비교할 수 있게 합니다.
const CHECKED_TABLES = ['users', 'box_claims', 'user_items', 'user_discoveries', 'rebirth_history'];
async function logSchemaChecks() {
  const result = await db.query(
    `SELECT rel.relname AS table_name, con.conname AS name, pg_get_constraintdef(con.oid) AS def
     FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE con.contype = 'c' AND rel.relname = ANY($1::text[])
     ORDER BY rel.relname, con.conname`,
    [CHECKED_TABLES]
  );
  if (result.rows.length === 0) {
    console.log('[DB] 게임 테이블 CHECK 제약: 없음');
    return;
  }
  for (const row of result.rows) {
    console.log(`[DB] CHECK 제약 ${row.table_name}.${row.name}: ${row.def}`);
  }
}

module.exports = { runMigrations, logSchemaChecks };
