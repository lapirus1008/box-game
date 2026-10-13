// scripts/generate-icons.js
// 모든 아이템의 아이콘(SVG)을 만듭니다.  실행: node scripts/generate-icons.js
//
// - 신화는 "모양(motif) × 테마(색)"로 그립니다. 같은 모양은 같은 그림에 색만 달라서,
//   아이콘만 봐도 어떤 효과의 신화인지 알 수 있습니다. (game/mythics.js 의 motif / theme)
// - 일반~전설 아이템은 아래 NORMAL_ICONS 에서 하나씩 지정합니다.
// - 결과: public/icons/items/<아이템 key>.svg  (화면에서는 <img src="icons/items/key.svg"> 로 사용)
// 아이템을 추가하거나 테마 색을 바꾼 뒤에는 이 스크립트를 다시 실행하면 됩니다.

const fs = require('fs');
const path = require('path');
const { TREASURES } = require('../game/config');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons', 'items');
const O = '#1c1631'; // 외곽선 색 (모든 아이콘 공통)

// -------------------------------
// 색 도우미
// -------------------------------
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a, b, t) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return '#' + ca.map((v, i) => Math.round(v + (cb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

// 테마 팔레트: l(밝은색) m(기본색) d(어두운색) a(포인트 보석색) metal(장식 금속)
const PALETTES = {
  gold:    { l: '#fff3b0', m: '#f2c230', d: '#9a640a', a: '#e8364f', metal: 'silver' },
  frost:   { l: '#effdff', m: '#8fdcf5', d: '#2c74b0', a: '#4d6bff', metal: 'silver' },
  abyss:   { l: '#ddc8ff', m: '#8b5cf6', d: '#341a70', a: '#ff4fd8', metal: 'dark' },
  flame:   { l: '#ffe3a3', m: '#ff7a2f', d: '#a8200d', a: '#ffd23f', metal: 'gold' },
  verdant: { l: '#e0ffcf', m: '#5fcf6a', d: '#1c6e35', a: '#ffcf4a', metal: 'gold' },
  galaxy:  { l: '#ffd6f5', m: '#b06cff', d: '#352595', a: '#6ff0ff', metal: 'gold' },
  tide:    { l: '#cdfff7', m: '#34c6c2', d: '#0d5f7a', a: '#ffe066', metal: 'gold' },
  storm:   { l: '#e9f1ff', m: '#7f9cff', d: '#26338f', a: '#ffe94a', metal: 'silver' },
  shadow:  { l: '#d0d2e2', m: '#6b6f8a', d: '#1f2133', a: '#ff4d6d', metal: 'dark' },
  blossom: { l: '#fff0f6', m: '#ff9ccc', d: '#b83a76', a: '#fff17a', metal: 'gold' },
  // 일반~전설 아이템 전용
  rust:      { l: '#f0c39a', m: '#b5652d', d: '#4f230c', a: '#7fd1b9', metal: 'dark' },
  stone:     { l: '#eeeeea', m: '#9c9c96', d: '#45453f', a: '#7cc46b', metal: 'dark' },
  parchment: { l: '#fff6dc', m: '#e7c98f', d: '#8c6526', a: '#e23b3b', metal: 'gold' },
  cyan:      { l: '#e6fffd', m: '#3fd6e8', d: '#0f6f93', a: '#ffffff', metal: 'silver' },
  leather:   { l: '#e9b98a', m: '#9b5f2e', d: '#47250c', a: '#dfe6f0', metal: 'silver' },
  clover:    { l: '#d8ffc4', m: '#4fc45e', d: '#17652d', a: '#ffd84a', metal: 'gold' },
  fairy:     { l: '#ffffff', m: '#bfe8ff', d: '#7d8de8', a: '#ffb3e6', metal: 'silver' },
  dragon:    { l: '#c9f7a8', m: '#3fae5a', d: '#11482a', a: '#ffcf3d', metal: 'gold' },
  starlight: { l: '#fffbd1', m: '#ffd84d', d: '#b0730a', a: '#c48cff', metal: 'gold' },
  phoenix:   { l: '#fff1b0', m: '#ff8a1f', d: '#b0170c', a: '#fff07a', metal: 'gold' },
  sand:      { l: '#fff1c2', m: '#e9b44c', d: '#7f4f12', a: '#f6d27a', metal: 'gold' },
};
const METALS = {
  gold:   ['#fff0a6', '#e3ac2a', '#875608'],
  silver: ['#ffffff', '#c3cbd8', '#656e83'],
  dark:   ['#a3a7bd', '#4a4d66', '#17182a'],
};
// 등급별 뒤쪽 후광 색
const RARITY_GLOW = {
  common: '#9aa3b5', rare: '#4fa3ff', epic: '#b067ff', legendary: '#ffa53a', mythic: '#ff5fc8',
};

// -------------------------------
// 공통 정의(그라데이션)
// -------------------------------
function defs(p, rarity) {
  const metal = METALS[p.metal];
  const aL = mix(p.a, '#ffffff', 0.55);
  const aD = mix(p.a, '#000000', 0.35);
  return `<defs>
  <linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${p.l}"/><stop offset=".45" stop-color="${p.m}"/><stop offset="1" stop-color="${p.d}"/></linearGradient>
  <linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.m}"/><stop offset="1" stop-color="${p.d}"/></linearGradient>
  <radialGradient id="s" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="${mix(p.l, '#ffffff', 0.5)}"/><stop offset=".35" stop-color="${p.m}"/><stop offset="1" stop-color="${p.d}"/></radialGradient>
  <linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${aL}"/><stop offset=".5" stop-color="${p.a}"/><stop offset="1" stop-color="${aD}"/></linearGradient>
  <radialGradient id="as" cx=".35" cy=".3" r=".8"><stop offset="0" stop-color="#ffffff"/><stop offset=".3" stop-color="${aL}"/><stop offset="1" stop-color="${aD}"/></radialGradient>
  <linearGradient id="mt" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${metal[0]}"/><stop offset=".5" stop-color="${metal[1]}"/><stop offset="1" stop-color="${metal[2]}"/></linearGradient>
  <linearGradient id="blade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff"/><stop offset=".5" stop-color="${p.l}"/><stop offset="1" stop-color="${p.m}"/></linearGradient>
  <radialGradient id="glow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${RARITY_GLOW[rarity]}" stop-opacity=".6"/><stop offset=".6" stop-color="${RARITY_GLOW[rarity]}" stop-opacity=".18"/><stop offset="1" stop-color="${RARITY_GLOW[rarity]}" stop-opacity="0"/></radialGradient>
  <radialGradient id="lamp" cx=".5" cy=".55" r=".6"><stop offset="0" stop-color="#ffffff"/><stop offset=".35" stop-color="${p.l}"/><stop offset="1" stop-color="${p.m}"/></radialGradient>
</defs>`;
}

// -------------------------------
// 도형 도우미
// -------------------------------
const f = (n) => Number(n.toFixed(1));
function polar(cx, cy, r, deg) {
  const rad = (deg - 90) * Math.PI / 180;
  return [f(cx + r * Math.cos(rad)), f(cy + r * Math.sin(rad))];
}
function starPoints(cx, cy, outer, inner, points = 5, rot = 0) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    pts.push(polar(cx, cy, i % 2 === 0 ? outer : inner, rot + i * 180 / points));
  }
  return pts;
}
// 4갈래 반짝이
function sparkle(cx, cy, r, fill = '#ffffff', opacity = 1) {
  const pts = starPoints(cx, cy, r, r * 0.28, 4).map(p => p.join(',')).join(' ');
  return `<polygon points="${pts}" fill="${fill}" opacity="${opacity}"/>`;
}
// 위쪽을 향한 물방울(불꽃) 모양. 원점이 둥근 아랫부분 중심
function tearPath(len, w) {
  return `M0 ${-len} C ${w * 0.7} ${-len * 0.55} ${w} ${-w * 0.4} ${w} 0 A ${w} ${w} 0 0 1 ${-w} 0 C ${-w} ${-w * 0.4} ${-w * 0.7} ${-len * 0.55} 0 ${-len} Z`;
}
// 외곽선이 있는 굵은 선 (고리·손잡이 등): 검은 선 위에 색 선을 한 번 더
function outlinedStroke(d, color, width) {
  return `<path d="${d}" fill="none" stroke="${O}" stroke-width="${width + 6}" stroke-linecap="round"/><path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
}
const S3 = `stroke="${O}" stroke-width="3" stroke-linejoin="round"`;
const HL = (d, op = 0.5) => `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round" opacity="${op}"/>`;

// 두 원으로 초승달 경로 만들기 (큰 원에서 작은 원을 뺀 모양)
function crescentPath(cx1, cy1, r1, cx2, cy2, r2) {
  const dx = cx2 - cx1;
  const dy = cy2 - cy1;
  const d = Math.hypot(dx, dy);
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(r1 * r1 - a * a);
  const mx = cx1 + a * dx / d;
  const my = cy1 + a * dy / d;
  const p1 = [f(mx + h * dy / d), f(my - h * dx / d)];
  const p2 = [f(mx - h * dy / d), f(my + h * dx / d)];
  return `M${p1} A${r1} ${r1} 0 1 0 ${p2} A${r2} ${r2} 0 0 1 ${p1} Z`;
}

// -------------------------------
// 모양별 그림 (viewBox 0 0 128 128, 가운데 64,64)
// -------------------------------
const DRAW = {
  compass: (p) => `
    ${outlinedStroke('M64 14 a8 8 0 1 1 0.1 0', 'url(#mt)', 5)}
    <circle cx="64" cy="70" r="42" fill="url(#m)" ${S3}/>
    <circle cx="64" cy="70" r="32" fill="#1d2045" ${S3}/>
    ${[0, 45, 90, 135, 180, 225, 270, 315].map(deg => {
      const [x1, y1] = polar(64, 70, deg % 90 === 0 ? 22 : 26, deg);
      const [x2, y2] = polar(64, 70, 30, deg);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${p.l}" stroke-width="2.5" stroke-linecap="round" opacity=".8"/>`;
    }).join('')}
    <circle cx="50" cy="60" r="1.6" fill="#fff"/><circle cx="80" cy="84" r="1.4" fill="#fff"/><circle cx="76" cy="56" r="1.1" fill="#fff"/>
    <polygon points="64,42 72,70 56,70" fill="url(#a)" ${S3}/>
    <polygon points="64,98 72,70 56,70" fill="#f4f1ff" ${S3}/>
    <circle cx="64" cy="70" r="5" fill="url(#mt)" ${S3}/>
    ${HL('M32 56 A36 36 0 0 1 52 34')}`,

  crown: (p) => `
    <path d="M20 92 L24 42 L44 64 L64 28 L84 64 L104 42 L108 92 Z" fill="url(#m)" ${S3}/>
    <path d="M64 40 L77 64 L64 78 L51 64 Z" fill="url(#a)" ${S3}/>
    <rect x="18" y="86" width="92" height="18" rx="5" fill="url(#v)" ${S3}/>
    <circle cx="24" cy="42" r="7" fill="url(#as)" ${S3}/>
    <circle cx="64" cy="26" r="8" fill="url(#as)" ${S3}/>
    <circle cx="104" cy="42" r="7" fill="url(#as)" ${S3}/>
    <circle cx="40" cy="95" r="5" fill="url(#as)" ${S3}/>
    <circle cx="88" cy="95" r="5" fill="url(#as)" ${S3}/>
    <path d="M64 88 L71 95 L64 102 L57 95 Z" fill="#ffffff" ${S3}/>
    ${HL('M30 82 L32 56', 0.55)}`,

  orb: (p) => `
    <path d="M38 116 L90 116 L82 98 L46 98 Z" fill="url(#mt)" ${S3}/>
    <path d="M44 100 C 36 92, 34 86, 38 78" fill="none" stroke="${O}" stroke-width="9" stroke-linecap="round"/>
    <path d="M84 100 C 92 92, 94 86, 90 78" fill="none" stroke="${O}" stroke-width="9" stroke-linecap="round"/>
    <path d="M44 100 C 36 92, 34 86, 38 78" fill="none" stroke="url(#mt)" stroke-width="4" stroke-linecap="round"/>
    <path d="M84 100 C 92 92, 94 86, 90 78" fill="none" stroke="url(#mt)" stroke-width="4" stroke-linecap="round"/>
    <circle cx="64" cy="60" r="38" fill="url(#s)" ${S3}/>
    <path d="M36 66 C 46 40, 82 38, 90 58" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round" opacity=".35"/>
    <path d="M44 78 C 56 62, 80 64, 86 74" fill="none" stroke="${p.a}" stroke-width="4" stroke-linecap="round" opacity=".75"/>
    ${sparkle(70, 58, 9, '#ffffff', 0.95)}
    <ellipse cx="50" cy="42" rx="10" ry="6" fill="#ffffff" opacity=".7" transform="rotate(-35 50 42)"/>`,

  pearl: (p) => `
    <path d="${tearPath(34, 13)}" transform="translate(64 50)" fill="url(#a)" ${S3}/>
    <path d="${tearPath(28, 11)}" transform="translate(42 66) rotate(-50)" fill="url(#a)" ${S3}/>
    <path d="${tearPath(28, 11)}" transform="translate(86 66) rotate(50)" fill="url(#a)" ${S3}/>
    <circle cx="64" cy="76" r="32" fill="url(#s)" ${S3}/>
    <circle cx="64" cy="76" r="22" fill="none" stroke="#ffffff" stroke-width="2.5" opacity=".35"/>
    ${sparkle(74, 84, 7, '#ffffff', 0.8)}
    <ellipse cx="52" cy="62" rx="9" ry="5.5" fill="#ffffff" opacity=".75" transform="rotate(-35 52 62)"/>`,

  star: (p) => {
    const outer = starPoints(64, 68, 48, 20);
    const facets = outer.map((pt, i) => {
      const next = outer[(i + 1) % outer.length];
      return `<polygon points="64,68 ${pt} ${next}" fill="${i % 2 === 0 ? '#ffffff' : p.d}" opacity="${i % 2 === 0 ? 0.3 : 0.25}"/>`;
    }).join('');
    return `
    <polygon points="${outer.map(pt => pt.join(',')).join(' ')}" fill="url(#m)" ${S3}/>
    ${facets}
    <polygon points="${outer.map(pt => pt.join(',')).join(' ')}" fill="none" ${S3}/>
    <circle cx="64" cy="68" r="7" fill="url(#as)" ${S3}/>
    ${sparkle(104, 26, 9)}${sparkle(22, 30, 6, p.l)}${sparkle(106, 100, 5, p.l)}`;
  },

  hourglass: (p) => `
    <path d="M44 28 C44 52, 60 58, 60 64 C60 70, 44 76, 44 100 L84 100 C84 76, 68 70, 68 64 C68 58, 84 52, 84 28 Z" fill="#eaf7ff" opacity=".55" ${S3}/>
    <path d="M50 44 C52 54, 62 58, 64 62 C66 58, 76 54, 78 44 Z" fill="url(#a)"/>
    <line x1="64" y1="62" x2="64" y2="88" stroke="${p.a}" stroke-width="2.5"/>
    <path d="M47 100 C51 88, 59 84, 64 84 C69 84, 77 88, 81 100 Z" fill="url(#a)"/>
    <path d="M44 28 C44 52, 60 58, 60 64 C60 70, 44 76, 44 100 L84 100 C84 76, 68 70, 68 64 C68 58, 84 52, 84 28 Z" fill="none" ${S3}/>
    ${HL('M50 34 C50 46, 56 52, 58 56', 0.7)}
    <rect x="33" y="24" width="7" height="80" rx="3" fill="url(#m)" ${S3}/>
    <rect x="88" y="24" width="7" height="80" rx="3" fill="url(#m)" ${S3}/>
    <rect x="26" y="14" width="76" height="14" rx="5" fill="url(#m)" ${S3}/>
    <rect x="26" y="100" width="76" height="14" rx="5" fill="url(#v)" ${S3}/>
    <circle cx="64" cy="21" r="3.5" fill="url(#as)" ${S3}/><circle cx="64" cy="107" r="3.5" fill="url(#as)" ${S3}/>`,

  hammer: (p) => `<g transform="rotate(-35 64 64)">
    <rect x="57" y="46" width="14" height="72" rx="6" fill="url(#mt)" ${S3}/>
    ${[66, 78, 90, 102].map(y => `<line x1="58" y1="${y}" x2="70" y2="${y + 5}" stroke="${O}" stroke-width="2" opacity=".55"/>`).join('')}
    <rect x="22" y="18" width="84" height="34" rx="7" fill="url(#m)" ${S3}/>
    <rect x="16" y="22" width="12" height="26" rx="3" fill="url(#v)" ${S3}/>
    <rect x="100" y="22" width="12" height="26" rx="3" fill="url(#v)" ${S3}/>
    <path d="M58 24 L70 24 L62 35 L72 35 L56 48 L61 37 L52 37 Z" fill="url(#a)" ${S3}/>
    ${HL('M30 25 L50 25', 0.6)}
  </g>`,

  feather: (p) => `<g transform="rotate(32 64 64)">
    <path d="M64 8 C 90 28, 92 70, 72 104 L 64 120 L 56 104 C 36 70, 38 28, 64 8 Z" fill="url(#m)" ${S3}/>
    <path d="M64 8 C 74 24, 78 40, 76 54 C 70 40, 66 24, 64 8 Z" fill="${p.a}" opacity=".55"/>
    ${[30, 44, 58, 72, 86].map(y => `<path d="M64 ${y + 8} C 72 ${y + 2}, 80 ${y - 2}, 84 ${y - 8}" fill="none" stroke="${p.d}" stroke-width="2" opacity=".45"/><path d="M64 ${y + 8} C 56 ${y + 2}, 48 ${y - 2}, 44 ${y - 8}" fill="none" stroke="${p.d}" stroke-width="2" opacity=".45"/>`).join('')}
    <path d="M86 58 L78 62" stroke="${O}" stroke-width="3" stroke-linecap="round"/>
    <path d="M42 74 L50 76" stroke="${O}" stroke-width="3" stroke-linecap="round"/>
    <path d="M64 16 Q 62 70 64 122" fill="none" stroke="#ffffff" stroke-width="3" opacity=".85"/>
  </g>`,

  key: (p) => `<g transform="rotate(-40 64 64)">
    <rect x="58" y="50" width="12" height="66" rx="4" fill="url(#mt)" ${S3}/>
    <rect x="69" y="88" width="16" height="8" rx="2" fill="url(#mt)" ${S3}/>
    <rect x="69" y="101" width="11" height="8" rx="2" fill="url(#mt)" ${S3}/>
    <rect x="53" y="48" width="22" height="8" rx="3" fill="url(#v)" ${S3}/>
    <circle cx="64" cy="30" r="22" fill="url(#m)" ${S3}/>
    <circle cx="64" cy="30" r="10" fill="url(#as)" ${S3}/>
    ${[0, 90, 180, 270].map(deg => { const [x, y] = polar(64, 30, 17, deg + 45); return `<circle cx="${x}" cy="${y}" r="2.6" fill="${p.l}" stroke="${O}" stroke-width="1.5"/>`; }).join('')}
    ${HL('M46 22 A20 20 0 0 1 58 10', 0.6)}
  </g>`,

  chalice: (p) => `
    <path d="M28 22 L100 22 C100 52, 86 72, 64 74 C42 72, 28 52, 28 22 Z" fill="url(#m)" ${S3}/>
    <ellipse cx="64" cy="23" rx="35" ry="7" fill="url(#a)" ${S3}/>
    <ellipse cx="54" cy="21" rx="10" ry="2.5" fill="#ffffff" opacity=".6"/>
    <path d="M64 38 L72 48 L64 58 L56 48 Z" fill="url(#as)" ${S3}/>
    <rect x="57" y="72" width="14" height="24" rx="3" fill="url(#mt)" ${S3}/>
    <ellipse cx="64" cy="84" rx="12" ry="6" fill="url(#mt)" ${S3}/>
    <path d="M34 112 C36 100, 54 96, 64 96 C74 96, 92 100, 94 112 Z" fill="url(#m)" ${S3}/>
    ${HL('M36 32 C38 46, 44 56, 50 62', 0.55)}`,

  dice: (p) => {
    const pip = (x, y, rot, color) => `<ellipse cx="${x}" cy="${y}" rx="5" ry="3.6" transform="rotate(${rot} ${x} ${y})" fill="${color}" stroke="${O}" stroke-width="1.5"/>`;
    return `
    <polygon points="64,16 106,39 64,62 22,39" fill="${p.l}" ${S3}/>
    <polygon points="22,39 64,62 64,112 22,89" fill="url(#m)" ${S3}/>
    <polygon points="106,39 64,62 64,112 106,89" fill="url(#v)" ${S3}/>
    <ellipse cx="64" cy="39" rx="9" ry="5.2" fill="url(#as)" stroke="${O}" stroke-width="1.5"/>
    ${pip(35, 61, 30, '#ffffff')}${pip(51, 90, 30, '#ffffff')}
    ${pip(75, 69, -30, '#ffffff')}${pip(85, 76, -30, '#ffffff')}${pip(95, 83, -30, '#ffffff')}
    ${HL('M28 44 L28 82', 0.45)}`;
  },

  bell: (p) => `
    ${outlinedStroke('M64 12 a8 8 0 1 1 0.1 0', 'url(#mt)', 5)}
    <path d="M64 22 C 40 22, 36 48, 34 74 C 33 86, 26 92, 22 96 L 106 96 C 102 92, 95 86, 94 74 C 92 48, 88 22, 64 22 Z" fill="url(#m)" ${S3}/>
    <path d="M37 70 C 54 76, 74 76, 91 70" fill="none" stroke="${p.a}" stroke-width="4" stroke-linecap="round"/>
    <circle cx="64" cy="50" r="6" fill="url(#as)" ${S3}/>
    <rect x="16" y="92" width="96" height="12" rx="6" fill="url(#v)" ${S3}/>
    <circle cx="64" cy="110" r="8" fill="url(#as)" ${S3}/>
    ${HL('M46 34 C 42 46, 41 60, 40 72', 0.55)}
    <path d="M12 54 C 6 62, 6 72, 12 80" fill="none" stroke="${p.l}" stroke-width="3.5" stroke-linecap="round" opacity=".9"/>
    <path d="M116 54 C 122 62, 122 72, 116 80" fill="none" stroke="${p.l}" stroke-width="3.5" stroke-linecap="round" opacity=".9"/>`,

  ring: (p) => `
    <ellipse cx="64" cy="80" rx="34" ry="28" fill="none" stroke="${O}" stroke-width="18"/>
    <ellipse cx="64" cy="80" rx="34" ry="28" fill="none" stroke="url(#m)" stroke-width="11"/>
    <path d="M36 70 A34 28 0 0 1 52 54" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" opacity=".6"/>
    <rect x="52" y="48" width="24" height="12" rx="4" fill="url(#mt)" ${S3}/>
    <polygon points="64,12 90,32 64,60 38,32" fill="url(#a)" ${S3}/>
    <polyline points="38,32 90,32" fill="none" stroke="#ffffff" stroke-width="2" opacity=".6"/>
    <polyline points="64,12 55,32 64,60 73,32 64,12" fill="none" stroke="#ffffff" stroke-width="2" opacity=".55"/>
    ${sparkle(86, 18, 7)}`,

  eye: (p) => `
    ${Array.from({ length: 12 }, (_, i) => {
      const deg = i * 30;
      const [x1, y1] = polar(64, 64, 44, deg - 6);
      const [x2, y2] = polar(64, 64, i % 2 ? 54 : 60, deg);
      const [x3, y3] = polar(64, 64, 44, deg + 6);
      return `<polygon points="${x1},${y1} ${x2},${y2} ${x3},${y3}" fill="${p.m}" opacity=".85" stroke="${O}" stroke-width="1.5"/>`;
    }).join('')}
    <path d="M12 64 C 34 32, 94 32, 116 64 C 94 96, 34 96, 12 64 Z" fill="#fbf8ff" ${S3}/>
    <circle cx="64" cy="64" r="21" fill="url(#s)" ${S3}/>
    <ellipse cx="64" cy="64" rx="6" ry="11" fill="#120c22"/>
    <circle cx="57" cy="56" r="4.5" fill="#ffffff"/>
    <path d="M12 64 C 34 32, 94 32, 116 64" fill="none" stroke="${O}" stroke-width="5" stroke-linecap="round"/>`,

  chest: (p) => `
    <path d="M16 58 L16 44 C16 26, 40 16, 64 16 C88 16, 112 26, 112 44 L112 58 Z" fill="url(#m)" ${S3}/>
    <path d="M30 58 L30 24 M98 58 L98 24" stroke="${O}" stroke-width="10"/>
    <path d="M30 58 L30 24 M98 58 L98 24" stroke="url(#mt)" stroke-width="5"/>
    <rect x="16" y="56" width="96" height="54" rx="4" fill="url(#v)" ${S3}/>
    <rect x="25" y="56" width="10" height="54" fill="url(#mt)" ${S3}/>
    <rect x="93" y="56" width="10" height="54" fill="url(#mt)" ${S3}/>
    <rect x="12" y="52" width="104" height="10" rx="3" fill="url(#mt)" ${S3}/>
    <rect x="54" y="50" width="20" height="24" rx="4" fill="url(#a)" ${S3}/>
    <circle cx="64" cy="59" r="3.5" fill="${O}"/><rect x="62.5" y="60" width="3" height="8" fill="${O}"/>
    ${HL('M24 40 C 28 30, 40 24, 52 22', 0.55)}
    ${sparkle(108, 18, 7)}`,

  book: (p) => `
    <rect x="30" y="22" width="70" height="88" rx="5" fill="#f4ead0" ${S3}/>
    ${[30, 34, 38].map(x => `<line x1="${x + 64}" y1="28" x2="${x + 64}" y2="104" stroke="#c9b98f" stroke-width="1.5"/>`).join('')}
    <rect x="22" y="16" width="70" height="88" rx="6" fill="url(#m)" ${S3}/>
    <rect x="22" y="16" width="14" height="88" rx="5" fill="url(#v)" ${S3}/>
    <circle cx="64" cy="58" r="20" fill="none" stroke="${O}" stroke-width="8"/>
    <circle cx="64" cy="58" r="20" fill="none" stroke="url(#mt)" stroke-width="4"/>
    <polygon points="${starPoints(64, 58, 14, 6).map(pt => pt.join(',')).join(' ')}" fill="url(#a)" ${S3}/>
    <path d="M80 16 L92 16 L92 28 Z" fill="url(#mt)" ${S3}/>
    <path d="M80 104 L92 104 L92 92 Z" fill="url(#mt)" ${S3}/>
    ${HL('M42 24 L44 96', 0.35)}`,

  wing: (p) => {
    // 어깨(106,44)에서 아래 왼쪽으로 부채꼴처럼 늘어진 깃털 5장 + 위쪽 덮깃
    // 깃털은 원점에서 -x 방향으로 뻗은 모양이고, rotate(a)로 방향을 정합니다.
    const feather = (len, w) => `M0 0 C ${-len * 0.25} ${-w}, ${-len * 0.85} ${-w}, ${-len} ${-w * 0.1} C ${-len * 0.85} ${w * 0.75}, ${-len * 0.25} ${w * 0.75}, 0 0 Z`;
    const J = [108, 36];
    const feathers = [[96, 2, 13], [94, -18, 13], [88, -38, 13], [78, -58, 13], [64, -78, 12]];
    const tip = (len, a, k) => {
      const rad = a * Math.PI / 180;
      return [f(J[0] - Math.cos(rad) * len * k), f(J[1] - Math.sin(rad) * len * k)];
    };
    return `
    ${feathers.map(([len, a, w], i) => `<path d="${feather(len, w)}" transform="translate(${J[0]} ${J[1]}) rotate(${a})" fill="${i % 2 ? 'url(#m)' : 'url(#v)'}" ${S3}/>`).join('')}
    ${feathers.map(([len, a]) => { const [x1, y1] = tip(len, a, 0.35); const [x2, y2] = tip(len, a, 0.85); return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round" opacity=".5"/>`; }).join('')}
    <path d="M116 32 C 94 18, 54 16, 16 28 C 40 42, 68 54, 94 64 C 106 60, 114 48, 116 32 Z" fill="url(#m)" ${S3}/>
    <path d="M30 36 C 52 42, 74 50, 92 60" fill="none" stroke="${p.a}" stroke-width="3" stroke-linecap="round" opacity=".7"/>
    ${HL('M28 31 C 56 28, 84 30, 104 38', 0.55)}
    ${sparkle(24, 104, 7, p.l)}${sparkle(104, 104, 5, '#ffffff')}`;
  },

  lantern: (p) => `
    ${outlinedStroke('M50 24 C 50 8, 78 8, 78 24', 'url(#mt)', 4)}
    <path d="M38 36 L90 36 L80 22 L48 22 Z" fill="url(#mt)" ${S3}/>
    <rect x="40" y="34" width="48" height="56" rx="10" fill="url(#lamp)" ${S3}/>
    <path d="${tearPath(24, 9)}" transform="translate(64 74)" fill="${p.a}" stroke="${O}" stroke-width="2"/>
    <path d="${tearPath(14, 5)}" transform="translate(64 76)" fill="#ffffff"/>
    <line x1="52" y1="36" x2="52" y2="88" stroke="${O}" stroke-width="7"/><line x1="52" y1="36" x2="52" y2="88" stroke="url(#mt)" stroke-width="3"/>
    <line x1="76" y1="36" x2="76" y2="88" stroke="${O}" stroke-width="7"/><line x1="76" y1="36" x2="76" y2="88" stroke="url(#mt)" stroke-width="3"/>
    <path d="M36 88 L92 88 L82 102 L46 102 Z" fill="url(#mt)" ${S3}/>
    <line x1="64" y1="102" x2="64" y2="114" stroke="${O}" stroke-width="3"/>
    <path d="M58 112 L70 112 L67 122 L61 122 Z" fill="url(#a)" stroke="${O}" stroke-width="2"/>`,

  coin: (p) => `
    <circle cx="76" cy="72" r="34" fill="url(#v)" ${S3}/>
    <circle cx="56" cy="62" r="38" fill="url(#m)" ${S3}/>
    <circle cx="56" cy="62" r="29" fill="none" stroke="${p.d}" stroke-width="3" opacity=".55"/>
    <polygon points="${starPoints(57, 64, 18, 8).map(pt => pt.join(',')).join(' ')}" fill="${p.d}" opacity=".45"/>
    <polygon points="${starPoints(55, 61, 18, 8).map(pt => pt.join(',')).join(' ')}" fill="url(#a)" ${S3}/>
    ${HL('M26 52 A30 30 0 0 1 44 30', 0.65)}
    ${sparkle(96, 26, 8)}`,

  clover: (p) => {
    const leaf = 'M0 0 C -6 -8, -27 -14, -23 -31 C -20 -42, -6 -42, 0 -31 C 6 -42, 20 -42, 23 -31 C 27 -14, 6 -8, 0 0 Z';
    return `
    ${outlinedStroke('M64 64 C 66 86, 72 102, 84 114', p.d, 6)}
    ${[45, 135, 225, 315].map(deg => `<g transform="translate(64 58) rotate(${deg})"><path d="${leaf}" fill="url(#m)" ${S3}/><path d="M0 -3 L0 -28" stroke="${p.l}" stroke-width="2.5" opacity=".7"/></g>`).join('')}
    <circle cx="64" cy="58" r="6" fill="url(#as)" ${S3}/>
    ${sparkle(104, 24, 8)}`;
  },

  sun: (p) => `
    ${Array.from({ length: 12 }, (_, i) => {
      const deg = i * 30;
      const [x1, y1] = polar(64, 64, 34, deg - 11);
      const [x2, y2] = polar(64, 64, i % 2 ? 50 : 60, deg);
      const [x3, y3] = polar(64, 64, 34, deg + 11);
      return `<polygon points="${x1},${y1} ${x2},${y2} ${x3},${y3}" fill="url(#a)" ${S3}/>`;
    }).join('')}
    <circle cx="64" cy="64" r="34" fill="url(#s)" ${S3}/>
    <circle cx="64" cy="64" r="25" fill="none" stroke="${p.l}" stroke-width="3" opacity=".7"/>
    <circle cx="64" cy="64" r="9" fill="url(#as)" ${S3}/>
    <ellipse cx="52" cy="50" rx="8" ry="5" fill="#ffffff" opacity=".65" transform="rotate(-35 52 50)"/>`,

  mirror: (p) => `
    <rect x="57" y="84" width="14" height="34" rx="6" fill="url(#mt)" ${S3}/>
    <circle cx="64" cy="118" r="6" fill="url(#as)" ${S3}/>
    <ellipse cx="64" cy="50" rx="36" ry="42" fill="url(#m)" ${S3}/>
    <ellipse cx="64" cy="50" rx="27" ry="33" fill="url(#lamp)" ${S3}/>
    <path d="M46 40 L60 24 M48 58 L72 30" stroke="#ffffff" stroke-width="5" stroke-linecap="round" opacity=".75"/>
    <circle cx="64" cy="10" r="5" fill="url(#as)" ${S3}/>
    <circle cx="28" cy="52" r="4" fill="url(#as)" ${S3}/>
    <circle cx="100" cy="52" r="4" fill="url(#as)" ${S3}/>`,

  moon: (p) => `
    <path d="${crescentPath(58, 66, 44, 82, 52, 36)}" fill="url(#m)" ${S3}/>
    <circle cx="36" cy="76" r="5" fill="${p.d}" opacity=".3"/>
    <circle cx="48" cy="96" r="3.5" fill="${p.d}" opacity=".3"/>
    <circle cx="30" cy="56" r="3" fill="${p.d}" opacity=".3"/>
    ${HL('M24 82 C 28 96, 40 106, 54 108', 0.45)}
    ${sparkle(92, 70, 9, p.a)}${sparkle(80, 96, 5, '#ffffff')}${sparkle(106, 34, 6, '#ffffff')}`,

  shield: (p) => `
    <path d="M64 10 L106 22 C106 64, 94 94, 64 118 C34 94, 22 64, 22 22 Z" fill="url(#m)" ${S3}/>
    <path d="M64 10 L64 118 C34 94, 22 64, 22 22 Z" fill="#ffffff" opacity=".18"/>
    <path d="M64 22 L94 31 C94 62, 84 84, 64 103 C44 84, 34 62, 34 31 Z" fill="none" stroke="${O}" stroke-width="8" stroke-linejoin="round"/>
    <path d="M64 22 L94 31 C94 62, 84 84, 64 103 C44 84, 34 62, 34 31 Z" fill="none" stroke="url(#mt)" stroke-width="4" stroke-linejoin="round"/>
    <path d="M64 42 L76 60 L64 78 L52 60 Z" fill="url(#a)" ${S3}/>
    <circle cx="30" cy="27" r="3.5" fill="url(#mt)" ${S3}/><circle cx="98" cy="27" r="3.5" fill="url(#mt)" ${S3}/>`,

  sword: (p) => `<g transform="rotate(40 64 64)">
    <path d="M64 2 L73 16 L73 84 L55 84 L55 16 Z" fill="url(#blade)" ${S3}/>
    <line x1="64" y1="18" x2="64" y2="80" stroke="${p.d}" stroke-width="3" opacity=".45"/>
    <rect x="38" y="82" width="52" height="11" rx="5" fill="url(#mt)" ${S3}/>
    <circle cx="38" cy="87" r="5" fill="url(#as)" ${S3}/><circle cx="90" cy="87" r="5" fill="url(#as)" ${S3}/>
    <rect x="58" y="93" width="12" height="22" rx="3" fill="url(#v)" ${S3}/>
    ${[98, 104, 110].map(y => `<line x1="58" y1="${y}" x2="70" y2="${y + 3}" stroke="${O}" stroke-width="1.8" opacity=".6"/>`).join('')}
    <circle cx="64" cy="119" r="7" fill="url(#as)" ${S3}/>
    <circle cx="64" cy="87.5" r="3.5" fill="url(#as)" stroke="${O}" stroke-width="1.5"/>
  </g>`,

  // ---- 일반~전설 전용 모양 ----
  oldCoin: (p) => `
    <circle cx="64" cy="64" r="42" fill="url(#m)" ${S3}/>
    <circle cx="64" cy="64" r="33" fill="none" stroke="${p.d}" stroke-width="3" opacity=".55"/>
    <rect x="54" y="54" width="20" height="20" rx="2" fill="${O}"/>
    <circle cx="40" cy="80" r="6" fill="${p.a}" opacity=".55"/><circle cx="86" cy="46" r="4" fill="${p.a}" opacity=".5"/>
    ${HL('M30 52 A36 36 0 0 1 50 28', 0.5)}`,

  moai: (p) => `
    <path d="M42 22 C42 14, 86 14, 86 22 L90 74 C90 88, 82 104, 78 112 L50 112 C46 104, 38 88, 38 74 Z" fill="url(#m)" ${S3}/>
    <path d="M42 44 L86 44" stroke="${p.d}" stroke-width="6" stroke-linecap="round"/>
    <path d="M48 50 L58 50 M70 50 L80 50" stroke="${O}" stroke-width="4" stroke-linecap="round"/>
    <path d="M64 46 L58 76 C 62 80, 66 80, 70 76 Z" fill="${p.d}" opacity=".55" stroke="${O}" stroke-width="2"/>
    <path d="M52 92 L76 92" stroke="${O}" stroke-width="4" stroke-linecap="round"/>
    <circle cx="80" cy="30" r="6" fill="${p.a}" opacity=".6"/><circle cx="46" cy="100" r="5" fill="${p.a}" opacity=".55"/>
    ${HL('M46 28 L44 70', 0.4)}`,

  map: (p) => `
    <path d="M18 26 L44 20 L62 28 L84 20 L110 28 L106 50 L112 64 L106 82 L110 104 L84 110 L62 102 L44 110 L18 104 L22 82 L16 64 L22 46 Z" fill="url(#m)" ${S3}/>
    <path d="M44 20 L44 110 M84 20 L84 110" stroke="${p.d}" stroke-width="2" opacity=".35"/>
    <path d="M30 90 C 40 70, 56 84, 64 66 C 72 50, 84 58, 92 44" fill="none" stroke="${p.d}" stroke-width="3" stroke-dasharray="5 5" stroke-linecap="round"/>
    <polygon points="30,52 38,38 46,52" fill="${p.d}" opacity=".6"/><polygon points="40,52 48,40 56,52" fill="${p.d}" opacity=".5"/>
    <path d="M86 36 L100 50 M100 36 L86 50" stroke="${p.a}" stroke-width="5" stroke-linecap="round"/>`,

  gem: (p) => `
    <polygon points="40,30 88,30 108,52 64,110 20,52" fill="url(#m)" ${S3}/>
    <polygon points="40,30 52,52 20,52" fill="#ffffff" opacity=".45"/>
    <polygon points="52,52 76,52 64,30 40,30 88,30" fill="#ffffff" opacity=".25"/>
    <polygon points="76,52 108,52 88,30" fill="${p.d}" opacity=".25"/>
    <polygon points="20,52 52,52 64,110" fill="#ffffff" opacity=".2"/>
    <polygon points="76,52 108,52 64,110" fill="${p.d}" opacity=".35"/>
    <polyline points="20,52 108,52" fill="none" stroke="${O}" stroke-width="2"/>
    <polyline points="40,30 52,52 64,110 76,52 88,30" fill="none" stroke="${O}" stroke-width="2"/>
    <polyline points="52,52 64,30 76,52" fill="none" stroke="${O}" stroke-width="2"/>
    ${sparkle(96, 26, 9)}`,

  pouch: (p) => `
    <path d="M40 50 C 22 64, 18 102, 38 110 L 90 110 C 110 102, 106 64, 88 50 Z" fill="url(#m)" ${S3}/>
    <path d="M42 50 C 36 40, 40 30, 50 34 C 56 26, 72 26, 78 34 C 88 30, 92 40, 86 50 Z" fill="url(#v)" ${S3}/>
    <rect x="38" y="46" width="52" height="9" rx="4" fill="url(#mt)" ${S3}/>
    <circle cx="64" cy="82" r="15" fill="url(#mt)" ${S3}/>
    <text x="64" y="89" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="18" fill="${O}" opacity=".6">G</text>
    ${HL('M32 72 C 30 84, 32 96, 38 104', 0.4)}`,

  charm: (p) => {
    const leaf = 'M0 0 C -4 -5, -16 -9, -14 -19 C -12 -26, -4 -26, 0 -19 C 4 -26, 12 -26, 14 -19 C 16 -9, 4 -5, 0 0 Z';
    return `
    ${outlinedStroke('M52 22 C 52 8, 76 8, 76 22', '#e9d6a8', 3)}
    <circle cx="64" cy="70" r="42" fill="url(#mt)" ${S3}/>
    <circle cx="64" cy="70" r="33" fill="#fff8e6" ${S3}/>
    ${[45, 135, 225, 315].map(deg => `<g transform="translate(64 68) rotate(${deg})"><path d="${leaf}" fill="url(#m)" stroke="${O}" stroke-width="2"/></g>`).join('')}
    <path d="M64 70 C 66 80, 70 88, 76 94" fill="none" stroke="${p.d}" stroke-width="3.5" stroke-linecap="round"/>
    <circle cx="64" cy="68" r="4" fill="url(#as)" stroke="${O}" stroke-width="1.5"/>`;
  },

  fairyWing: (p) => `
    <path d="M64 70 C 40 30, 8 22, 10 50 C 12 70, 36 76, 64 70 Z" fill="url(#m)" opacity=".9" ${S3}/>
    <path d="M64 70 C 88 30, 120 22, 118 50 C 116 70, 92 76, 64 70 Z" fill="url(#m)" opacity=".9" ${S3}/>
    <path d="M64 72 C 46 82, 28 104, 42 112 C 54 118, 62 96, 64 72 Z" fill="url(#m)" opacity=".85" ${S3}/>
    <path d="M64 72 C 82 82, 100 104, 86 112 C 74 118, 66 96, 64 72 Z" fill="url(#m)" opacity=".85" ${S3}/>
    <circle cx="34" cy="48" r="6" fill="${p.a}" opacity=".7"/><circle cx="94" cy="48" r="6" fill="${p.a}" opacity=".7"/>
    <ellipse cx="64" cy="72" rx="4" ry="12" fill="${p.d}" ${S3}/>
    ${sparkle(24, 92, 6)}${sparkle(104, 92, 5)}${sparkle(64, 24, 7)}`,

  scale: (p) => `
    <path d="M64 12 C 92 28, 108 58, 98 88 C 92 106, 76 116, 64 118 C 52 116, 36 106, 30 88 C 20 58, 36 28, 64 12 Z" fill="url(#m)" ${S3}/>
    <path d="M40 62 L64 46 L88 62" fill="none" stroke="${p.d}" stroke-width="4" stroke-linecap="round" opacity=".6"/>
    <path d="M40 82 L64 66 L88 82" fill="none" stroke="${p.d}" stroke-width="4" stroke-linecap="round" opacity=".6"/>
    <path d="M46 100 L64 88 L82 100" fill="none" stroke="${p.d}" stroke-width="4" stroke-linecap="round" opacity=".6"/>
    ${HL('M44 32 C 36 44, 32 58, 34 72', 0.55)}
    ${sparkle(98, 24, 7, p.a)}`,

  shard: (p) => {
    const pts = starPoints(58, 72, 42, 18, 5, -12).map(pt => pt.join(',')).join(' ');
    return `
    <polygon points="${pts}" fill="url(#m)" ${S3}/>
    <polygon points="${pts}" fill="${p.a}" opacity=".15"/>
    <polyline points="58,72 66,62 61,54 70,42" fill="none" stroke="${O}" stroke-width="3" stroke-linejoin="round"/>
    <polygon points="92,22 108,30 98,42" fill="url(#m)" ${S3}/>
    <polygon points="98,46 106,48 100,56" fill="url(#m)" stroke="${O}" stroke-width="2" stroke-linejoin="round"/>
    ${sparkle(24, 30, 7, p.a)}${sparkle(108, 92, 6)}`;
  },
};

// 일반~전설 아이템별 모양/색
const NORMAL_ICONS = {
  rusty_coin:      { motif: 'oldCoin',   palette: 'rust' },
  stone_carving:   { motif: 'moai',      palette: 'stone' },
  torn_map:        { motif: 'map',       palette: 'parchment' },
  small_gem:       { motif: 'gem',       palette: 'cyan' },
  silver_pouch:    { motif: 'pouch',     palette: 'leather' },
  lucky_charm:     { motif: 'charm',     palette: 'clover' },
  fairy_wing:      { motif: 'fairyWing', palette: 'fairy' },
  dragon_scale:    { motif: 'scale',     palette: 'dragon' },
  star_fragment:   { motif: 'shard',     palette: 'starlight' },
  phoenix_feather: { motif: 'feather',   palette: 'phoenix' },
  hourglass_sand:  { motif: 'hourglass', palette: 'sand' },
};

// 등급별 배경 (후광 + 신화는 반짝이 테두리)
function background(rarity, p) {
  let bg = `<circle cx="64" cy="64" r="62" fill="url(#glow)"/>`;
  if (rarity === 'mythic') {
    bg += Array.from({ length: 8 }, (_, i) => {
      const [x1, y1] = polar(64, 64, 30, i * 45 + 22.5);
      const [x2, y2] = polar(64, 64, 64, i * 45 + 22.5);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${mix(p.l, '#ffffff', 0.4)}" stroke-width="3" stroke-linecap="round" opacity=".35"/>`;
    }).join('');
  }
  return bg;
}
function foreground(rarity) {
  if (rarity === 'mythic') return sparkle(14, 16, 7, '#ffd6f2') + sparkle(116, 116, 6, '#ffffff', 0.9) + sparkle(116, 12, 4, '#ffffff', 0.8);
  if (rarity === 'legendary') return sparkle(16, 18, 6, '#ffe1a0') + sparkle(114, 114, 5, '#ffffff', 0.8);
  return '';
}

function renderIcon(item) {
  const spec = item.rarity === 'mythic'
    ? { motif: item.motif, palette: item.theme }
    : NORMAL_ICONS[item.key];
  if (!spec) throw new Error(`아이콘 정의가 없습니다: ${item.key}`);
  const p = PALETTES[spec.palette];
  const draw = DRAW[spec.motif];
  if (!p || !draw) throw new Error(`모양/색 정의가 없습니다: ${item.key} (${spec.motif}/${spec.palette})`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
<title>${item.name}</title>
${defs(p, item.rarity)}
${background(item.rarity, p)}
${draw(p)}
${foreground(item.rarity)}
</svg>
`;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const item of TREASURES) {
    const svg = renderIcon(item).replace(/\n\s+/g, '\n');
    fs.writeFileSync(path.join(OUT_DIR, `${item.key}.svg`), svg);
  }
  console.log(`[ICONS] ${TREASURES.length}개 아이콘을 만들었습니다 → ${path.relative(process.cwd(), OUT_DIR)}`);
}

if (require.main === module) main();

module.exports = { renderIcon, defs, background, sparkle, PALETTES, DRAW, mix };
