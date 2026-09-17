const fs = require('fs');
const path = require('path');
const REPO_ROOT = path.resolve(__dirname, '..');
const EXAMPLE_MERMAID_DIR = path.join(REPO_ROOT, 'examples', 'mermaid');
const EXAMPLE_BASELINE_DIR = path.join(REPO_ROOT, 'examples', 'baseline');
const EXAMPLE_OUTPUT_DIR = path.join(REPO_ROOT, 'examples', 'output');

const themes = {
  paper: {
    bg: '#FBF9F2', grid: '#E6E4DC', ink: '#26394F', muted: '#65758C',
    panels: { read: '#F9FBFE', refresh: '#FFFDF4', stroke: '#C5CEDA' },
    cards: { input: '#C8E1FA', success: '#D7EED8', decision: '#FFE9A8', neutral: '#FFFFFF', complex: '#E4D3F3', cancel: '#F7CBC5', quiet: '#E6E9EE' },
  },
  mint: {
    bg: '#F3FAF7', grid: '#DCEBE7', ink: '#26394F', muted: '#607B7C',
    panels: { read: '#F5FCFA', refresh: '#FAF8EE', stroke: '#BED4CD' },
    cards: { input: '#CDE8F6', success: '#CFE9D6', decision: '#F8E9B4', neutral: '#FFFFFF', complex: '#E3D9F1', cancel: '#F4D3D1', quiet: '#E3ECEA' },
  },
  warm: {
    bg: '#FFF8ED', grid: '#EFE1D1', ink: '#26394F', muted: '#786B63',
    panels: { read: '#FFFDF7', refresh: '#FFF6E7', stroke: '#E6CDAF' },
    cards: { input: '#D6E6F5', success: '#D9E9D3', decision: '#F6DEA6', neutral: '#FFFFFF', complex: '#E8D8EB', cancel: '#F4D2C5', quiet: '#ECE7DE' },
  },
  mist: {
    bg: '#F4F7FB', grid: '#DDE5EF', ink: '#26394F', muted: '#687A91',
    panels: { read: '#F8FBFF', refresh: '#FFFDF4', stroke: '#C7D2E0' },
    cards: { input: '#CFE0F4', success: '#D2E7DF', decision: '#F4E6B4', neutral: '#FFFFFF', complex: '#DCD9EE', cancel: '#F3D2D4', quiet: '#E4E9F0' },
  },
};

const args = process.argv.slice(2);
const fixedTheme = args.find(arg => Object.prototype.hasOwnProperty.call(themes, arg));
const randomRequested = args.includes('random');
const onlyArg = args.find(arg => arg.startsWith('only='))?.slice('only='.length);
if (fixedTheme && randomRequested) throw new Error('Choose either random or one fixed theme, not both.');
const themeMode = randomRequested ? 'random' : 'fixed';
const themeNames = Object.keys(themes);
const themeName = fixedTheme || (randomRequested ? themeNames[Math.floor(Math.random() * themeNames.length)] : 'paper');
const C = themes[themeName];

const CANVAS_WIDTH = 2400;
const CANVAS_HEIGHT = 1350;
const FONT_SIZE = 30;
const LINE_HEIGHT = 39;
const PAD_X = 30;
const PAD_Y = 22;
const MIN_WIDTH = 220;
const MAX_WIDTH = 440;
const MAX_CONTENT_WIDTH = MAX_WIDTH - PAD_X * 2;
const MAX_LINES = 3;

function equalizeCardPair(cards, ids) {
  const width = Math.max(...ids.map(id => cards.get(id).width));
  const height = Math.max(...ids.map(id => cards.get(id).height));
  for (const id of ids) {
    cards.get(id).width = width;
    cards.get(id).height = height;
  }
}

function parseOrthogonalSegments(d) {
  const tokens = [...d.matchAll(/[MLHV]|-?\d+(?:\.\d+)?/g)].map(match => match[0]);
  let i = 0; let x = 0; let y = 0; let command = ''; const segments = [];
  while (i < tokens.length) {
    if (/^[MLHV]$/.test(tokens[i])) command = tokens[i++];
    if (command === 'M' || command === 'L') {
      const nextX = Number(tokens[i++]); const nextY = Number(tokens[i++]);
      if (command === 'L') segments.push({ x1: x, y1: y, x2: nextX, y2: nextY });
      x = nextX; y = nextY;
    } else if (command === 'H') {
      const nextX = Number(tokens[i++]); segments.push({ x1: x, y1: y, x2: nextX, y2: y }); x = nextX;
    } else if (command === 'V') {
      const nextY = Number(tokens[i++]); segments.push({ x1: x, y1: y, x2: x, y2: nextY }); y = nextY;
    }
  }
  return segments;
}

function segmentSignature(segment) {
  return [segment.x1, segment.y1, segment.x2, segment.y2].join(',');
}

function mirrorSegments(segments, symmetry) {
  return segments.map(segment => {
    if (symmetry.axis === 'horizontal') {
      return { x1: segment.x1, y1: 2 * symmetry.center - segment.y1, x2: segment.x2, y2: 2 * symmetry.center - segment.y2 };
    }
    return { x1: 2 * symmetry.center - segment.x1, y1: segment.y1, x2: 2 * symmetry.center - segment.x2, y2: segment.y2 };
  });
}

function sameSegmentSet(leftSegments, rightSegments, tolerance = 2) {
  if (leftSegments.length !== rightSegments.length) return false;
  const remaining = rightSegments.map(segment => ({ ...segment }));
  const close = (a, b) => Math.abs(a.x1 - b.x1) <= tolerance && Math.abs(a.y1 - b.y1) <= tolerance
    && Math.abs(a.x2 - b.x2) <= tolerance && Math.abs(a.y2 - b.y2) <= tolerance;
  for (const segment of leftSegments) {
    const index = remaining.findIndex(candidate => close(segment, candidate) || close(segment, { x1: candidate.x2, y1: candidate.y2, x2: candidate.x1, y2: candidate.y1 }));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
}

function pathEndpoints(d) {
  const segments = parseOrthogonalSegments(d);
  if (!segments.length) throw new Error(`Path has no drawable segment: ${d}`);
  return {
    start: { x: segments[0].x1, y: segments[0].y1 },
    end: { x: segments[segments.length - 1].x2, y: segments[segments.length - 1].y2 },
  };
}

function pointOnCardBoundary(point, card, tolerance = 3) {
  const right = card.x + card.width;
  const bottom = card.y + card.height;
  const onVerticalEdge = (Math.abs(point.x - card.x) <= tolerance || Math.abs(point.x - right) <= tolerance)
    && point.y >= card.y - tolerance && point.y <= bottom + tolerance;
  const onHorizontalEdge = (Math.abs(point.y - card.y) <= tolerance || Math.abs(point.y - bottom) <= tolerance)
    && point.x >= card.x - tolerance && point.x <= right + tolerance;
  return onVerticalEdge || onHorizontalEdge;
}

function validateRouteConnections(graph, cards, routeData) {
  const routeMap = new Map(routeData.map(route => [route.edge, route.d]));
  for (const edge of graph.edges) {
    const d = routeMap.get(edge.key);
    if (!d) throw new Error(`${edge.key}: MISSING_ROUTE`);
    const endpoints = pathEndpoints(d);
    if (!pointOnCardBoundary(endpoints.start, cards.get(edge.from))) {
      throw new Error(`${edge.key}: ENDPOINT_DISCONNECTED start=${edge.from}`);
    }
    if (!pointOnCardBoundary(endpoints.end, cards.get(edge.to))) {
      throw new Error(`${edge.key}: ENDPOINT_DISCONNECTED end=${edge.to}`);
    }
    const target = cards.get(edge.to); const segments = parseOrthogonalSegments(d); const last = segments[segments.length - 1];
    const tolerance = 3; const left = target.x; const right = target.x + target.width;
    const top = target.y; const bottom = target.y + target.height;
    const onLeft = Math.abs(endpoints.end.x - left) <= tolerance;
    const onRight = Math.abs(endpoints.end.x - right) <= tolerance;
    const onTop = Math.abs(endpoints.end.y - top) <= tolerance;
    const onBottom = Math.abs(endpoints.end.y - bottom) <= tolerance;
    const horizontal = Math.abs(last.y1 - last.y2) <= tolerance;
    const vertical = Math.abs(last.x1 - last.x2) <= tolerance;
    if (onLeft && !onRight) {
      if (!horizontal || last.x2 <= last.x1) throw new Error(`${edge.key}: REVERSE_ENTRY target=${edge.to} boundary=left`);
    } else if (onRight && !onLeft) {
      if (!horizontal || last.x2 >= last.x1) throw new Error(`${edge.key}: REVERSE_ENTRY target=${edge.to} boundary=right`);
    } else if (onTop && !onBottom) {
      if (!vertical || last.y2 <= last.y1) throw new Error(`${edge.key}: REVERSE_ENTRY target=${edge.to} boundary=top`);
    } else if (onBottom && !onTop) {
      if (!vertical || last.y2 >= last.y1) throw new Error(`${edge.key}: REVERSE_ENTRY target=${edge.to} boundary=bottom`);
    } else if (!horizontal && !vertical) {
      throw new Error(`${edge.key}: NON_ORTHOGONAL_FINAL_SEGMENT`);
    }
  }
}

function routeSegmentsCross(a, b) {
  const horizontalA = Math.abs(a.y1 - a.y2) < 0.01;
  const horizontalB = Math.abs(b.y1 - b.y2) < 0.01;
  if ((horizontalA && horizontalB) || (!horizontalA && !horizontalB)) return false;
  const horizontal = horizontalA ? a : b;
  const vertical = horizontalA ? b : a;
  return vertical.x1 > Math.min(horizontal.x1, horizontal.x2) + 1
    && vertical.x1 < Math.max(horizontal.x1, horizontal.x2) - 1
    && horizontal.y1 > Math.min(vertical.y1, vertical.y2) + 1
    && horizontal.y1 < Math.max(vertical.y1, vertical.y2) - 1;
}

function routeSegmentOverlap(a, b) {
  const horizontalA = Math.abs(a.y1 - a.y2) < 0.01;
  const horizontalB = Math.abs(b.y1 - b.y2) < 0.01;
  if (horizontalA && horizontalB && Math.abs(a.y1 - b.y1) < 1) {
    return Math.min(Math.max(a.x1, a.x2), Math.max(b.x1, b.x2)) - Math.max(Math.min(a.x1, a.x2), Math.min(b.x1, b.x2));
  }
  if (!horizontalA && !horizontalB && Math.abs(a.x1 - b.x1) < 1) {
    return Math.min(Math.max(a.y1, a.y2), Math.max(b.y1, b.y2)) - Math.max(Math.min(a.y1, a.y2), Math.min(b.y1, b.y2));
  }
  return 0;
}

function routeSegmentInsideCard(segment, card, inset = 4) {
  const left = card.x + inset; const right = card.x + card.width - inset;
  const top = card.y + inset; const bottom = card.y + card.height - inset;
  const horizontal = Math.abs(segment.y1 - segment.y2) < 0.01;
  if (horizontal) return segment.y1 > top && segment.y1 < bottom
    && Math.max(Math.min(segment.x1, segment.x2), left) < Math.min(Math.max(segment.x1, segment.x2), right);
  return segment.x1 > left && segment.x1 < right
    && Math.max(Math.min(segment.y1, segment.y2), top) < Math.min(Math.max(segment.y1, segment.y2), bottom);
}

function validateRouteGeometry(spec, graph, cards, routeData) {
  const fail = (code, message) => { throw new Error(`${spec.id}: ${code} ${message}`); };
  const allowedSpines = new Set((spec.symmetry?.groups || (spec.symmetry ? [spec.symmetry] : []))
    .flatMap(group => group.publicSpine || []).map(pair => pair.join('|')));
  for (const [firstId, first] of cards) for (const [secondId, second] of cards) {
    if (firstId >= secondId) continue;
    const overlapX = Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x));
    const overlapY = Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y));
    if (overlapX * overlapY > 1) fail('CARD_OVERLAP', `cards ${firstId}/${secondId} overlap`);
  }
  for (const route of routeData) {
    const segments = parseOrthogonalSegments(route.d);
    for (const segment of segments) for (const [cardId, card] of cards) {
      const isEndpoint = route.edge.startsWith(`${cardId}->`) || route.edge.endsWith(`->${cardId}`);
      if (!isEndpoint && routeSegmentInsideCard(segment, card)) fail('ROUTE_CARD_HIT', `${route.edge} passes through ${cardId}`);
    }
  }
  for (let i = 0; i < routeData.length; i++) for (let j = i + 1; j < routeData.length; j++) {
    const first = routeData[i]; const second = routeData[j];
    const pair = [first.edge, second.edge].sort().join('|');
    for (const a of parseOrthogonalSegments(first.d)) for (const b of parseOrthogonalSegments(second.d)) {
      const overlap = routeSegmentOverlap(a, b);
      if (overlap > 1 && !allowedSpines.has(pair)) fail('ILLEGAL_SHARED_SEGMENT', `${first.edge}/${second.edge}`);
      if (!overlap && routeSegmentsCross(a, b)) fail('CROSSING', `${first.edge}/${second.edge}`);
    }
  }
  for (const edge of graph.edges) if (!routeData.some(route => route.edge === edge.key)) fail('MISSING_ROUTE', edge.key);
}

