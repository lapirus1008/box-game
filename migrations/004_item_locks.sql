-- 아이템 잠금: 잠근 아이템은 합성 재료로 쓰이지 않습니다. (모드별, 환생해도 유지)
ALTER TABLE box_claims
  ADD COLUMN IF NOT EXISTS locked_items JSONB NOT NULL DEFAULT '[]'::jsonb;
