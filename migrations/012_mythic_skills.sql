-- 신화 스킬 (game/skills.js)
-- skill_cooldowns: 스킬별 다시 쓸 수 있는 시각 { "incomePercent": "2026-10-26T12:00:00Z", ... }
-- skill_buffs: 시간제·1회성 스킬 효과 { luckUntil, luckValue, discountUntil, discountValue, upgradeDiscount }
ALTER TABLE box_claims
  ADD COLUMN IF NOT EXISTS skill_cooldowns JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS skill_buffs JSONB NOT NULL DEFAULT '{}'::jsonb;
