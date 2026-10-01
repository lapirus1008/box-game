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
    await db.query(sql);
    console.log(`[MIGRATE] ${file} 적용 완료`);
  }
}

module.exports = { runMigrations };
