-- 주간 시즌 · 신화 도감(계정 전체 영구 기록)
-- 여러 번 실행해도 안전합니다 (IF NOT EXISTS / ON CONFLICT DO NOTHING).

-- 세이브마다 "마지막으로 적용된 시즌". 지금 세이브들은 시즌 2 진행 중이므로 기본값 2.
-- 시즌이 바뀐 뒤 처음 정산할 때 서버가 새 시즌을 적용하고 이 값을 올립니다. (game/store.js applyNewSeason)
ALTER TABLE box_claims
  ADD COLUMN IF NOT EXISTS season INT NOT NULL DEFAULT 2;

-- 신화 도감: 한 번이라도 얻은 신화. 모드·환생·시즌 초기화와 상관없이 영구히 남습니다.
CREATE TABLE IF NOT EXISTS mythic_codex (
  user_id INT NOT NULL REFERENCES users(id),
  item_key VARCHAR(50) NOT NULL,
  first_obtained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  season INT,
  PRIMARY KEY (user_id, item_key)
);

-- 이미 신화(기존 4종)를 얻었던 기록을 신화 도감으로 옮깁니다.
INSERT INTO mythic_codex (user_id, item_key, first_obtained_at, season)
SELECT user_id, item_key, MIN(found_at), 2
FROM (
  SELECT user_id, item_key, COALESCE(first_discovered_at, NOW()) AS found_at FROM user_discoveries
  UNION ALL
  SELECT user_id, item_key, COALESCE(first_obtained_at, NOW()) FROM user_items WHERE count > 0
) t
WHERE item_key IN ('astral_compass', 'ancient_crown', 'galaxy_orb', 'dragon_pearl')
GROUP BY user_id, item_key
ON CONFLICT (user_id, item_key) DO NOTHING;