function validateZoneContainment(spec, cards) {
  if (!spec.zoneCards || !spec.zones?.length) return;
  const inset = spec.zoneInset ?? 36;
  for (const [zoneId, cardIds] of Object.entries(spec.zoneCards)) {
    const zone = spec.zones.find(item => item.id === zoneId);
    if (!zone) throw new Error(`${spec.id}: zoneCards references missing zone ${zoneId}`);
    const zoneRight = zone.x + zone.width; const zoneBottom = zone.y + zone.height;
    for (const cardId of cardIds) {
      const card = cards.get(cardId);
      if (!card) throw new Error(`${spec.id}: zoneCards references missing card ${cardId}`);
      const cardRight = card.x + card.width; const cardBottom = card.y + card.height;
      if (card.x < zone.x + inset || card.y < zone.y + inset || cardRight > zoneRight - inset || cardBottom > zoneBottom - inset) {
        throw new Error(`${spec.id}: FRAME_OVERFLOW ${cardId} outside ${zoneId} safe area (inset=${inset})`);
      }
    }
  }
}

const specs = [
  {
    id: '01-global',
    source: 'kmp-core-preview-01-global.mmd',
    baseline: 'kmp-core-preview-01-global-mermaid-baseline.svg',
    output: 'kmp-core-preview-01-global.svg',
    title: 'KMP 全局心智模型：共享能力与平台边界',
    symmetry: { mode: 'strict', axis: 'horizontal', center: 675, pairs: [['A', 'I'], ['AU', 'IU']], edgePairs: [['S->A', 'S->I'], ['A->AU', 'I->IU']], publicSpine: [['S->A', 'S->I']] },
    roles: { Q: 'input', S: 'success', A: 'complex', I: 'complex', AU: 'success', IU: 'success' },
    layout(cards) {
      const set = (id, x, y) => { const c = cards.get(id); c.x = x - c.width / 2; c.y = y - c.height / 2; };
      const setLeft = (id, x, y) => { const c = cards.get(id); c.x = x; c.y = y - c.height / 2; };
      equalizeCardPair(cards, ['A', 'I']); equalizeCardPair(cards, ['AU', 'IU']);
      set('Q', 180, 675); set('S', 650, 675);
      setLeft('A', 1260, 400); setLeft('I', 1260, 950);
      setLeft('AU', 2040, 400); setLeft('IU', 2040, 950);
    },
    routes(cards, edge, route) {
      const c = id => cards.get(id); const right = id => c(id).x + c(id).width; const left = id => c(id).x;
      const cy = id => c(id).y + c(id).height / 2;
      const lane = 1060;
      if (edge === 'Q->S') return route(edge, `M${right('Q')} ${cy('Q')} H${left('S')}`);
      if (edge === 'S->A') return route(edge, `M${right('S')} ${cy('S')} H${lane} V${cy('A')} H${left('A')}`);
      if (edge === 'S->I') return route(edge, `M${right('S')} ${cy('S')} H${lane} V${cy('I')} H${left('I')}`);
      if (edge === 'A->AU' || edge === 'I->IU') { const [from, to] = edge.split('->'); return route(edge, `M${right(from)} ${cy(from)} H${left(to)}`); }
      throw new Error(`No route for ${edge}`);
    },
  },
  {
    id: '02-compilation',
    source: 'kmp-core-preview-02-compilation.mmd',
    baseline: 'kmp-core-preview-02-compilation-mermaid-baseline.svg',
    output: 'kmp-core-preview-02-compilation.svg',
    title: 'KMP 编译链：同一份共享源码进入不同 Target 的编译过程',
    symmetry: { mode: 'strict', axis: 'horizontal', center: 675, pairs: [['A', 'I'], ['AS', 'IS'], ['AB', 'IF']], edgePairs: [['T->A', 'T->I'], ['A->AS', 'I->IS'], ['AS->AB', 'IS->IF']], publicSpine: [['T->A', 'T->I']] },
    roles: { M: 'input', T: 'decision', A: 'complex', I: 'complex', AS: 'success', IS: 'success', AB: 'input', IF: 'input' },
    layout(cards) {
      const set = (id, x, y) => { const c = cards.get(id); c.x = x - c.width / 2; c.y = y - c.height / 2; };
      const setLeft = (id, x, y) => { const c = cards.get(id); c.x = x; c.y = y - c.height / 2; };
      equalizeCardPair(cards, ['A', 'I']); equalizeCardPair(cards, ['AS', 'IS']); equalizeCardPair(cards, ['AB', 'IF']);
      set('M', 180, 675); set('T', 565, 675);
      setLeft('A', 820, 420); setLeft('I', 820, 930);
      setLeft('AS', 1330, 420); setLeft('IS', 1330, 930); setLeft('AB', 1990, 420); setLeft('IF', 1990, 930);
    },
    routes(cards, edge, route) {
      const c = id => cards.get(id); const right = id => c(id).x + c(id).width; const left = id => c(id).x;
      const cy = id => c(id).y + c(id).height / 2;
      if (edge === 'M->T') return route(edge, `M${right('M')} ${cy('M')} H${left('T')}`);
      const branchX = 730;
      if (edge === 'T->A') return route(edge, `M${right('T')} ${cy('T')} H${branchX} V${cy('A')} H${left('A')}`);
      if (edge === 'T->I') return route(edge, `M${right('T')} ${cy('T')} H${branchX} V${cy('I')} H${left('I')}`);
      if (edge === 'A->AS' || edge === 'I->IS' || edge === 'AS->AB' || edge === 'IS->IF') {
        const [from, to] = edge.split('->'); return route(edge, `M${right(from)} ${cy(from)} H${left(to)}`);
      }
      throw new Error(`No route for ${edge}`);
    },
  },
  {
    id: '03-source-set',
    source: 'kmp-core-preview-03-source-set.mmd',
    baseline: 'kmp-core-preview-03-source-set-mermaid-baseline.svg',
    output: 'kmp-core-preview-03-source-set.svg',
    title: 'Source Set 层级：共享范围逐层收窄到平台 Target',
    symmetry: { mode: 'partial', axis: 'vertical', center: 1790, pairs: [['ARM', 'SIM']], edgePairs: [['IOS->ARM', 'IOS->SIM']], publicSpine: [['IOS->ARM', 'IOS->SIM']] },
    roles: { C: 'success', A: 'input', N: 'complex', AP: 'complex', IOS: 'success', ARM: 'cancel', SIM: 'cancel' },
    layout(cards) {
      const set = (id, x, y) => { const c = cards.get(id); c.x = x - c.width / 2; c.y = y - c.height / 2; };
      equalizeCardPair(cards, ['ARM', 'SIM']);
      set('C', 1200, 180); set('A', 610, 455); set('N', 1790, 455); set('AP', 1790, 685); set('IOS', 1790, 915);
      set('ARM', 1480, 1165); set('SIM', 2100, 1165);
    },
    routes(cards, edge, route) {
      const c = id => cards.get(id); const cx = id => c(id).x + c(id).width / 2; const cy = id => c(id).y + c(id).height / 2;
      const top = id => c(id).y; const bottom = id => c(id).y + c(id).height;
      // 两条下游边必须从父节点底部立即分配独立通道，不能共享一段未声明的中继竖线。
      if (edge === 'C->A') return route(edge, `M${cx('C') - 70} ${bottom('C')} V260 H${cx('A')} V${top('A')}`);
      if (edge === 'C->N') return route(edge, `M${cx('C') + 70} ${bottom('C')} V340 H${cx('N')} V${top('N')}`);
      if (edge === 'N->AP' || edge === 'AP->IOS') { const [from, to] = edge.split('->'); return route(edge, `M${cx(from)} ${bottom(from)} V${top(to)}`); }
      if (edge === 'IOS->ARM') return route(edge, `M${cx('IOS')} ${bottom('IOS')} V1060 H${cx('ARM')} V${top('ARM')}`);
      if (edge === 'IOS->SIM') return route(edge, `M${cx('IOS')} ${bottom('IOS')} V1060 H${cx('SIM')} V${top('SIM')}`);
      throw new Error(`No route for ${edge}`);
    },
  },
  {
    id: '04-platform-boundary',
    source: 'kmp-core-preview-04-platform-boundary.mmd',
    baseline: 'kmp-core-preview-04-platform-boundary-mermaid-baseline.svg',
    output: 'kmp-core-preview-04-platform-boundary.svg',
    canvas: { width: 2000, height: 1125 },
    title: '平台差异决策：先找库，再判断稳定性，最后选择抽象方式',
    symmetry: {
      mode: 'partial',
      reason: '整棵树的深度不相等，不能宣称全图镜像；对称验收拆成两层可对称的兄弟分支',
      groups: [
        { id: 'library-decision', axis: 'vertical', center: 1000, pairs: [['Common', 'Simple']], edgePairs: [['Lib->Common', 'Lib->Simple']], cardMode: 'inner-edge' },
        { id: 'abstraction-decision', axis: 'vertical', centerFrom: 'Simple', pairs: [['EA', 'Contract']], edgePairs: [['Simple->EA', 'Simple->Contract']], cardMode: 'inner-edge' },
      ],
    },
    roles: { Start: 'input', Lib: 'decision', Common: 'success', Simple: 'decision', EA: 'complex', Contract: 'complex', Inject: 'cancel', Fake: 'success' },
    layout(cards) {
      const set = (id, x, y) => { const c = cards.get(id); c.x = x - c.width / 2; c.y = y - c.height / 2; };
      const setRight = (id, right, centerY) => { const c = cards.get(id); c.x = right - c.width; c.y = centerY - c.height / 2; };
      const setLeft = (id, left, centerY) => { const c = cards.get(id); c.x = left; c.y = centerY - c.height / 2; };
      set('Start', 1000, 130); set('Lib', 1000, 300);
      // 第一层用“内侧边界”镜像，卡片仍按文字自然宽度向外增长。
      setRight('Common', 680, 470); setLeft('Simple', 1320, 470);
      const simple = cards.get('Simple');
      const simpleAxis = simple.x + simple.width / 2;
      // 第二层以 Simple 的真实左右边界向外留通道，而不是用“中心 ± 固定值”。
      // 后者在动态卡片变宽后会让目标卡片与来源列发生横向侵入，导致箭头从错误法向进入。
      setRight('EA', simple.x - 80, 720); setLeft('Contract', simple.x + simple.width + 80, 720);
      const contractAxis = cards.get('Contract').x + cards.get('Contract').width / 2;
      set('Inject', contractAxis, 900); set('Fake', contractAxis, 1055);
    },
    routes(cards, edge, route) {
      const c = id => cards.get(id); const cx = id => c(id).x + c(id).width / 2; const right = id => c(id).x + c(id).width; const left = id => c(id).x;
      const cy = id => c(id).y + c(id).height / 2; const top = id => c(id).y; const bottom = id => c(id).y + c(id).height;
      if (edge === 'Start->Lib') return route(edge, `M${cx('Start')} ${bottom('Start')} V${top('Lib')}`);
      const firstLeftLane = left('Lib') - 24; const firstRightLane = right('Lib') + 24;
      if (edge === 'Lib->Common') return route(edge, `M${left('Lib')} ${cy('Lib')} H${firstLeftLane} V${cy('Common')} H${right('Common')}`, null, [(firstLeftLane + right('Common')) / 2, cy('Common') - 30, '是']);
      if (edge === 'Lib->Simple') return route(edge, `M${right('Lib')} ${cy('Lib')} H${firstRightLane} V${cy('Simple')} H${left('Simple')}`, null, [(firstRightLane + left('Simple')) / 2, cy('Simple') - 30, '否']);
      // 第二层也使用独立、镜像的通道；目标卡片从内侧边界收线，避免线进入卡片内部。
      const leftLane = (left('Simple') + right('EA')) / 2; const rightLane = (right('Simple') + left('Contract')) / 2;
      const branchLabelY = (cy('Simple') + cy('EA')) / 2;
      const abstractionSourceY = cy('Simple') + 24;
      if (edge === 'Simple->EA') return route(edge, `M${left('Simple')} ${abstractionSourceY} H${leftLane} V${cy('EA')} H${right('EA')}`, null, [leftLane - 35, branchLabelY, '是']);
      if (edge === 'Simple->Contract') return route(edge, `M${right('Simple')} ${abstractionSourceY} H${rightLane} V${cy('Contract')} H${left('Contract')}`, null, [rightLane + 35, branchLabelY, '否']);
      if (edge === 'Contract->Inject' || edge === 'Inject->Fake') { const [from, to] = edge.split('->'); return route(edge, `M${cx(from)} ${bottom(from)} V${top(to)}`); }
      throw new Error(`No route for ${edge}`);
    },
  },
  {
    id: '05-repository',
    source: 'kmp-core-preview-05-repository.mmd',
    baseline: 'kmp-core-preview-05-repository-mermaid-baseline.svg',
    output: 'kmp-core-preview-05-repository.svg',
    canvas: { width: 2000, height: 1125 },
    title: 'Repository 刷新闭环：Local 是 UI 观察的状态源',
    symmetry: { mode: 'none', axis: 'none', center: 0, pairs: [], edgePairs: [], reason: '数据刷新、缓存回退和 UI 状态闭环具有不同出口，不强行镜像' },
    zones: [
      { id: 'read-loop', x: 48, y: 110, width: 1840, height: 465, label: '读取闭环', fill: 'read' },
      { id: 'refresh-loop', x: 48, y: 590, width: 1840, height: 500, label: '刷新链与失败回退', fill: 'refresh' },
    ],
    roles: { UI: 'input', Local: 'success', Refresh: 'input', Repo: 'complex', Remote: 'success', OK: 'decision', Save: 'success', Cache: 'decision', Error: 'cancel', State: 'complex' },
    layout(cards) {
      const set = (id, x, y) => { const c = cards.get(id); c.x = x - c.width / 2; c.y = y - c.height / 2; };
      // 分层布局：上方只读 UI–Local–UiState 闭环，下方独立承载刷新与缓存分支。
      // Local 的两个写回入口从下方左右汇入，避免所有连线挤在同一侧。
      set('UI', 250, 220); set('Local', 950, 500); set('State', 1600, 220);
      set('Refresh', 220, 800); set('Repo', 520, 800); set('Remote', 850, 800); set('OK', 1180, 800); set('Save', 1580, 700);
      set('Cache', 1180, 1000); set('Error', 1580, 1000);
    },
    routes(cards, edge, route) {
      const c = id => cards.get(id); const cx = id => c(id).x + c(id).width / 2; const right = id => c(id).x + c(id).width; const left = id => c(id).x;
      const cy = id => c(id).y + c(id).height / 2; const top = id => c(id).y; const bottom = id => c(id).y + c(id).height;
      if (edge === 'UI->Local') return route(edge, `M${cx('UI')} ${bottom('UI')} V${cy('Local')} H${left('Local')}`);
      if (edge === 'Refresh->Repo' || edge === 'Repo->Remote' || edge === 'Remote->OK') { const [from, to] = edge.split('->'); return route(edge, `M${right(from)} ${cy(from)} H${left(to)}`); }
      const saveLane = left('Save') - 30;
      if (edge === 'OK->Save') return route(edge, `M${right('OK')} ${cy('OK')} H${saveLane} V${cy('Save')} H${left('Save')}`, null, [(right('OK') + saveLane) / 2, cy('OK') - 30, '是']);
      if (edge === 'OK->Cache') return route(edge, `M${cx('OK')} ${bottom('OK')} V${top('Cache')}`, null, [cx('OK') + 35, (bottom('OK') + top('Cache')) / 2, '否']);
      if (edge === 'Save->Local') return route(edge, `M${right('Save')} ${cy('Save')} H1850 V600 H1100 V${bottom('Local')}`);
      // 缓存命中沿左侧独立回收通道上行，再从 Local 左下角收线，避开刷新链的水平连接线。
      if (edge === 'Cache->Local') return route(edge, `M${left('Cache')} ${cy('Cache')} H70 V${bottom('Local')} H${left('Local')}`, null, [left('Cache') - 35, cy('Cache') - 30, '有']);
      if (edge === 'Cache->Error') return route(edge, `M${right('Cache')} ${cy('Cache')} H${left('Error')}`, null, [(right('Cache') + left('Error')) / 2, cy('Cache') - 30, '无']);
      if (edge === 'Local->State') return route(edge, `M${right('Local')} ${cy('Local')} H${cx('State')} V${bottom('State')}`);
      if (edge === 'State->UI') return route(edge, `M${left('State')} ${cy('State')} H${right('UI')}`);
      throw new Error(`No route for ${edge}`);
    },
  },
  {
    id: '06-dispatcher',
    source: 'kmp-core-preview-06-dispatcher.mmd',
    baseline: 'kmp-core-preview-06-dispatcher-mermaid-baseline.svg',
    output: 'kmp-core-preview-06-dispatcher.svg',
    canvas: { width: 2000, height: 1125 },
    title: 'Dispatcher 选择：先判断工作性质',
    symmetry: { mode: 'none', axis: 'none', center: 0, pairs: [], edgePairs: [], reason: '决策链向下推进，命中条件后向右收敛到不同 dispatcher，不强行镜像' },
    zones: [
      { id: 'decision-chain', x: 480, y: 90, width: 560, height: 970, label: '逐层判断', fill: 'read' },
      { id: 'dispatcher-outcomes', x: 1220, y: 250, width: 650, height: 650, label: '执行上下文', fill: 'refresh' },
    ],
    roles: { Work: 'input', UI: 'decision', CPU: 'decision', Block: 'decision', Caller: 'quiet', Main: 'success', Default: 'input', IO: 'success' },
    layout(cards) {
      const set = (id, x, y) => { const c = cards.get(id); c.x = x - c.width / 2; c.y = y - c.height / 2; };
      set('Work', 760, 160); set('UI', 760, 360); set('CPU', 760, 560); set('Block', 760, 760); set('Caller', 760, 970);
      set('Main', 1500, 360); set('Default', 1500, 560); set('IO', 1500, 760);
    },
    routes(cards, edge, route) {
      const c = id => cards.get(id); const cx = id => c(id).x + c(id).width / 2; const right = id => c(id).x + c(id).width; const left = id => c(id).x;
      const cy = id => c(id).y + c(id).height / 2; const top = id => c(id).y; const bottom = id => c(id).y + c(id).height;
      if (edge === 'Work->UI' || edge === 'UI->CPU' || edge === 'CPU->Block' || edge === 'Block->Caller') {
        const [from, to] = edge.split('->');
        const badge = edge === 'UI->CPU' ? [cx(from) + 38, (bottom(from) + top(to)) / 2, '否']
          : edge === 'CPU->Block' ? [cx(from) + 38, (bottom(from) + top(to)) / 2, '否']
          : edge === 'Block->Caller' ? [cx(from) + 38, (bottom(from) + top(to)) / 2, '否'] : null;
        return route(edge, `M${cx(from)} ${bottom(from)} V${top(to)}`, null, badge);
      }
      if (edge === 'UI->Main') return route(edge, `M${right('UI')} ${cy('UI')} H${left('Main')}`, null, [(right('UI') + left('Main')) / 2, cy('UI') - 30, '是']);
      if (edge === 'CPU->Default') return route(edge, `M${right('CPU')} ${cy('CPU')} H${left('Default')}`, null, [(right('CPU') + left('Default')) / 2, cy('CPU') - 30, '是']);
      if (edge === 'Block->IO') return route(edge, `M${right('Block')} ${cy('Block')} H${left('IO')}`, null, [(right('Block') + left('IO')) / 2, cy('Block') - 30, '是']);
      throw new Error(`No route for ${edge}`);
    },
  },
  {
    id: '07-job-exception',
    source: 'kmp-core-preview-07-job-exception.mmd',
    baseline: 'kmp-core-preview-07-job-exception-mermaid-baseline.svg',
    output: 'kmp-core-preview-07-job-exception.svg',
    canvas: { width: 2400, height: 1200 },
    title: 'Job 树与异常传播：普通作用域 vs supervisorScope',
    symmetry: {
      mode: 'partial', axis: 'vertical', center: 1800,
      groups: [
        { id: 'supervisor-children', axis: 'vertical', center: 1800, pairs: [['SA', 'SB']], edgePairs: [['S->SA', 'S->SB']] },
        { id: 'supervisor-outcomes', axis: 'vertical', center: 1800, pairs: [['SFail', 'SHandle']], edgePairs: [['SAwait->SFail', 'SAwait->SHandle']] },
      ],
      reason: 'supervisorScope 的两个子协程和最终处理结果具有局部镜像关系；普通作用域链与 supervisorScope 语义不同，不宣称整图对称',
    },
    zones: [
      { id: 'normal-job', x: 60, y: 95, width: 1080, height: 1080, label: '普通 Parent Job', fill: 'read' },
      { id: 'supervisor-job', x: 1260, y: 95, width: 1080, height: 1080, label: 'supervisorScope', fill: 'refresh' },
    ],
    roles: {
      P: 'complex', A: 'input', B: 'input', AF: 'cancel', D: 'complex', Await: 'complex', Throw: 'cancel', PF: 'cancel', Cancel: 'cancel',
      S: 'complex', SA: 'input', SB: 'input', SD: 'cancel', SAwait: 'complex', SFail: 'cancel', SHandle: 'success',
    },
    layout(cards) {
      const set = (id, x, y) => { const c = cards.get(id); c.x = x - c.width / 2; c.y = y - c.height / 2; };
      equalizeCardPair(cards, ['SA', 'SB']); equalizeCardPair(cards, ['SFail', 'SHandle']);
      set('P', 600, 170); set('A', 360, 300); set('B', 840, 300); set('AF', 360, 450); set('D', 360, 600); set('Await', 360, 750); set('Throw', 360, 900); set('PF', 360, 1050); set('Cancel', 840, 1050);
      set('S', 1800, 170); set('SA', 1600, 300); set('SB', 2000, 300); set('SD', 1800, 500); set('SAwait', 1800, 700); set('SFail', 1500, 980); set('SHandle', 2100, 980);
    },
    routes(cards, edge, route) {
      const c = id => cards.get(id); const cx = id => c(id).x + c(id).width / 2; const right = id => c(id).x + c(id).width; const left = id => c(id).x;
      const cy = id => c(id).y + c(id).height / 2; const top = id => c(id).y; const bottom = id => c(id).y + c(id).height;
      if (edge === 'P->A') return route(edge, `M${left('P')} ${cy('P')} H${cx('A')} V${top('A')}`);
      if (edge === 'P->B') return route(edge, `M${right('P')} ${cy('P')} H${cx('B')} V${top('B')}`);
      if (edge === 'A->AF' || edge === 'AF->D' || edge === 'D->Await' || edge === 'Await->Throw' || edge === 'Throw->PF') {
        const [from, to] = edge.split('->'); return route(edge, `M${cx(from)} ${bottom(from)} V${top(to)}`);
      }
      if (edge === 'PF->Cancel') return route(edge, `M${right('PF')} ${cy('PF')} H${left('Cancel')}`);
      if (edge === 'S->SA') return route(edge, `M${left('S')} ${cy('S')} H${cx('SA')} V${top('SA')}`);
      if (edge === 'S->SB') return route(edge, `M${right('S')} ${cy('S')} H${cx('SB')} V${top('SB')}`);
      if (edge === 'SA->SD') return route(edge, `M${cx('SA')} ${bottom('SA')} H${cx('SD')} V${top('SD')}`);
      if (edge === 'SD->SAwait') return route(edge, `M${cx('SD')} ${bottom('SD')} V${top('SAwait')}`);
      if (edge === 'SAwait->SFail') return route(edge, `M${left('SAwait')} ${cy('SAwait')} H${cx('SFail')} V${top('SFail')}`);
      if (edge === 'SAwait->SHandle') return route(edge, `M${right('SAwait')} ${cy('SAwait')} H${cx('SHandle')} V${top('SHandle')}`);
      throw new Error(`No route for ${edge}`);
    },
  },
  {
    id: '08-stateflow-lifecycle',
    kind: 'sequence',
    source: 'kmp-core-preview-08-stateflow-lifecycle.mmd',
    baseline: 'kmp-core-preview-08-stateflow-lifecycle-mermaid-baseline.svg',
    output: 'kmp-core-preview-08-stateflow-lifecycle.svg',
    canvas: { width: 2400, height: 1250 },
    title: 'StateFlow 与 WhileSubscribed：双层生命周期',
    participantXs: [250, 820, 1450, 2130],
    participantRoles: ['input', 'complex', 'success', 'complex'],
    messageYs: [250, 340, 430, 520, 620, 700, 780, 870, 970, 1060, 1150],
    symmetryReason: '时序消息按时间顺序展开，不将参与者泳道误判为镜像流程',
  },
  {
    id: '09-flow-operators',
    source: 'kmp-core-preview-09-flow-operators.mmd',
    baseline: 'kmp-core-preview-09-flow-operators-mermaid-baseline.svg',
    output: 'kmp-core-preview-09-flow-operators.svg',
    canvas: { width: 2400, height: 1200 },
    title: 'Flow 操作符选择：先判断每个值、最新值与取消边界',
    symmetry: {
      mode: 'partial',
      reason: '决策树的四组兄弟分支可以局部镜像，但整张图不是完整镜像结构',
      groups: [
        { id: 'every-split', axis: 'horizontal', center: 600, pairs: [['Slow', 'Latest']], edgePairs: [['Every->Slow', 'Every->Latest']] },
        { id: 'slow-choice', axis: 'horizontal', center: 350, cardMode: 'inner-edge', cardOnly: true, pairs: [['Buffer', 'Collect']], edgePairs: [] },
        { id: 'latest-choice', axis: 'horizontal', center: 850, cardMode: 'inner-edge', cardOnly: true, pairs: [['Conflate', 'LatestWork']], edgePairs: [] },
        { id: 'cancel-choice', axis: 'horizontal', center: 980.5, cardMode: 'inner-edge', cardOnly: true, pairs: [['CollectLatest', 'FlatLatest']], edgePairs: [] },
      ],
    },
    roles: {
      Input: 'input', Every: 'decision', Slow: 'decision', Buffer: 'input', Collect: 'neutral',
      Latest: 'decision', Conflate: 'decision', LatestWork: 'decision', CollectLatest: 'cancel', FlatLatest: 'complex',
    },
    layout(cards) {
      const set = (id, x, y) => { const c = cards.get(id); c.x = x - c.width / 2; c.y = y - c.height / 2; };
      equalizeCardPair(cards, ['Slow', 'Latest']);
      set('Input', 230, 600); set('Every', 650, 600); set('Slow', 1050, 350); set('Latest', 1050, 850);
      set('Buffer', 1600, 220); set('Collect', 1600, 480); set('Conflate', 1600, 700);
      const latestAxis = 850;
      const latestWorkTop = 2 * latestAxis - (cards.get('Conflate').y + cards.get('Conflate').height);
      set('LatestWork', 1600, latestWorkTop + cards.get('LatestWork').height / 2);
      const workAxis = cards.get('LatestWork').y + cards.get('LatestWork').height / 2;
      set('CollectLatest', 2100, workAxis - 90); set('FlatLatest', 2100, workAxis + 90);
    },
    routes(cards, edge, route) {
      const c = id => cards.get(id); const right = id => c(id).x + c(id).width; const left = id => c(id).x;
      const cy = id => c(id).y + c(id).height / 2;
      const badge = (x, y, value) => [x, y, value];
      const everyLane = Math.max(right('Every') + 70, Math.min(left('Slow'), left('Latest')) - 70);
      const slowLane = Math.max(right('Slow') + 70, Math.min(left('Buffer'), left('Collect')) - 70);
      const latestLane = Math.max(right('Latest') + 70, Math.min(left('Conflate'), left('LatestWork')) - 70);
      const cancelLane = Math.max(right('LatestWork') + 70, Math.min(left('CollectLatest'), left('FlatLatest')) - 70);
      if (edge === 'Input->Every') return route(edge, `M${right('Input')} ${cy('Input')} H${left('Every')}`);
      if (edge === 'Every->Slow') return route(edge, `M${right('Every')} ${cy('Every') - 24} H${everyLane} V${cy('Slow')} H${left('Slow')}`, null, badge(everyLane - 40, 505, '是'));
      if (edge === 'Every->Latest') return route(edge, `M${right('Every')} ${cy('Every') + 24} H${everyLane} V${cy('Latest')} H${left('Latest')}`, null, badge(everyLane - 40, 695, '否'));
      if (edge === 'Slow->Buffer') return route(edge, `M${right('Slow')} ${cy('Slow') - 20} H${slowLane} V${cy('Buffer')} H${left('Buffer')}`, null, badge(slowLane - 40, 270, '是'));
      if (edge === 'Slow->Collect') return route(edge, `M${right('Slow')} ${cy('Slow') + 20} H${slowLane} V${cy('Collect')} H${left('Collect')}`, null, badge(slowLane - 40, 430, '否'));
      if (edge === 'Latest->Conflate') return route(edge, `M${right('Latest')} ${cy('Latest') - 20} H${latestLane} V${cy('Conflate')} H${left('Conflate')}`, null, badge(latestLane - 40, 770, '是'));
      if (edge === 'Latest->LatestWork') return route(edge, `M${right('Latest')} ${cy('Latest') + 20} H${latestLane} V1000 H${left('LatestWork')}`, null, badge(latestLane - 40, 930, '否'));
      if (edge === 'LatestWork->CollectLatest') return route(edge, `M${right('LatestWork')} ${cy('LatestWork') - 20} H${cancelLane} V${cy('CollectLatest')} H${left('CollectLatest')}`, null, badge(cancelLane - 40, 850, '是'));
      if (edge === 'LatestWork->FlatLatest') return route(edge, `M${right('LatestWork')} ${cy('LatestWork') + 20} H${cancelLane} V${cy('FlatLatest')} H${left('FlatLatest')}`, null, badge(cancelLane - 40, 1030, '否'));
      throw new Error(`No route for ${edge}`);
    },
  },
  {
    id: '10-viewmodel-sharing',
    source: 'kmp-core-preview-10-viewmodel-sharing.mmd',
    baseline: 'kmp-core-preview-10-viewmodel-sharing-mermaid-baseline.svg',
    output: 'kmp-core-preview-10-viewmodel-sharing.svg',
    canvas: { width: 2400, height: 1250 },
    title: '是否共享 ViewModel：从展示逻辑到互操作成本',
    symmetry: {
      mode: 'partial',
      reason: '共享 Presentation 的双端 UI 输出做垂直轴镜像；两层决策与平台 ViewModel 合并结果不是完整镜像结构',
      groups: [
        { id: 'decision-pair', axis: 'vertical', center: 890, pairs: [['Logic', 'Cost']], edgePairs: [['Logic->Native', 'Cost->Native']] },
        { id: 'shared-ui-output', axis: 'vertical', center: 1730, pairs: [['Compose', 'Swift']], edgePairs: [['Shared->Compose', 'Shared->Swift']] },
      ],
    },
    roles: {
      UI: 'input', Logic: 'decision', Native: 'quiet', Cost: 'decision',
      Shared: 'complex', Compose: 'success', Swift: 'success',
    },
    layout(cards) {
      const set = (id, x, y) => { const c = cards.get(id); c.x = x - c.width / 2; c.y = y - c.height / 2; };
      equalizeCardPair(cards, ['Logic', 'Cost']);
      equalizeCardPair(cards, ['Compose', 'Swift']);
      set('UI', 180, 640); set('Logic', 620, 640); set('Cost', 1160, 640);
      set('Shared', 1730, 280); set('Native', 890, 1000);
      set('Compose', 1450, 1080); set('Swift', 2010, 1080);
    },
    routes(cards, edge, route) {
      const c = id => cards.get(id);
      const left = id => c(id).x; const right = id => c(id).x + c(id).width;
      const top = id => c(id).y; const bottom = id => c(id).y + c(id).height;
      const cx = id => c(id).x + c(id).width / 2; const cy = id => c(id).y + c(id).height / 2;
      if (edge === 'UI->Logic') return route(edge, `M${right('UI')} ${cy('UI')} H${left('Logic')}`);
      if (edge === 'Logic->Cost') return route(edge, `M${right('Logic')} ${cy('Logic')} H${left('Cost')}`, null, [900, 600, '是']);
      if (edge === 'Logic->Native') return route(edge, `M${right('Logic') - 120} ${bottom('Logic')} V820 H${left('Native') + 120} V${top('Native')}`, null, [760, 780, '否']);
      if (edge === 'Cost->Shared') return route(edge, `M${cx('Cost')} ${top('Cost')} V450 H${left('Shared') - 80} V${cy('Shared')} H${left('Shared')}`, null, [1450, 420, '是']);
      if (edge === 'Cost->Native') return route(edge, `M${left('Cost') + 120} ${bottom('Cost')} V820 H${right('Native') - 120} V${top('Native')}`, null, [1020, 780, '否']);
      if (edge === 'Shared->Compose') return route(edge, `M${cx('Shared') - 120} ${bottom('Shared')} V700 H${cx('Compose')} V${top('Compose')}`);
      if (edge === 'Shared->Swift') return route(edge, `M${cx('Shared') + 120} ${bottom('Shared')} V700 H${cx('Swift')} V${top('Swift')}`);
      throw new Error(`No route for ${edge}`);
    },
  },
  {
    id: '11-swift-bridge',
    kind: 'sequence',
    source: 'kmp-core-preview-11-swift-bridge.mmd',
    baseline: 'kmp-core-preview-11-swift-bridge-mermaid-baseline.svg',
    output: 'kmp-core-preview-11-swift-bridge.svg',
    canvas: { width: 2400, height: 1250 },
    title: 'SwiftUI Task 与 Kotlin Flow：异步桥接与取消链',
    participantXs: [250, 850, 1500, 2150],
    participantRoles: ['input', 'complex', 'input', 'complex'],
    messageYs: [250, 350, 450, 550, 650, 750, 900, 1050],
    messageKinds: ['normal', 'normal', 'normal', 'normal', 'normal', 'normal', 'cancel', 'cancel'],
    symmetryReason: '时序消息按时间顺序展开；取消链使用红色虚线强调跨 Swift 与 Kotlin 边界的终止传播',
  },
  {
    id: '12-testing',
    source: 'kmp-core-preview-12-testing.mmd',
    baseline: 'kmp-core-preview-12-testing-mermaid-baseline.svg',
    output: 'kmp-core-preview-12-testing.svg',
    canvas: { width: 3100, height: 1100 },
    title: '从业务规则到发布产物的测试阶梯',
    roles: {
      Rules: 'quiet', Common: 'input', Platform: 'input', Integration: 'complex', Smoke: 'complex', CI: 'success',
    },
    annotations: [
      { kind: 'label', x: 120, y: 930, text: '越往左：快、隔离、易定位', anchor: 'start' },
      { kind: 'arrow', x1: 500, y1: 930, x2: 2580, y2: 930 },
      { kind: 'label', x: 2620, y: 930, text: '越往右：真实、发布可验证', anchor: 'start' },
    ],
    layout(cards) {
      const ids = ['Rules', 'Common', 'Platform', 'Integration', 'Smoke', 'CI'];
      let x = 120; const gap = 90; const centerY = 480;
      for (const id of ids) {
        const card = cards.get(id); card.x = x; card.y = centerY - card.height / 2; x += card.width + gap;
      }
      if (x - gap > 2980) throw new Error('12-testing: layout exceeds canvas width');
    },
    routes(cards, edge, route) {
      const c = id => cards.get(id); const right = id => c(id).x + c(id).width; const left = id => c(id).x;
      const cy = id => c(id).y + c(id).height / 2;
      const [from, to] = edge.split('->');
      if (['Rules->Common', 'Common->Platform', 'Platform->Integration', 'Integration->Smoke', 'Smoke->CI'].includes(edge)) {
        return route(edge, `M${right(from)} ${cy(from)} H${left(to)}`);
      }
      throw new Error(`No route for ${edge}`);
    },
  },
  {
    id: '13-agp9-split',
    source: 'kmp-core-preview-13-agp9-split.mmd',
    baseline: 'kmp-core-preview-13-agp9-split-mermaid-baseline.svg',
    output: 'kmp-core-preview-13-agp9-split.svg',
    canvas: { width: 3000, height: 1250 },
    title: 'AGP 9：KMP Library 与 Android Application 拆分',
    roles: {
      Legacy: 'quiet', Split: 'neutral', Shared: 'input', AndroidArtifact: 'input',
      AAR: 'complex', AndroidApp: 'success', Framework: 'complex', IOSApp: 'success',
    },
    layout(cards) {
      const set = (id, x, y) => { const c = cards.get(id); c.x = x - c.width / 2; c.y = y - c.height / 2; };
      set('Legacy', 300, 640); set('Split', 650, 640); set('Shared', 1070, 640);
      set('AndroidArtifact', 1600, 300); set('AAR', 2150, 300); set('AndroidApp', 2700, 300);
      set('Framework', 1600, 980); set('IOSApp', 2400, 980);
    },
    routes(cards, edge, route) {
      const c = id => cards.get(id); const left = id => c(id).x; const right = id => c(id).x + c(id).width;
      const cy = id => c(id).y + c(id).height / 2;
      const upperLane = left('AndroidArtifact') - 70;
      const lowerLane = left('Framework') - 100;
      if (upperLane <= right('Shared') + 24 || lowerLane <= right('Shared') + 24) throw new Error('13-agp9-split: branch lane is too close to Shared');
      if (edge === 'Legacy->Split') return route(edge, `M${right('Legacy')} ${cy('Legacy')} H${left('Split')}`);
      if (edge === 'Split->Shared') return route(edge, `M${right('Split')} ${cy('Split')} H${left('Shared')}`);
      if (edge === 'Shared->AndroidArtifact') return route(edge, `M${right('Shared')} ${cy('Shared') - 24} H${upperLane} V${cy('AndroidArtifact')} H${left('AndroidArtifact')}`);
      if (edge === 'AndroidArtifact->AAR') return route(edge, `M${right('AndroidArtifact')} ${cy('AndroidArtifact')} H${left('AAR')}`);
      if (edge === 'AAR->AndroidApp') return route(edge, `M${right('AAR')} ${cy('AAR')} H${left('AndroidApp')}`);
      if (edge === 'Shared->Framework') return route(edge, `M${right('Shared')} ${cy('Shared') + 24} H${lowerLane} V${cy('Framework')} H${left('Framework')}`);
      if (edge === 'Framework->IOSApp') return route(edge, `M${right('Framework')} ${cy('Framework')} H${left('IOSApp')}`);
      throw new Error(`No route for ${edge}`);
    },
  },
  {
    id: '14-architecture',
    source: 'kmp-core-preview-14-architecture.mmd',
    baseline: 'kmp-core-preview-14-architecture-mermaid-baseline.svg',
    output: 'kmp-core-preview-14-architecture.svg',
    canvas: { width: 3000, height: 1550 },
    title: 'KMP 分层架构：依赖方向与平台实现边界',
    zones: [
      { id: 'application', x: 50, y: 80, width: 2900, height: 180, label: 'Application / 应用层', fill: 'read' },
      { id: 'presentation', x: 50, y: 290, width: 2900, height: 170, label: 'Presentation / 表现层', fill: 'read' },
      { id: 'domain', x: 50, y: 500, width: 2900, height: 230, label: 'Domain / 领域层', fill: 'refresh' },
      { id: 'data', x: 50, y: 760, width: 2900, height: 280, label: 'Data / 数据层', fill: 'read' },
      { id: 'platform', x: 50, y: 1090, width: 2900, height: 350, label: 'Platform / 平台实现', fill: 'refresh' },
    ],
    symmetry: {
      mode: 'partial',
      reason: '双端 Application 到共享 Presentation 的入口做局部镜像；Domain、Data 与平台实现是非镜像依赖结构',
      groups: [
        { id: 'application-entry', axis: 'vertical', center: 1400, pairs: [['AndroidApp', 'IOSApp']], edgePairs: [['AndroidApp->VM', 'IOSApp->VM']] },
      ],
    },
    roles: {
      AndroidApp: 'success', IOSApp: 'cancel', VM: 'input', UseCase: 'complex',
      RepoContract: 'complex', MapContract: 'complex', RepoImpl: 'complex',
      Remote: 'decision', Local: 'decision', AndroidMain: 'success', IosMain: 'cancel',
    },
    layout(cards) {
      const set = (id, x, y) => { const c = cards.get(id); c.x = x - c.width / 2; c.y = y - c.height / 2; };
      equalizeCardPair(cards, ['AndroidApp', 'IOSApp']);
      set('AndroidApp', 800, 170); set('IOSApp', 2000, 170); set('VM', 1400, 375);
      set('UseCase', 550, 620); set('RepoContract', 1250, 620); set('MapContract', 2000, 620);
      set('RepoImpl', 1250, 930); set('Remote', 1750, 900); set('Local', 2350, 900);
      equalizeCardPair(cards, ['AndroidMain', 'IosMain']);
      set('AndroidMain', 1500, 1260); set('IosMain', 2500, 1260);
    },
    routes(cards, edge, route) {
      const c = id => cards.get(id); const left = id => c(id).x; const right = id => c(id).x + c(id).width;
      const cx = id => c(id).x + c(id).width / 2; const cy = id => c(id).y + c(id).height / 2;
      const top = id => c(id).y; const bottom = id => c(id).y + c(id).height;
      const vmLeftPort = left('VM') + 120; const vmRightPort = right('VM') - 120;
      if (edge === 'AndroidApp->VM') return route(edge, `M${cx('AndroidApp')} ${bottom('AndroidApp')} V250 H${vmLeftPort} V${top('VM')}`);
      if (edge === 'IOSApp->VM') return route(edge, `M${cx('IOSApp')} ${bottom('IOSApp')} V250 H${vmRightPort} V${top('VM')}`);
      if (edge === 'VM->UseCase') return route(edge, `M${cx('VM')} ${bottom('VM')} V500 H${cx('UseCase')} V${top('UseCase')}`);
      if (edge === 'UseCase->RepoContract') return route(edge, `M${right('UseCase')} ${cy('UseCase')} H${left('RepoContract')}`);
      if (edge === 'RepoContract->RepoImpl') return route(edge, `M${cx('RepoContract')} ${bottom('RepoContract')} V${top('RepoImpl')}`);
      const remoteLane = left('Remote') - 70; const localLane = left('Local') - 70;
      if (edge === 'RepoImpl->Remote') return route(edge, `M${right('RepoImpl')} ${cy('RepoImpl') - 20} H${remoteLane} V${cy('Remote')} H${left('Remote')}`);
      if (edge === 'RepoImpl->Local') return route(edge, `M${right('RepoImpl')} ${cy('RepoImpl') + 20} H${localLane} V${cy('Local')} H${left('Local')}`);
      if (edge === 'MapContract->AndroidMain') return route(edge, `M${cx('MapContract') - 100} ${bottom('MapContract')} V760 H2700 V1120 H${cx('AndroidMain')} V${top('AndroidMain')}`);
      if (edge === 'MapContract->IosMain') return route(edge, `M${cx('MapContract') + 100} ${bottom('MapContract')} V720 H2800 V1140 H${cx('IosMain')} V${top('IosMain')}`);
      throw new Error(`No route for ${edge}`);
    },
  },
  {
    id: '15-ai-guide',
    kind: 'sequence',
    source: 'kmp-core-preview-15-ai-guide.mmd',
    baseline: 'kmp-core-preview-15-ai-guide-mermaid-baseline.svg',
    output: 'kmp-core-preview-15-ai-guide.svg',
    canvas: { width: 3000, height: 1450 },
    title: 'AI 导游刷新链路：从用户意图到双端 UI',
    participantXs: [180, 540, 900, 1260, 1620, 1980, 2340, 2700],
    participantRoles: ['input', 'complex', 'input', 'complex', 'input', 'complex', 'decision', 'success'],
    messageYs: [240, 350, 460, 570, 680, 790, 900, 1010, 1120, 1230],
    symmetryReason: '时序消息按用户意图、业务规则、数据协调、数据源与状态回流的时间顺序展开，不强行镜像参与者泳道',
  },
  {
    id: '16-migration',
    source: 'kmp-core-preview-16-migration.mmd',
    baseline: 'kmp-core-preview-16-migration-mermaid-baseline.svg',
    output: 'kmp-core-preview-16-migration.svg',
    canvas: { width: 2500, height: 1250 },
    title: '成熟项目的渐进式 KMP 迁移',
    annotations: [
      { kind: 'label', x: 180, y: 1110, text: '沿着阶梯逐层迁移；每一步都保持产品可运行、可回滚、可验证', anchor: 'start' },
    ],
    roles: {
      Audit: 'input', Split: 'input', Model: 'complex', Rules: 'complex', Domain: 'complex',
      Repo: 'decision', Network: 'decision', Shared: 'success', UI: 'cancel',
    },
    layout(cards) {
      const set = (id, x, y) => { const c = cards.get(id); c.x = x - c.width / 2; c.y = y - c.height / 2; };
      set('Audit', 300, 210); set('Split', 1250, 210); set('Model', 2200, 210);
      set('Rules', 2200, 550); set('Domain', 1250, 550); set('Repo', 300, 550);
      set('Network', 300, 890); set('Shared', 1250, 890); set('UI', 2200, 890);
    },
    routes(cards, edge, route) {
      const c = id => cards.get(id); const left = id => c(id).x; const right = id => c(id).x + c(id).width;
      const cx = id => c(id).x + c(id).width / 2; const cy = id => c(id).y + c(id).height / 2;
      const top = id => c(id).y; const bottom = id => c(id).y + c(id).height;
      if (edge === 'Audit->Split' || edge === 'Split->Model' || edge === 'Network->Shared' || edge === 'Shared->UI') {
        const [from, to] = edge.split('->'); return route(edge, `M${right(from)} ${cy(from)} H${left(to)}`);
      }
      if (edge === 'Model->Rules' || edge === 'Repo->Network') {
        const [from, to] = edge.split('->'); return route(edge, `M${cx(from)} ${bottom(from)} V${top(to)}`);
      }
      if (edge === 'Rules->Domain' || edge === 'Domain->Repo') {
        const [from, to] = edge.split('->'); return route(edge, `M${left(from)} ${cy(from)} H${right(to)}`);
      }
      throw new Error(`No route for ${edge}`);
    },
  },
  {
    id: '17-native-performance',
    source: 'kmp-core-preview-17-native-performance.mmd',
    baseline: 'kmp-core-preview-17-native-performance-mermaid-baseline.svg',
    output: 'kmp-core-preview-17-native-performance.svg',
    canvas: { width: 2400, height: 1350 },
    title: 'Kotlin/Native 与 Swift：把性能判断放在互操作边界',
    symmetry: {
      mode: 'none', axis: 'none', center: 0, pairs: [], edgePairs: [],
      reason: '建议优先与重点关注是语义互补的两列，不是镜像流程；通过相同列宽、行距和底部测量汇聚保持视觉平衡',
    },
    zones: [
      { id: 'prefer', x: 1000, y: 135, width: 650, height: 760, label: '建议优先', fill: 'read' },
      { id: 'watch', x: 1690, y: 135, width: 650, height: 760, label: '重点关注', fill: 'refresh' },
    ],
    roles: {
      K: 'input', B: 'complex', P1: 'success', P2: 'success', P3: 'success',
      W1: 'cancel', W2: 'cancel', W3: 'cancel', M: 'quiet',
    },
    layout(cards) {
      const set = (id, x, y) => { const c = cards.get(id); c.x = x - c.width / 2; c.y = y - c.height / 2; };
      // Mermaid 基线给出三层关系：入口/边界 → 建议列，风险列 → 测量汇总。
      // 在这个 rank 骨架上把两组信息拉成等行距双栏，避免风险项挤在底部回线中。
      set('K', 250, 560); set('B', 720, 560);
      set('P1', 1325, 320); set('P2', 1325, 550); set('P3', 1325, 780);
      set('W1', 2015, 320); set('W2', 2015, 550); set('W3', 2015, 780);
      set('M', 1200, 1115);
    },
    routes(cards, edge, route) {
      const c = id => cards.get(id);
      const left = id => c(id).x; const right = id => c(id).x + c(id).width;
      const cx = id => c(id).x + c(id).width / 2; const cy = id => c(id).y + c(id).height / 2;
      const top = id => c(id).y; const bottom = id => c(id).y + c(id).height;
      const preferLaneTop = right('B') + 100;
      const preferLaneBottom = right('B') + 140;
      if (edge === 'K->B') return route(edge, `M${right('K')} ${cy('K')} H${left('B')}`);
      if (edge === 'B->P1') return route(edge, `M${right('B')} ${cy('B') - 34} H${preferLaneTop} V${cy('P1')} H${left('P1')}`);
      if (edge === 'B->P2') return route(edge, `M${right('B')} ${cy('B')} H${left('P2')}`);
      if (edge === 'B->P3') return route(edge, `M${right('B')} ${cy('B') + 34} H${preferLaneBottom} V${cy('P3')} H${left('P3')}`);
      // 风险列用最下方出口代表性汇入测量卡，保留原图“重点关注 → 测量”的语义。
      // 保留右侧出线，但将竖向 lane 放在分组框内侧安全区之外、边界之前，
      // 再从分组框下方横向回收，避免线路看起来像分组框边线。
      const measureTop = top('M');
      if (edge === 'W3->M') return route(edge, `M${right('W3')} ${cy('W3')} H2250 V950 H1340 V${measureTop}`);
      if (edge === 'K->M') return route(edge, `M${cx('K')} ${bottom('K')} V1030 H1140 V${measureTop}`);
      throw new Error(`No route for ${edge}`);
    },
  },
  {
    id: '18-testing',
    source: 'kmp-core-preview-18-testing.mmd',
    baseline: 'kmp-core-preview-18-testing-mermaid-baseline.svg',
    output: 'kmp-core-preview-18-testing.svg',
    canvas: { width: 2400, height: 1350 },
    title: '从业务规则到发布产物的测试阶梯',
    symmetry: {
      mode: 'none', axis: 'none', center: 0, pairs: [], edgePairs: [],
      reason: '测试阶段是有先后顺序的阶梯，不是镜像结构；上下两行只用于收纳长链，保持每行从左到右递进',
    },
    zones: [
      { id: 'fast', x: 120, y: 150, width: 2160, height: 350, label: '快速、隔离、易定位', fill: 'read' },
      { id: 'real', x: 120, y: 650, width: 2160, height: 350, label: '更真实、接近发布', fill: 'refresh' },
    ],
    annotations: [
      { kind: 'label', x: 140, y: 1160, text: '越往左：快、隔离、易定位', anchor: 'start' },
      { kind: 'arrow', x1: 560, y1: 1160, x2: 1840, y2: 1160 },
      { kind: 'label', x: 2260, y: 1160, text: '越往右：真实、发布可验证', anchor: 'end' },
    ],
    roles: {
      Rules: 'quiet', Common: 'input', Platform: 'input', Integration: 'complex', Smoke: 'complex', CI: 'success',
    },
    layout(cards) {
      const set = (id, x, y) => { const c = cards.get(id); c.x = x - c.width / 2; c.y = y - c.height / 2; };
      // 以 Mermaid 的 TB + 两个 LR subgraph 为骨架：上行承载快速测试，下行承载真实交付验证。
      // 两行使用同一组列中心，确保阶段卡片自然宽度变化时仍保持稳定的阅读轴线。
      set('Rules', 390, 350); set('Common', 1190, 350); set('Platform', 1990, 350);
      set('Integration', 390, 850); set('Smoke', 1190, 850); set('CI', 1990, 850);
    },
    routes(cards, edge, route) {
      const c = id => cards.get(id); const left = id => c(id).x; const right = id => c(id).x + c(id).width;
      const cx = id => c(id).x + c(id).width / 2; const cy = id => c(id).y + c(id).height / 2;
      const top = id => c(id).y; const bottom = id => c(id).y + c(id).height;
      if (edge === 'Rules->Common' || edge === 'Common->Platform' || edge === 'Integration->Smoke' || edge === 'Smoke->CI') {
        const [from, to] = edge.split('->'); return route(edge, `M${right(from)} ${cy(from)} H${left(to)}`);
      }
      if (edge === 'Platform->Integration') {
        // 转折只放在两行之间的空白带，向下进入第二行第一张卡片；不穿过任何卡片。
        return route(edge, `M${cx('Platform')} ${bottom('Platform')} V580 H${cx('Integration')} V${top('Integration')}`);
      }
      throw new Error(`No route for ${edge}`);
    },
  },
  {
    id: '19-agp9-split',
    source: 'kmp-core-preview-19-agp9-split.mmd',
    baseline: 'kmp-core-preview-19-agp9-split-mermaid-baseline.svg',
    output: 'kmp-core-preview-19-agp9-split.svg',
    canvas: { width: 2400, height: 1350 },
    title: 'AGP 9：KMP Library 与 Android Application 拆分',
    symmetry: {
      mode: 'partial',
      reason: 'shared 向 Android 与 iOS 产物分支的第一跳可以水平镜像；Android 产物链比 iOS 多一层 AAR，整图不宣称严格对称',
      groups: [
        {
          id: 'shared-output-fork', axis: 'horizontal', center: 675,
          pairs: [['AndroidArtifact', 'Framework']],
          edgePairs: [['Shared->AndroidArtifact', 'Shared->Framework']],
        },
      ],
    },
    zones: [
      { id: 'android-app', x: 1080, y: 125, width: 1220, height: 430, label: 'Android 应用产物链', fill: 'read' },
      { id: 'ios-app', x: 1080, y: 795, width: 1220, height: 430, label: 'iOS 应用产物链', fill: 'refresh' },
    ],
    zoneInset: 36,
    zoneCards: {
      'android-app': ['AndroidArtifact', 'AAR', 'AndroidApp'],
      'ios-app': ['Framework', 'IOSApp'],
    },
    roles: {
      Legacy: 'quiet', Split: 'neutral', Shared: 'input', AndroidArtifact: 'input', AAR: 'complex', AndroidApp: 'success',
      Framework: 'complex', IOSApp: 'success',
    },
    layout(cards) {
      const set = (id, x, y) => { const c = cards.get(id); c.x = x - c.width / 2; c.y = y - c.height / 2; };
      // Mermaid 的 LR rank 保留“旧结构 → shared → 双端产物”的主层级。
      // 两个首层产物卡片等宽等高，围绕 Shared 的水平轴镜像；后续链路按真实职责自然展开。
      equalizeCardPair(cards, ['AndroidArtifact', 'Framework']);
      set('Legacy', 240, 675); set('Split', 610, 675); set('Shared', 950, 675);
      set('AndroidArtifact', 1500, 360); set('AAR', 1850, 360); set('AndroidApp', 2140, 360);
      set('Framework', 1500, 990); set('IOSApp', 2045, 990);
    },
    routes(cards, edge, route) {
      const c = id => cards.get(id); const left = id => c(id).x; const right = id => c(id).x + c(id).width;
      const cx = id => c(id).x + c(id).width / 2; const cy = id => c(id).y + c(id).height / 2;
      const top = id => c(id).y; const bottom = id => c(id).y + c(id).height;
      if (edge === 'Legacy->Split' || edge === 'Split->Shared') {
        const [from, to] = edge.split('->'); return route(edge, `M${right(from)} ${cy(from)} H${left(to)}`);
      }
      const forkLane = Math.max(right('Shared') + 70, Math.min(left('AndroidArtifact'), left('Framework')) - 100);
      if (edge === 'Shared->AndroidArtifact') return route(edge, `M${right('Shared')} ${cy('Shared') - 34} H${forkLane} V${cy('AndroidArtifact')} H${left('AndroidArtifact')}`);
      if (edge === 'Shared->Framework') return route(edge, `M${right('Shared')} ${cy('Shared') + 34} H${forkLane} V${cy('Framework')} H${left('Framework')}`);
      if (edge === 'AndroidArtifact->AAR' || edge === 'AAR->AndroidApp' || edge === 'Framework->IOSApp') {
        const [from, to] = edge.split('->'); return route(edge, `M${right(from)} ${cy(from)} H${left(to)}`);
      }
      throw new Error(`No route for ${edge}`);
    },
  },
  {
    id: '20-selective-sharing',
    source: 'kmp-core-preview-20-selective-sharing.mmd',
    baseline: 'kmp-exact-01-selective-sharing-mermaid-baseline.svg',
    output: 'kmp-core-preview-20-selective-sharing.svg',
    canvas: { width: 2800, height: 1350 },
    title: '选择性共享：从判断收益到双端产物',
    symmetry: {
      mode: 'partial',
      reason: 'commonMain 向 Android/iOS 编译分支可以围绕 E 的水平轴镜像；共享与平台保留两条路径语义不同，不宣称整图严格对称',
      groups: [
        {
          id: 'target-compilation-fork', axis: 'horizontal', center: 360,
          pairs: [['F', 'G']],
          edgePairs: [['E->F', 'E->G']],
        },
      ],
    },
    roles: {
      A: 'quiet', B: 'decision', C: 'quiet', D: 'input', E: 'input',
      F: 'complex', G: 'complex', H: 'success', I: 'success',
    },
    layout(cards) {
      const set = (id, x, y) => { const c = cards.get(id); c.x = x - c.width / 2; c.y = y - c.height / 2; };
      equalizeCardPair(cards, ['F', 'G']);
      set('A', 200, 580); set('B', 630, 580); set('C', 630, 980);
      set('D', 1100, 360); set('E', 1520, 360);
      set('F', 2000, 140); set('G', 2000, 580);
      set('H', 2520, 140); set('I', 2520, 580);
    },
    routes(cards, edge, route) {
      const c = id => cards.get(id);
      const left = id => c(id).x; const right = id => c(id).x + c(id).width;
      const cx = id => c(id).x + c(id).width / 2; const cy = id => c(id).y + c(id).height / 2;
      const top = id => c(id).y; const bottom = id => c(id).y + c(id).height;
      if (edge === 'A->B') return route(edge, `M${right('A')} ${cy('A')} H${left('B')}`);
      if (edge === 'B->D') {
        const lane = Math.min(left('D') - 60, right('B') + 90);
        return route(edge, `M${right('B')} ${cy('B') - 34} H${lane} V${cy('D')} H${left('D')}`, null, [lane - 35, cy('D') - 30, '是']);
      }
      if (edge === 'B->C') return route(edge, `M${cx('B')} ${bottom('B')} V${top('C')}`, null, [cx('B') + 38, (bottom('B') + top('C')) / 2, '否']);
      if (edge === 'D->E') return route(edge, `M${right('D')} ${cy('D')} H${left('E')}`);
      const branchLane = Math.min(left('F') - 55, right('E') + 100);
      if (edge === 'E->F') return route(edge, `M${right('E')} ${cy('E') - 24} H${branchLane} V${cy('F')} H${left('F')}`);
      if (edge === 'E->G') return route(edge, `M${right('E')} ${cy('E') + 24} H${branchLane} V${cy('G')} H${left('G')}`);
      if (edge === 'F->H' || edge === 'G->I') {
        const [from, to] = edge.split('->'); return route(edge, `M${right(from)} ${cy(from)} H${left(to)}`);
      }
      // “否”路径绕过共享编译链：第一条从 C 右侧出线，第二条从 C 底边出线，
      // 将两条长回接线拉开，避免平行过近后被看成一条粗线。
      if (edge === 'C->H') {
        // C→H 走最左侧外回路：从 C 左边界出线，绕过 A/B/D/E 与共享分支，
        // 再沿 F 上方进入 H 左边界；C→I 则独立走底部通道。
        const lane = left('A') - 40;
        return route(edge, `M${left('C')} ${cy('C') - 30} H${lane} V90 H${left('H')}`);
      }
      if (edge === 'C->I') {
        const lane = right('G') + 80;
        return route(edge, `M${cx('C')} ${bottom('C')} V${bottom('C') + 70} H${lane} V${bottom('I') + 70} H${cx('I')} V${bottom('I')}`);
      }
      throw new Error(`No route for ${edge}`);
    },
  },
];

