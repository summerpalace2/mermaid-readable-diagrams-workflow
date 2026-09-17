const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_PATH = path.join(REPO_ROOT, 'examples', 'mermaid', 'workflow-overview.mmd');
const OUTPUT_DIR = path.join(REPO_ROOT, 'examples', 'output');

const themes = {
  paper: {
    bg: '#FBF9F2', grid: '#E6E4DC', ink: '#26394F', muted: '#65758C',
    cards: { input: '#C8E1FA', model: '#FFFFFF', layout: '#E4D3F3', route: '#D7EED8', gate: '#FFE9A8', release: '#D7EED8' },
  },
  mint: {
    bg: '#F3FAF7', grid: '#DCEBE7', ink: '#26394F', muted: '#607B7C',
    cards: { input: '#CDE8F6', model: '#FFFFFF', layout: '#E3D9F1', route: '#CFE9D6', gate: '#F8E9B4', release: '#CFE9D6' },
  },
  warm: {
    bg: '#FFF8ED', grid: '#EFE1D1', ink: '#26394F', muted: '#786B63',
    cards: { input: '#D6E6F5', model: '#FFFFFF', layout: '#E8D8EB', route: '#D9E9D3', gate: '#F6DEA6', release: '#D9E9D3' },
  },
  mist: {
    bg: '#F4F7FB', grid: '#DDE5EF', ink: '#26394F', muted: '#687A91',
    cards: { input: '#CFE0F4', model: '#FFFFFF', layout: '#DCD9EE', route: '#D2E7DF', gate: '#F4E6B4', release: '#D2E7DF' },
  },
};

const args = process.argv.slice(2);
const requestedTheme = args.find(arg => Object.hasOwn(themes, arg));
const randomRequested = args.includes('random');
const allRequested = args.includes('all');
if (requestedTheme && randomRequested) throw new Error('请选择固定主题或 random，不能同时使用。');
if (allRequested && (requestedTheme || randomRequested)) throw new Error('all 不能与固定主题或 random 同时使用。');

const themeNames = allRequested ? Object.keys(themes) : [requestedTheme || (randomRequested
  ? Object.keys(themes)[Math.floor(Math.random() * Object.keys(themes).length)]
  : 'paper')];

