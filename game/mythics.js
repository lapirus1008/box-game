// game/mythics.js
// 신화 아이템 100종 목록입니다.
//
// [구성]
// - 25가지 "모양(motif)" × 4가지 "테마" = 100종.
// - 같은 모양은 같은 효과를 가지고, 수치(1~4단계)만 다릅니다. (예: 왕관은 모두 '행운', 단계에 따라 +2~5%)
//   그래서 효과 종류는 9가지뿐이지만, 어떤 신화를 얼마나 모았는지에 따라 조합이 달라집니다.
// - 매주 시즌마다 10종씩만 상자에서 나옵니다. (rotation 0~9, game/season.js 참고)
//   10주 동안 매주 열심히 하면 100종 신화 도감을 모두 채울 수 있습니다.
//
// [주의] key는 DB(user_items, user_discoveries)에 저장되는 고유 식별자라 절대 바꾸면 안 됩니다.
// 이름·설명·테마는 바꿔도 괜찮습니다. 아이콘은 scripts/generate-icons.js 로 다시 만듭니다.

// 효과 종류별 단계 수치 (1개당). 단계는 아래 MOTIFS 순서로 자동으로 정해집니다.
const MYTHIC_EFFECT_TIERS = {
  incomePercent:    [5, 8, 12, 15],    // 전체 수입 +%
  luck:             [2, 3, 4, 5],      // 희귀 이상 등장률 +%
  golden:           [10, 15, 20, 25],  // 황금 상자 보상 +%
  boxDiscount:      [2, 3, 4, 5],      // 상자 구매가 -%
  pity:             [50, 80, 120, 150],// 신화 천장 -개
  storageMinutes:   [15, 20, 30, 40],  // 보관 시간 +분
  upgradeDiscount:  [3, 4, 5, 6],      // 강화 비용 -%
  autoOpenDiscount: [5, 8, 10, 12],    // 자동 개봉 시간 가격 -%
  chargeSpeed:      [2, 3, 4, 5],      // 충전 속도 +% (충전 시간 단축)
};
// 같은 신화는 이 개수까지만 효과가 겹칩니다. (그 이상은 수입만 늘어남)
const MYTHIC_EFFECT_STACK = 3;