function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function isCjk(ch) { return /[\u2e80-\u9fff\uff00-\uffef]/.test(ch); }
function measureText(value, size = FONT_SIZE) {
  let width = 0;
  for (const ch of String(value)) {
    if (ch === ' ') width += size * 0.34;
    else if (isCjk(ch)) width += size;
    else if (/[，。！？：；、]/.test(ch)) width += size * 0.52;
    else width += size * 0.56;
  }
  return width;
}
function splitUnits(value) {
  const units = []; let latin = '';
  const flush = () => { if (latin) { units.push(latin); latin = ''; } };
  for (const ch of String(value)) {
    if (isCjk(ch) || /[?！？：，。、/+]/.test(ch)) { flush(); units.push(ch); }
    else if (ch === ' ') { flush(); units.push(ch); }
    else latin += ch;
  }
  flush(); return units;
}
function wrapLine(value, maxWidth) {
  if (measureText(value) <= maxWidth) return [value];
  const lines = []; let line = '';
  for (const unit of splitUnits(value)) {
    const candidate = line + unit;
    if (line && measureText(candidate) > maxWidth) { lines.push(line.trim()); line = unit.trimStart(); }
    else line = candidate;
  }
  if (line) lines.push(line.trim());
  return lines.length ? lines : [value];
}
function wrapLabel(value) {
  const raw = String(value).replace(/<br\s*\/?>/g, '\n').trim();
  const lines = raw.split(/\r?\n/).flatMap(line => wrapLine(line.trim(), MAX_CONTENT_WIDTH));
  if (lines.length > MAX_LINES) throw new Error(`Label requires more than ${MAX_LINES} lines: ${raw}`);
  return lines;
}
function parseMermaid(block) {
  const nodes = []; const nodeById = new Map();
  // subgraph 标题不是流程节点；去掉标题后再解析节点和拓扑，避免把 ReadLoop/RefreshLoop 当成卡片。
  const normalized = block.replace(/^\s*subgraph\s+[^\r\n]+$/gm, '');
  const nodePattern = /([A-Za-z][A-Za-z0-9_]*)\s*(?:\[([^\]]+)\]|\{([^}]+)\})/g;
  for (const item of normalized.matchAll(nodePattern)) {
    const id = item[1]; if (nodeById.has(id)) continue;
    const label = (item[2] ?? item[3]).trim().replace(/^\"([\s\S]*)\"$/, '$1');
    const node = { id, label, sourceIndex: nodes.length };
    nodes.push(node); nodeById.set(id, node);
  }
  const edges = [];
  // 节点定义与连线经常写在同一行，先移除节点形状文本，再解析拓扑。
  const topology = normalized.replace(/\[[^\]]+\]|\{[^}]+\}/g, '');
  for (const line of topology.split(/\r?\n/)) {
    const branch = line.match(/([A-Za-z][A-Za-z0-9_]*)\s*--\s*([^\-\n]+?)\s*-->\s*([A-Za-z][A-Za-z0-9_]*)/);
    const direct = line.match(/([A-Za-z][A-Za-z0-9_]*)\s*-->\s*([A-Za-z][A-Za-z0-9_]*)/);
    const item = branch || direct; if (!item) continue;
    const from = item[1]; const to = branch ? item[3] : item[2]; const label = branch ? item[2].trim() : '';
    if (nodeById.has(from) && nodeById.has(to)) edges.push({ from, to, label, key: `${from}->${to}` });
  }
  return { nodes, edges };
}
function parseBaseline(svg) {
  const nodes = new Map();
  const nodePattern = /<g class="node[^>]*id="my-svg-flowchart-([A-Za-z][A-Za-z0-9_]*)-\d+"[^>]*transform="translate\(([-\d.]+),\s*([-\d.]+)\)"/g;
  for (const item of svg.matchAll(nodePattern)) nodes.set(item[1], { x: Number(item[2]), y: Number(item[3]) });
  const edges = new Set();
  const edgePattern = /<path[^>]*id="my-svg-L_([A-Za-z][A-Za-z0-9_]*)_([A-Za-z][A-Za-z0-9_]*)_\d+"[^>]*data-points=/g;
  for (const item of svg.matchAll(edgePattern)) edges.add(`${item[1]}->${item[2]}`);
  return { nodes, edges };
}
function parseSequenceMermaid(block) {
  const participants = [];
  for (const item of block.matchAll(/^\s*participant\s+([A-Za-z][A-Za-z0-9_]*)\s+as\s+(.+)$/gm)) participants.push({ id: item[1], label: item[2].trim() });
  const messages = [];
  for (const line of block.split(/\r?\n/)) {
    const item = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)(-->>|->>)([A-Za-z][A-Za-z0-9_]*):\s*(.+)$/);
    if (item) messages.push({ from: item[1], arrow: item[2], to: item[3], label: item[4].trim() });
  }
  return { participants, messages };
}
function sequenceTextSvg(x, y, value, maxWidth, fontSize = 21) {
  const lines = wrapLine(value, maxWidth);
  const lineHeight = Math.round(fontSize * 1.35);
  const width = Math.ceil(Math.max(...lines.map(line => measureText(line, fontSize))) + 22);
  const height = lines.length * lineHeight + 10;
  const firstY = y - ((lines.length - 1) * lineHeight) / 2;
  return `<g><rect x="${x - width / 2}" y="${y - height / 2}" width="${width}" height="${height}" rx="7" fill="${C.bg}" fill-opacity="0.94"/><text x="${x}" y="${firstY}" font-size="${fontSize}" font-weight="750" text-anchor="middle" fill="${C.ink}" dominant-baseline="middle">${lines.map((line, i) => `<tspan x="${x}" dy="${i ? lineHeight : 0}">${esc(line)}</tspan>`).join('')}</text></g>`;
}
function renderSequenceSpec(spec) {
  const source = fs.readFileSync(path.join(EXAMPLE_MERMAID_DIR, spec.source), 'utf8');
  const baselinePath = path.join(EXAMPLE_BASELINE_DIR, spec.baseline);
  if (!fs.existsSync(baselinePath)) throw new Error(`Missing Mermaid baseline: ${spec.baseline}`);
  const baseline = fs.readFileSync(baselinePath, 'utf8');
  const sequence = parseSequenceMermaid(source);
  if (sequence.participants.length !== spec.participantXs.length) throw new Error(`${spec.id}: sequence participant mismatch`);
  if (sequence.messages.length !== spec.messageYs.length) throw new Error(`${spec.id}: sequence message mismatch`);
  const participantX = new Map(sequence.participants.map((item, index) => [item.id, spec.participantXs[index]]));
  const participantCards = sequence.participants.map((item, index) => {
    const width = Math.ceil(Math.min(420, Math.max(250, measureText(item.label, 26) + 64)));
    return { id: item.id, lines: [item.label], x: participantX.get(item.id) - width / 2, y: 112, width, height: 76, fill: C.cards[spec.participantRoles[index] || 'neutral'] };
  });
  const cards = new Map(participantCards.map(card => [card.id, card]));
  const laneTop = 198; const laneBottom = spec.canvas.height - 42;
  const lanes = participantCards.map(card => `<path d="M${card.x + card.width / 2} ${laneTop} V${laneBottom}" fill="none" stroke="${C.muted}" stroke-width="2" stroke-dasharray="8 10" opacity="0.58"/>`).join('');
  const messagePaths = []; const messageLabels = [];
  sequence.messages.forEach((message, index) => {
    const fromX = participantX.get(message.from); const toX = participantX.get(message.to); const y = spec.messageYs[index];
    if (fromX == null || toX == null) throw new Error(`${spec.id}: unknown participant in message ${message.from}->${message.to}`);
    const self = message.from === message.to; const endX = self ? fromX + 132 : toX;
    const cancel = spec.messageKinds?.[index] === 'cancel';
    const stroke = cancel ? '#C84B4B' : C.ink;
    const dash = cancel ? ' stroke-dasharray="8 6"' : '';
    const marker = cancel ? 'url(#arrow-cancel)' : 'url(#arrow)';
    messagePaths.push(`<path data-edge="sequence-${index}" d="M${fromX} ${y} H${endX}" fill="none" stroke="${stroke}" stroke-width="3.2" stroke-linecap="round"${dash} marker-end="${marker}"/>`);
    const center = self ? fromX + 66 : (fromX + toX) / 2;
    const maxWidth = self ? 300 : Math.max(240, Math.min(620, Math.abs(toX - fromX) - 38));
    // 标签底牌整体上移，避免两行文字压住消息线，造成“断线/缺箭头”的错觉。
    messageLabels.push(sequenceTextSvg(center, y - 40, message.label, maxWidth));
  });
  const body = [
    `<text x="${spec.canvas.width / 2}" y="62" font-size="26" font-weight="700" text-anchor="middle" fill="${C.muted}">${esc(spec.title)}</text>`,
    lanes, messagePaths.join(''), messageLabels.join(''), participantCards.map(cardSvg).join(''),
  ].join('');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${spec.canvas.width}" height="${spec.canvas.height}" viewBox="0 0 ${spec.canvas.width} ${spec.canvas.height}" role="img" aria-label="${esc(spec.title)}" data-theme="${themeName}" data-baseline="${spec.baseline}" data-layout-model="mermaid-sequence-baseline-plus-readable-lanes" data-symmetry-mode="none" data-symmetry-axis="none" data-symmetry-pairs="" data-symmetry-edge-pairs="" data-symmetry-public-spines="" data-arrow-width="24" data-arrow-height="16" data-symmetry-reason="${esc(spec.symmetryReason || '')}">
  <defs>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="${C.grid}" stroke-width="1.2"/></pattern>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="5" stdDeviation="3" flood-color="${C.ink}" flood-opacity="0.18"/></filter>
    <marker id="arrow" markerWidth="24" markerHeight="16" refX="21" refY="8" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L21,8 L0,16 Z" fill="${C.ink}"/></marker>
    <marker id="arrow-cancel" markerWidth="24" markerHeight="16" refX="21" refY="8" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L21,8 L0,16 Z" fill="#C84B4B"/></marker>
    <style>text{font-family:Arial,"Microsoft YaHei","PingFang SC",sans-serif;letter-spacing:.1px}</style>
  </defs>
  <rect width="${spec.canvas.width}" height="${spec.canvas.height}" fill="${C.bg}"/><rect width="${spec.canvas.width}" height="${spec.canvas.height}" fill="url(#grid)"/>
  ${body}
</svg>`;
  fs.writeFileSync(path.join(EXAMPLE_OUTPUT_DIR, spec.output), svg, 'utf8');
  console.log(`generated=${spec.output} themeMode=${themeMode} theme=${themeName} participants=${sequence.participants.length} messages=${sequence.messages.length} baseline=${spec.baseline}`);
}
function cardFor(node, role) {
  const lines = wrapLabel(node.label); const maxLineWidth = Math.max(...lines.map(line => measureText(line)));
  const width = Math.ceil(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, maxLineWidth + PAD_X * 2)));
  const height = lines.length * LINE_HEIGHT + PAD_Y * 2;
  return { ...node, lines, width, height, fill: C.cards[role || 'neutral'] };
}
function textSvg(x, y, lines) {
  const firstY = y - ((lines.length - 1) * LINE_HEIGHT) / 2;
  return `<text x="${x}" y="${firstY}" font-size="${FONT_SIZE}" font-weight="750" text-anchor="middle" fill="${C.ink}" dominant-baseline="middle">${lines.map((line, i) => `<tspan x="${x}" dy="${i ? LINE_HEIGHT : 0}">${esc(line)}</tspan>`).join('')}</text>`;
}
function cardSvg(card) {
  return `<g data-node="${esc(card.id)}"><rect x="${card.x}" y="${card.y}" width="${card.width}" height="${card.height}" rx="14" fill="${card.fill}" stroke="${C.ink}" stroke-width="5" filter="url(#shadow)"/>${textSvg(card.x + card.width / 2, card.y + card.height / 2, card.lines)}</g>`;
}
function labelBadge(x, y, value) {
  const width = Math.ceil(measureText(value, 21) + 24);
  return `<g><rect x="${x - width / 2}" y="${y - 20}" width="${width}" height="40" rx="9" fill="${C.bg}"/><text x="${x}" y="${y}" font-size="21" font-weight="750" text-anchor="middle" fill="${C.ink}" dominant-baseline="middle">${esc(value)}</text></g>`;
}
function zoneSvg(zone) {
  const fill = C.panels[zone.fill] || zone.fill || C.bg;
  return `<g data-zone="${esc(zone.id)}"><rect x="${zone.x}" y="${zone.y}" width="${zone.width}" height="${zone.height}" rx="20" fill="${fill}" fill-opacity="0.72" stroke="${C.panels.stroke}" stroke-width="2.2"/><text x="${zone.x + 24}" y="${zone.y + 34}" font-size="22" font-weight="750" fill="${C.muted}">${esc(zone.label)}</text></g>`;
}
function annotationSvg(annotation) {
  if (annotation.kind === 'label') {
    return `<text x="${annotation.x}" y="${annotation.y}" font-size="22" font-weight="750" text-anchor="${annotation.anchor || 'middle'}" fill="${C.muted}" dominant-baseline="middle">${esc(annotation.text)}</text>`;
  }
  if (annotation.kind === 'arrow') {
    return `<path d="M${annotation.x1} ${annotation.y1} H${annotation.x2}" fill="none" stroke="${C.muted}" stroke-width="3.2" stroke-linecap="round" marker-end="url(#arrow)"/>`;
  }
  return '';
}
function pathSvg(edge, d, arrow = true) {
  return `<path data-edge="${esc(edge)}" d="${d}" fill="none" stroke="${C.ink}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"${arrow ? ' marker-end="url(#arrow)"' : ''}/>`;
}

function validateSymmetry(spec, cards, routeData) {
  if (!spec.symmetry) return;
  const tolerance = 2;
  const fail = message => { throw new Error(`${spec.id}: ASYMMETRY ${message}`); };
  const groups = spec.symmetry.groups || [spec.symmetry];
  for (const group of groups) {
    const center = group.center ?? (group.centerFrom ? cards.get(group.centerFrom).x + cards.get(group.centerFrom).width / 2 : 0);
    const declaredEdges = new Set((group.edgePairs || []).map(pair => pair.join('|')));
    for (const spine of group.publicSpine || []) {
      if (!declaredEdges.has(spine.join('|'))) fail(`${group.id || 'symmetry'} publicSpine ${spine.join('/')} is not declared in edgePairs`);
    }
    for (const [topOrLeftId, bottomOrRightId] of group.pairs) {
      const first = cards.get(topOrLeftId); const second = cards.get(bottomOrRightId);
      if (group.cardMode === 'inner-edge' && group.axis === 'vertical') {
        const firstRight = first.x + first.width; const secondLeft = second.x;
        if (Math.abs((firstRight + secondLeft) / 2 - center) > tolerance) fail(`${group.id}/${topOrLeftId}/${bottomOrRightId} inner edges are not mirrored`);
        if (Math.abs(first.y + first.height / 2 - (second.y + second.height / 2)) > tolerance) fail(`${group.id}/${topOrLeftId}/${bottomOrRightId} centerY is not aligned`);
      } else if (group.cardMode === 'inner-edge' && group.axis === 'horizontal') {
        const firstBottom = first.y + first.height; const secondTop = second.y;
        if (Math.abs((firstBottom + secondTop) / 2 - center) > tolerance) fail(`${group.id}/${topOrLeftId}/${bottomOrRightId} inner edges are not mirrored`);
        if (Math.abs(first.x + first.width / 2 - (second.x + second.width / 2)) > tolerance) fail(`${group.id}/${topOrLeftId}/${bottomOrRightId} centerX is not aligned`);
      } else if (group.axis === 'horizontal') {
      const firstCenterY = first.y + first.height / 2; const secondCenterY = second.y + second.height / 2;
      if (Math.abs((firstCenterY + secondCenterY) / 2 - center) > tolerance) fail(`${group.id || 'symmetry'}/${topOrLeftId}/${bottomOrRightId} centerY is not mirrored`);
      if (Math.abs(first.x - second.x) > tolerance || Math.abs(first.width - second.width) > tolerance || Math.abs(first.height - second.height) > tolerance) fail(`${topOrLeftId}/${bottomOrRightId} card bounds are not mirrored`);
      } else {
      const firstCenterX = first.x + first.width / 2; const secondCenterX = second.x + second.width / 2;
      if (Math.abs((firstCenterX + secondCenterX) / 2 - center) > tolerance) fail(`${group.id || 'symmetry'}/${topOrLeftId}/${bottomOrRightId} centerX is not mirrored`);
      if (Math.abs(first.y - second.y) > tolerance || Math.abs(first.width - second.width) > tolerance || Math.abs(first.height - second.height) > tolerance) fail(`${topOrLeftId}/${bottomOrRightId} card bounds are not mirrored`);
      }
    }
    const routeMap = new Map(routeData.map(route => [route.edge, route.d]));
    for (const [firstEdge, secondEdge] of group.edgePairs || []) {
      if (!routeMap.has(firstEdge) || !routeMap.has(secondEdge)) fail(`missing edge pair ${firstEdge}/${secondEdge}`);
      const mirrored = mirrorSegments(parseOrthogonalSegments(routeMap.get(firstEdge)), { axis: group.axis, center });
      if (!sameSegmentSet(mirrored, parseOrthogonalSegments(routeMap.get(secondEdge)), tolerance)) fail(`${group.id || 'symmetry'}/${firstEdge}/${secondEdge} route geometry is not mirrored`);
    }
  }
}

const selectedSpecs = onlyArg ? specs.filter(spec => spec.id === onlyArg || spec.id.startsWith(`${onlyArg}-`)) : specs;
for (const spec of selectedSpecs) {
  if (spec.kind === 'sequence') {
    renderSequenceSpec(spec);
    continue;
  }
  const source = fs.readFileSync(path.join(EXAMPLE_MERMAID_DIR, spec.source), 'utf8');
  const baselinePath = path.join(EXAMPLE_BASELINE_DIR, spec.baseline);
  if (!fs.existsSync(baselinePath)) throw new Error(`Missing Mermaid baseline: ${spec.baseline}`);
  const baselineSvg = fs.readFileSync(baselinePath, 'utf8');
  const graph = parseMermaid(source); const baseline = parseBaseline(baselineSvg);
  if (baseline.nodes.size !== graph.nodes.length) throw new Error(`${spec.id}: baseline node mismatch`);
  for (const node of graph.nodes) if (!baseline.nodes.has(node.id)) throw new Error(`${spec.id}: baseline missing ${node.id}`);
  for (const edge of graph.edges) if (!baseline.edges.has(edge.key)) throw new Error(`${spec.id}: baseline missing ${edge.key}`);
  const cards = new Map(graph.nodes.map(node => [node.id, cardFor(node, spec.roles[node.id])]));
  spec.layout(cards);
  const canvasWidth = spec.canvas?.width || CANVAS_WIDTH;
  const canvasHeight = spec.canvas?.height || CANVAS_HEIGHT;
  const symmetryGroups = spec.symmetry?.groups || (spec.symmetry ? [spec.symmetry] : []);
  const symmetryAxis = symmetryGroups.map(group => {
    const center = group.center ?? (group.centerFrom ? cards.get(group.centerFrom).x + cards.get(group.centerFrom).width / 2 : 0);
    return `${group.id || 'symmetry'}:${group.axis}=${center}`;
  }).join(';') || 'none';
  const symmetryPairs = symmetryGroups.flatMap(group => group.pairs || []).map(pair => pair.join('/')).join(';');
  const symmetryEdgePairs = symmetryGroups.flatMap(group => group.edgePairs || []).map(pair => pair.join('/')).join(';');
  const symmetryPublicSpines = symmetryGroups.flatMap(group => group.publicSpine || []).map(pair => pair.join('/')).join(';');
  const routeFragments = [];
  const routeData = [];
  const badges = [];
  const route = (edge, d, _unused = null, badge = null) => { routeData.push({ edge, d }); routeFragments.push(pathSvg(edge, d)); if (badge) badges.push(labelBadge(...badge)); };
  for (const edge of graph.edges) spec.routes(cards, edge.key, route);
  validateRouteConnections(graph, cards, routeData);
  validateRouteGeometry(spec, graph, cards, routeData);
  validateZoneContainment(spec, cards);
  validateSymmetry(spec, cards, routeData);
  const rankXs = [...new Set([...baseline.nodes.values()].map(n => Math.round(n.x)))].sort((a, b) => a - b);
  const ranks = [...baseline.nodes.entries()].map(([id, n]) => `${id}:${rankXs.findIndex(x => x === Math.round(n.x))}`).join(',');
  const body = [
    `<text x="${canvasWidth / 2}" y="62" font-size="26" font-weight="700" text-anchor="middle" fill="${C.muted}">${esc(spec.title)}</text>`,
    (spec.zones || []).map(zoneSvg).join(''),
    [...cards.values()].map(cardSvg).join(''), routeFragments.join(''), badges.join(''), (spec.annotations || []).map(annotationSvg).join(''),
  ].join('');
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}" role="img" aria-label="${esc(spec.title)}" data-theme="${themeName}" data-baseline="${spec.baseline}" data-baseline-ranks="${esc(ranks)}" data-layout-model="baseline-rank-order-plus-readable-routes" data-symmetry-mode="${spec.symmetry?.mode || 'none'}" data-symmetry-axis="${esc(symmetryAxis)}" data-symmetry-pairs="${esc(symmetryPairs)}" data-symmetry-edge-pairs="${esc(symmetryEdgePairs)}" data-symmetry-public-spines="${esc(symmetryPublicSpines)}" data-arrow-width="16" data-arrow-height="12" data-symmetry-reason="${esc(spec.symmetry?.reason || '')}">
  <defs>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="${C.grid}" stroke-width="1.2"/></pattern>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="5" stdDeviation="3" flood-color="${C.ink}" flood-opacity="0.18"/></filter>
     <marker id="arrow" markerWidth="16" markerHeight="12" refX="14" refY="6" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L14,6 L0,12 Z" fill="${C.ink}"/></marker>
    <style>text{font-family:Arial,"Microsoft YaHei","PingFang SC",sans-serif;letter-spacing:.1px}</style>
  </defs>
  <rect width="${canvasWidth}" height="${canvasHeight}" fill="${C.bg}"/><rect width="${canvasWidth}" height="${canvasHeight}" fill="url(#grid)"/>
  ${body}
</svg>`;
  fs.writeFileSync(path.join(EXAMPLE_OUTPUT_DIR, spec.output), svg, 'utf8');
  console.log(`generated=${spec.output} themeMode=${themeMode} theme=${themeName} nodes=${graph.nodes.length} edges=${graph.edges.length} baseline=${spec.baseline}`);
}