const source = fs.readFileSync(SOURCE_PATH, 'utf8');
const sourceNodes = [...source.matchAll(/([A-Z]\d)\["([^"]+)"\]/g)].map(match => ({
  id: match[1],
  lines: match[2].split('<br/>'),
}));
const sourceEdges = [...source.matchAll(/([A-Z]\d)(?:\["[^"]+"\])?\s+-->\s+([A-Z]\d)/g)].map(match => `${match[1]}->${match[2]}`);

const baselineModel = {
  layout: 'baseline-rank-order-plus-dynamic-cards',
  ranks: sourceNodes.map((node, index) => `${node.id}:${index}`),
  direction: 'LR',
};
const roles = ['input', 'model', 'layout', 'route', 'gate', 'route', 'release'];
const CANVAS = { width: 3200, height: 1200 };
const TITLE_Y = 70;
const CENTER_Y = 570;
const GAP = 48;
const CARD_MIN_WIDTH = 290;
const CARD_MAX_WIDTH = 390;
const PAD_X = 34;
const PAD_Y = 28;
const FONT_SIZE = 28;
const LINE_HEIGHT = 37;

function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function measureText(value) {
  let width = 0;
  for (const char of value) width += /[\u4e00-\u9fff]/.test(char) ? FONT_SIZE : FONT_SIZE * 0.56;
  return width;
}

function cardsFor(theme) {
  const cards = sourceNodes.map((node, index) => {
    const maxLine = Math.max(...node.lines.map(measureText));
    const width = Math.ceil(Math.min(CARD_MAX_WIDTH, Math.max(CARD_MIN_WIDTH, maxLine + PAD_X * 2)));
    const height = node.lines.length * LINE_HEIGHT + PAD_Y * 2;
    return { ...node, width, height, fill: theme.cards[roles[index]] };
  });
  const totalWidth = cards.reduce((sum, card) => sum + card.width, 0) + GAP * (cards.length - 1);
  if (totalWidth > CANVAS.width - 120) throw new Error(`演示图卡片超出画布：${totalWidth}px`);
  let x = (CANVAS.width - totalWidth) / 2;
  for (const card of cards) {
    card.x = x;
    card.y = CENTER_Y - card.height / 2;
    x += card.width + GAP;
  }
  return new Map(cards.map(card => [card.id, card]));
}

function textSvg(card) {
  const firstY = card.y + card.height / 2 - ((card.lines.length - 1) * LINE_HEIGHT) / 2;
  return `<text x="${card.x + card.width / 2}" y="${firstY}" font-size="${FONT_SIZE}" font-weight="750" text-anchor="middle" fill="${card.fill === '#FFFFFF' ? '#26394F' : '#26394F'}" dominant-baseline="middle">${card.lines.map((line, index) => `<tspan x="${card.x + card.width / 2}" dy="${index ? LINE_HEIGHT : 0}">${esc(line)}</tspan>`).join('')}</text>`;
}

function cardSvg(card) {
  return `<g data-node="${card.id}"><rect x="${card.x}" y="${card.y}" width="${card.width}" height="${card.height}" rx="12" fill="${card.fill}" stroke="#26394F" stroke-width="5" filter="url(#shadow)"/>${textSvg(card)}</g>`;
}

function routeSvg(from, to, cards) {
  const sourceCard = cards.get(from);
  const targetCard = cards.get(to);
  const y = CENTER_Y;
  return `<path data-edge="${from}-&gt;${to}" d="M${sourceCard.x + sourceCard.width} ${y} H${targetCard.x}" fill="none" stroke="#26394F" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#arrow)"/>`;
}

function render(themeName) {
  const theme = themes[themeName];
  const cards = cardsFor(theme);
  const routes = sourceEdges.map(edge => {
    const [from, to] = edge.split('->');
    return routeSvg(from, to, cards);
  }).join('');
  const cardMarkup = [...cards.values()].map(cardSvg).join('');
  const labels = [...cards.values()].map(card => `<text x="${card.x + card.width / 2}" y="${card.y - 26}" font-size="20" font-weight="700" text-anchor="middle" fill="${theme.muted}">阶段 ${card.id.slice(1)}</text>`).join('');
  const outputName = `kmp-core-preview-00-workflow-overview-${themeName}.svg`;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}" viewBox="0 0 ${CANVAS.width} ${CANVAS.height}" role="img" aria-label="Mermaid 可读技术流程图生成工作流" data-theme="${themeName}" data-baseline="inline:workflow-overview-baselineModel" data-baseline-ranks="${esc(baselineModel.ranks.join(','))}" data-layout-model="${baselineModel.layout}" data-symmetry-mode="none" data-symmetry-axis="none" data-symmetry-pairs="" data-symmetry-edge-pairs="" data-symmetry-public-spines="" data-arrow-width="16" data-arrow-height="12" data-source="examples/mermaid/workflow-overview.mmd">
  <defs>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="${theme.grid}" stroke-width="1.2"/></pattern>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="5" stdDeviation="3" flood-color="${theme.ink}" flood-opacity="0.18"/></filter>
    <marker id="arrow" markerWidth="16" markerHeight="12" refX="14" refY="6" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L14,6 L0,12 Z" fill="${theme.ink}"/></marker>
    <style>text{font-family:Arial,"Microsoft YaHei","PingFang SC",sans-serif;letter-spacing:.1px}</style>
  </defs>
  <rect width="${CANVAS.width}" height="${CANVAS.height}" fill="${theme.bg}"/><rect width="${CANVAS.width}" height="${CANVAS.height}" fill="url(#grid)"/>
  <text x="${CANVAS.width / 2}" y="${TITLE_Y}" font-size="30" font-weight="750" text-anchor="middle" fill="${theme.muted}">Mermaid 可读技术流程图生成工作流</text>
  <text x="${CANVAS.width / 2}" y="${TITLE_Y + 44}" font-size="21" font-weight="600" text-anchor="middle" fill="${theme.muted}">从语义源到可复核 SVG：先约束，再布局，最后发布</text>
  ${labels}${routes}${cardMarkup}
</svg>`;
  fs.writeFileSync(path.join(OUTPUT_DIR, outputName), svg, 'utf8');
  console.log(`generated=${outputName} theme=${themeName} nodes=${sourceNodes.length} edges=${sourceEdges.length} baseline=${baselineModel.layout}`);
}

if (sourceNodes.length !== 7 || sourceEdges.length !== 6) throw new Error('workflow-overview.mmd 必须保持 7 个阶段和 6 条连续边。');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
for (const themeName of themeNames) render(themeName);