// motif: 아이콘 모양 / effect: 효과 종류 / emoji: 글자로 보여줄 때 쓰는 대표 이모지
// variants: [key, 이름, 테마(아이콘 색), 설명] × 4
const MOTIFS = [
  { motif: 'compass', effect: 'incomePercent', emoji: '🧭', variants: [
    ['frost_compass',   '서리 별의 나침반', 'frost',   '얼어붙은 바늘이 오로라가 뜨는 곳을 가리킨다.'],
    ['flame_compass',   '불꽃 사막의 나침반', 'flame', '뜨거운 모래 속에 묻힌 보물만 가리킨다.'],
    ['verdant_compass', '세계수의 나침반', 'verdant',  '뿌리가 닿는 모든 땅의 풍요를 알고 있다.'],
    ['astral_compass',  '천체의 나침반', 'galaxy',     '전설조차 가리키지 못하는 곳을 가리킨다는, 전해지기만 하던 나침반.'],
  ] },
  { motif: 'crown', effect: 'luck', emoji: '👑', variants: [
    ['frost_crown',   '서리 여왕의 왕관', 'frost',  '차가운 위엄 앞에서는 행운도 무릎을 꿇는다.'],
    ['flame_crown',   '화염 제왕의 왕관', 'flame',  '불길 속에서 단련된 왕의 운명이 깃들었다.'],
    ['ancient_crown', '고대 왕의 왕관', 'gold',     '이 왕관을 쓴 자의 손에는 언제나 귀한 것만 쥐어졌다고 한다.'],
    ['abyss_crown',   '심연 군주의 왕관', 'abyss',  '어둠 속에서도 귀한 것만은 반짝인다.'],
  ] },
  { motif: 'orb', effect: 'golden', emoji: '🔮', variants: [
    ['storm_orb',   '뇌운의 구슬', 'storm',     '번쩍이는 순간 황금빛이 쏟아진다.'],
    ['galaxy_orb',  '은하의 구슬', 'galaxy',    '들여다보면 별들이 소용돌이친다. 황금빛 행운을 끌어당긴다.'],
    ['tide_orb',    '심해의 구슬', 'tide',      '깊은 바다 밑 황금 난파선을 비춘다.'],
    ['verdant_orb', '숲 정령의 구슬', 'verdant', '정령들이 반짝이는 선물을 숨겨둔다.'],
  ] },
  { motif: 'pearl', effect: 'boxDiscount', emoji: '🐲', variants: [
    ['dragon_pearl',  '용왕의 여의주', 'tide',       '바라는 것을 이루어 준다는 용왕의 구슬. 값을 깎는 데도 쓸모가 있다.'],
    ['frost_pearl',   '설산의 진주', 'frost',        '눈 속에서 자란 진주. 값을 얼려버린다.'],
    ['blossom_pearl', '벚꽃 인어의 진주', 'blossom', '인어의 노래를 들으면 상인들도 값을 깎아준다.'],
    ['shadow_pearl',  '그림자 진주', 'shadow',       '보는 이마다 원래 값을 잊어버린다.'],
  ] },
  { motif: 'star', effect: 'pity', emoji: '🌟', variants: [
    ['gold_star',    '새벽별', 'gold',             '가장 먼저 떠서 가장 늦게 진다.'],
    ['abyss_star',   '잠든 별의 심장', 'abyss',    '언젠가 반드시 깨어날 운명을 품었다.'],
    ['frost_star',   '북극성 조각', 'frost',       '길 잃은 자를 반드시 신화로 이끈다.'],
    ['blossom_star', '유성우의 결정', 'blossom',   '소원을 빌 틈도 없이 행운이 쏟아진다.'],
  ] },
  { motif: 'hourglass', effect: 'storageMinutes', emoji: '⌛', variants: [
    ['galaxy_hourglass', '영겁의 모래시계', 'galaxy', '모래 한 알 한 알이 별빛으로 되어 있다.'],
    ['gold_hourglass',   '황금 모래시계', 'gold',     '떨어지는 모래마다 시간이 금이 된다.'],
    ['frost_hourglass',  '얼어붙은 시간', 'frost',    '모래가 멈춘 채 반짝이고 있다.'],
    ['abyss_hourglass',  '망각의 모래시계', 'abyss',  '흘러가 버린 시간을 다시 담아둔다.'],
  ] },
  { motif: 'hammer', effect: 'upgradeDiscount', emoji: '🔨', variants: [
    ['storm_hammer', '천둥 신의 망치', 'storm',     '한 번 내리치면 쇠가 저절로 단련된다.'],
    ['flame_hammer', '대장장이 신의 망치', 'flame', '용광로보다 뜨겁게 달아올라 있다.'],
    ['frost_hammer', '서리 거인의 망치', 'frost',   '얼음 위에 새긴 룬이 푸르게 빛난다.'],
    ['gold_hammer',  '드워프 왕의 망치', 'gold',    '드워프 왕국의 모든 비법이 깃들었다.'],
  ] },
  { motif: 'feather', effect: 'chargeSpeed', emoji: '🪶', variants: [
    ['flame_feather',   '주작의 깃털', 'flame',     '타오르는 날갯짓이 시간을 재촉한다.'],
    ['storm_feather',   '뇌조의 깃털', 'storm',     '번개보다 빠르게 상자가 채워진다.'],
    ['blossom_feather', '극락조의 깃털', 'blossom', '춤추듯 흔들리며 바람을 부른다.'],
    ['galaxy_feather',  '은하새의 깃털', 'galaxy',  '별 사이를 나는 새가 떨어뜨렸다.'],
  ] },
  { motif: 'key', effect: 'autoOpenDiscount', emoji: '🗝️', variants: [
    ['gold_key',    '만능 황금 열쇠', 'gold',     '어떤 상자든 저절로 열린다.'],
    ['abyss_key',   '심연의 열쇠', 'abyss',       '닫힌 시간마저 열어버린다.'],
    ['verdant_key', '덩굴 열쇠', 'verdant',       '자라나는 덩굴이 자물쇠를 풀어준다.'],
    ['frost_key',   '얼음 궁전의 열쇠', 'frost',  '잠든 궁전의 모든 문을 연다.'],
  ] },
  { motif: 'chalice', effect: 'incomePercent', emoji: '🏆', variants: [
    ['blossom_chalice', '봄의 성배', 'blossom',   '마르지 않는 꽃잎 술이 흘러넘친다.'],
    ['gold_chalice',    '영원의 성배', 'gold',    '마시는 자의 금고는 마르지 않는다.'],
    ['shadow_chalice',  '밤의 성배', 'shadow',    '어둠 속에서도 수입은 차오른다.'],
    ['flame_chalice',   '불사조의 성배', 'flame', '재 속에서 다시 금빛으로 끓어오른다.'],
  ] },
  { motif: 'dice', effect: 'luck', emoji: '🎲', variants: [
    ['verdant_dice', '요정의 주사위', 'verdant',     '언제나 원하는 눈이 나온다는 소문이 있다.'],
    ['abyss_dice',   '운명의 주사위', 'abyss',       '던지기 전부터 이미 결과를 알고 있다.'],
    ['gold_dice',    '황금 도박사의 주사위', 'gold', '이 주사위의 주인은 한 번도 진 적이 없다.'],
    ['storm_dice',   '번개 주사위', 'storm',         '굴러가는 소리가 천둥처럼 울린다.'],
  ] },
  { motif: 'bell', effect: 'golden', emoji: '🔔', variants: [
    ['frost_bell',   '수정 종', 'frost',        '맑은 소리를 따라 황금 상자가 모여든다.'],
    ['verdant_bell', '은방울꽃 종', 'verdant',  '숲속 요정들이 선물을 들고 찾아온다.'],
    ['flame_bell',   '축제의 종', 'flame',      '울릴 때마다 축제가 시작된다.'],
    ['gold_bell',    '대성당의 금종', 'gold',   '천 년 동안 축복만 울려 퍼졌다.'],
  ] },
  { motif: 'ring', effect: 'boxDiscount', emoji: '💍', variants: [
    ['shadow_ring', '상인왕의 인장 반지', 'shadow', '이 반지를 보면 상인들이 알아서 값을 내린다.'],
    ['tide_ring',   '파도의 반지', 'tide',          '밀물이 빠지듯 값이 빠져나간다.'],
    ['frost_ring',  '서리꽃 반지', 'frost',         '차가운 눈빛 한 번에 흥정이 끝난다.'],
    ['galaxy_ring', '성운의 반지', 'galaxy',        '우주의 모든 시장에서 통하는 반지.'],
  ] },
  { motif: 'eye', effect: 'pity', emoji: '👁️', variants: [
    ['abyss_eye',   '심연의 눈', 'abyss',     '아직 오지 않은 신화를 바라보고 있다.'],
    ['gold_eye',    '예언자의 눈', 'gold',    '다음 신화가 언제 오는지 알고 있다.'],
    ['verdant_eye', '고목의 눈', 'verdant',   '천 년을 지켜보며 때를 기다렸다.'],
    ['storm_eye',   '폭풍의 눈', 'storm',     '고요한 중심에서 운명이 소용돌이친다.'],
  ] },
  { motif: 'chest', effect: 'storageMinutes', emoji: '🧰', variants: [
    ['tide_chest',    '해적왕의 보물함', 'tide',        '바닷물이 스며들지 않는 비밀 상자.'],
    ['shadow_chest',  '미믹의 보물함', 'shadow',        '가끔 혼자 입맛을 다신다.'],
    ['gold_chest',    '용의 보물함', 'gold',            '용이 평생 모은 것을 지키고 있다.'],
    ['blossom_chest', '요정 여왕의 보물함', 'blossom',  '작아 보이지만 무엇이든 들어간다.'],
  ] },
  { motif: 'book', effect: 'upgradeDiscount', emoji: '📖', variants: [
    ['galaxy_book',  '별자리 마법서', 'galaxy',    '강화의 비밀이 별자리로 적혀 있다.'],
    ['shadow_book',  '금지된 마법서', 'shadow',    '읽으면 강화 비용이 스르르 사라진다.'],
    ['flame_book',   '연금술사의 비서', 'flame',   '돌을 금으로 바꾸는 법이 적혀 있다.'],
    ['verdant_book', '대현자의 책', 'verdant',     '세상 모든 장인의 지혜를 담았다.'],
  ] },
  { motif: 'wing', effect: 'chargeSpeed', emoji: '🪽', variants: [
    ['frost_wing',  '설원 천마의 날개', 'frost',   '눈보라보다 빠르게 달린다.'],
    ['galaxy_wing', '천사의 날개', 'galaxy',       '깃털 하나에 별빛이 하나씩 깃들었다.'],
    ['shadow_wing', '밤까마귀의 날개', 'shadow',   '어둠을 가르는 소리 없는 날갯짓.'],
    ['flame_wing',  '피닉스의 날개', 'flame',      '꺼지지 않는 불꽃이 시간을 앞당긴다.'],
  ] },
  { motif: 'lantern', effect: 'autoOpenDiscount', emoji: '🏮', variants: [
    ['blossom_lantern', '소원 연등', 'blossom',         '소원을 담아 띄우면 상자가 저절로 열린다.'],
    ['flame_lantern',   '도깨비불 등불', 'flame',       '밤새도록 혼자서 상자를 열어준다.'],
    ['tide_lantern',    '등대지기의 등불', 'tide',      '꺼지지 않고 밤바다를 지킨다.'],
    ['storm_lantern',   '번개를 담은 등불', 'storm',    '갇힌 번개가 쉬지 않고 일한다.'],
  ] },
  { motif: 'coin', effect: 'incomePercent', emoji: '🪙', variants: [
    ['abyss_coin', '저승 뱃사공의 동전', 'abyss', '강을 건너간 자들의 재산이 흘러든다.'],
    ['tide_coin',  '아틀란티스 금화', 'tide',     '가라앉은 왕국의 부가 깃들었다.'],
    ['storm_coin', '번개 금화', 'storm',          '만질 때마다 찌릿하게 이자가 붙는다.'],
    ['gold_coin',  '미다스의 금화', 'gold',       '닿는 모든 것이 금이 된다.'],
  ] },
  { motif: 'clover', effect: 'luck', emoji: '🍀', variants: [
    ['gold_clover',    '황금 네잎클로버', 'gold',   '천만 개 중 하나뿐인 황금 잎.'],
    ['frost_clover',   '서리 클로버', 'frost',      '한겨울에도 시들지 않는 행운.'],
    ['galaxy_clover',  '별빛 클로버', 'galaxy',     '잎맥을 따라 은하가 흐른다.'],
    ['verdant_clover', '일곱잎 클로버', 'verdant',  '전설보다 귀한 일곱 장의 잎.'],
  ] },
  { motif: 'sun', effect: 'golden', emoji: '☀️', variants: [
    ['flame_sun',   '태양신의 원반', 'flame',   '새벽마다 황금빛을 쏟아낸다.'],
    ['blossom_sun', '노을의 원반', 'blossom',   '하루의 끝에 찾아오는 선물.'],
    ['storm_sun',   '일식의 원반', 'storm',     '어둠과 빛이 겹칠 때 기적이 일어난다.'],
    ['tide_sun',    '해돋이 원반', 'tide',      '바다 위로 떠오르는 첫 빛을 담았다.'],
  ] },
  { motif: 'mirror', effect: 'boxDiscount', emoji: '🪞', variants: [
    ['galaxy_mirror',  '차원 거울', 'galaxy',       '거울 속 상점은 언제나 할인 중.'],
    ['blossom_mirror', '공주의 손거울', 'blossom',  '비춰 보면 어떤 값도 예뻐 보인다.'],
    ['abyss_mirror',   '진실의 거울', 'abyss',      '부풀려진 값을 꿰뚫어 본다.'],
    ['gold_mirror',    '태양 거울', 'gold',         '비친 금화가 두 배로 보인다.'],
  ] },
  { motif: 'moon', effect: 'pity', emoji: '🌙', variants: [
    ['shadow_moon',  '그믐달 조각', 'shadow',    '가장 어두운 밤 끝에 신화가 온다.'],
    ['frost_moon',   '은빛 보름달', 'frost',     '가득 찬 달이 운명을 끌어당긴다.'],
    ['flame_moon',   '붉은 달', 'flame',         '핏빛 달이 뜨면 신화가 깨어난다.'],
    ['blossom_moon', '선녀의 초승달', 'blossom', '선녀가 떨어뜨린 달 조각.'],
  ] },
  { motif: 'shield', effect: 'storageMinutes', emoji: '🛡️', variants: [
    ['verdant_shield', '세계수 방패', 'verdant',  '뿌리처럼 단단하게 시간을 붙든다.'],
    ['storm_shield',   '뇌신의 방패', 'storm',    '번개조차 뚫지 못한다.'],
    ['tide_shield',    '해신의 방패', 'tide',     '밀려오는 시간을 막아선다.'],
    ['abyss_shield',   '공허의 방패', 'abyss',    '모든 것을 집어삼켜 보관한다.'],
  ] },
  { motif: 'sword', effect: 'upgradeDiscount', emoji: '🗡️', variants: [
    ['blossom_sword', '벚꽃검', 'blossom',      '흩날리는 꽃잎처럼 가볍게 벤다.'],
    ['verdant_sword', '엘프 왕의 검', 'verdant', '더 강화할 필요가 없을 만큼 완벽하다.'],
    ['galaxy_sword',  '별을 벤 검', 'galaxy',    '하늘을 가른 흔적이 아직 남아 있다.'],
    ['storm_sword',   '뇌광검', 'storm',         '휘두르는 순간 대장간이 고요해진다.'],
  ] },
];

