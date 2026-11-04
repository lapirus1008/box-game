-- 상자 강화(+0~+20)와 초월 (game/transcend.js)
-- box_enhance: 수집모드 세이브의 상자 강화 단계 (초월하면 0으로)
-- transcend_count: 계정의 초월 횟수 (영구, 랭킹·방명록·광장에서 이름 옆에 표시)
ALTER TABLE box_claims
  ADD COLUMN IF NOT EXISTS box_enhance INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS transcend_count INTEGER NOT NULL DEFAULT 0;