// 원래 있던 신화 4종은 이모지를 그대로 씁니다.
const LEGACY_EMOJI = { astral_compass: '🧭', ancient_crown: '👑', galaxy_orb: '🌌', dragon_pearl: '🐲' };

// 시즌마다 나오는 신화 10종: v(테마 순서) → 모양 순서로 한 줄로 세운 뒤 10개씩 끊습니다.
// 10개가 연속된 모양이라 한 시즌 안에서 모양(=효과)이 겹치지 않고,
// 단계는 (v + 모양 번호) % 4 로 섞여서 매주 강한 것과 약한 것이 고루 나옵니다.
const MYTHIC_WEIGHT = 0.002; // 시즌 신화 10종 합계 0.02 (이전 신화 확률과 같음)
const ROTATION_SIZE = 10;

const MYTHICS = [];
for (let v = 0; v < 4; v++) {
  MOTIFS.forEach((m, motifIndex) => {
    const [key, name, theme, flavor] = m.variants[v];
    const tier = ((v + motifIndex) % 4) + 1;
    const order = MYTHICS.length;
    MYTHICS.push({
      key,
      name,
      rarity: 'mythic',
      emoji: LEGACY_EMOJI[key] || m.emoji,
      amount: 5000,
      weight: MYTHIC_WEIGHT,
      flavor,
      motif: m.motif,
      theme,
      tier,
      rotation: Math.floor(order / ROTATION_SIZE),
      effect: { type: m.effect, perItem: MYTHIC_EFFECT_TIERS[m.effect][tier - 1] },
    });
  });
}

const ROTATION_COUNT = Math.ceil(MYTHICS.length / ROTATION_SIZE);

module.exports = {
  MYTHICS,
  MYTHIC_EFFECT_TIERS,
  MYTHIC_EFFECT_STACK,
  ROTATION_SIZE,
  ROTATION_COUNT,
};
