const fs = require('fs');
const path = require('path');
const OUTPUT_DIR = path.resolve(__dirname, '..', 'examples', 'output');

// 不再维护手写文件清单：目录中的每一个成品 SVG 都必须自动进入回归检查。
const files = fs.readdirSync(OUTPUT_DIR)
  .filter(file => /^kmp-core-preview-\d+-.+\.svg$/.test(file) && !file.includes('-mermaid-baseline'))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

if (!files.length) throw new Error('No kmp-core-preview-*.svg files found.');

const VISUAL_WARNING_THRESHOLDS = {
  shortFinalSegment: 48,
  parallelGap: 48,
  parallelOverlap: 32,
};

function decodeXml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function segments(d) {
  const tokens = [...d.matchAll(/[MLHV]|-?\d+(?:\.\d+)?/g)].map(m => m[0]);
  let i = 0; let x = 0; let y = 0; let command = ''; const result = [];
  while (i < tokens.length) {
    if (/^[MLHV]$/.test(tokens[i])) command = tokens[i++];
    if (command === 'M' || command === 'L') {
      const nextX = Number(tokens[i++]); const nextY = Number(tokens[i++]);
      if (command === 'L') result.push([x, y, nextX, nextY]);
      x = nextX; y = nextY;
    } else if (command === 'H') {
      const nextX = Number(tokens[i++]); result.push([x, y, nextX, y]); x = nextX;
    } else if (command === 'V') {
      const nextY = Number(tokens[i++]); result.push([x, y, x, nextY]); y = nextY;
    }
  }
  return result;
}

function insideLength([x1, y1, x2, y2], rect) {
  const dx = x2 - x1; const dy = y2 - y1; let lo = 0; let hi = 1;
  for (const [p, q] of [[-dx, x1 - rect.x], [dx, rect.x + rect.w - x1], [-dy, y1 - rect.y], [dy, rect.y + rect.h - y1]]) {
    if (Math.abs(p) < 1e-9) { if (q < 0) return 0; }
    else if (p < 0) hi = Math.min(hi, q / p);
    else lo = Math.max(lo, q / p);
    if (lo > hi) return 0;
  }
  return Math.max(0, hi - lo) * Math.hypot(dx, dy);
}

function segmentLength([x1, y1, x2, y2]) {
  return Math.hypot(x2 - x1, y2 - y1);
}

function isHorizontal(segment) { return Math.abs(segment[1] - segment[3]) < 0.01; }
function isVertical(segment) { return Math.abs(segment[0] - segment[2]) < 0.01; }

function range(segment, horizontal) {
  return horizontal
    ? [Math.min(segment[0], segment[2]), Math.max(segment[0], segment[2])]
    : [Math.min(segment[1], segment[3]), Math.max(segment[1], segment[3])];
}

function overlapLength(a, b, horizontal) {
  const ar = range(a, horizontal); const br = range(b, horizontal);
  return Math.min(ar[1], br[1]) - Math.max(ar[0], br[0]);
}

function parallelGap(a, b, horizontal) {
  return horizontal ? Math.abs(a[1] - b[1]) : Math.abs(a[0] - b[0]);
}

function cross(a, b) {
  const h1 = isHorizontal(a); const h2 = isHorizontal(b);
  // 同向重合是共享脊柱候选，另行统计；真正的横竖交叉才算 crossing。
  if ((h1 && h2) || (!h1 && !h2)) return false;
  const horizontal = h1 ? a : b; const vertical = h1 ? b : a;
  return vertical[0] > Math.min(horizontal[0], horizontal[2]) + 1
    && vertical[0] < Math.max(horizontal[0], horizontal[2]) - 1
    && horizontal[1] > Math.min(vertical[1], vertical[3]) + 1
    && horizontal[1] < Math.max(vertical[1], vertical[3]) - 1;
}

function pairKey(a, b) {
  return [a, b].sort().join('|');
}

function parseAllowedEdgePairs(svg) {
  const raw = decodeXml((svg.match(/data-symmetry-public-spines="([^"]*)"/) || [])[1] || '');
  return new Set(raw.split(';').filter(Boolean).map(value => {
    const [a, b] = value.split('/');
    return a && b ? pairKey(a, b) : null;
  }).filter(Boolean));
}

function parseArrowSpec(svg, sequence) {
  const marker = svg.match(/<marker id="arrow" markerWidth="([\d.]+)" markerHeight="([\d.]+)"/);
  const metadata = svg.match(/data-arrow-width="([\d.]+)" data-arrow-height="([\d.]+)"/);
  if (!marker) return null;
  const actual = `${Number(marker[1])}x${Number(marker[2])}`;
  const expected = sequence ? '24x16' : '16x12';
  const declared = metadata ? `${Number(metadata[1])}x${Number(metadata[2])}` : null;
  return { actual, declared, expected, valid: actual === expected && declared === expected };
}

function describeSegments(paths, cards, allowedPairs) {
  let routeCardHits = 0;
  let crossings = 0;
  let sharedSegments = 0;
  let illegalSharedSegments = 0;
  const crossingDetails = [];
  const sharedDetails = [];
  const parallelWarnings = [];
  const shortWarnings = [];

  for (const pathItem of paths) {
    const finalSegment = pathItem.segments[pathItem.segments.length - 1];
    if (finalSegment && segmentLength(finalSegment) < VISUAL_WARNING_THRESHOLDS.shortFinalSegment) {
      shortWarnings.push(`${pathItem.id}=${segmentLength(finalSegment).toFixed(1)}px`);
    }
    for (const segment of pathItem.segments) for (const card of cards) {
      const isEndpointEdge = pathItem.id.startsWith(`${card.id}->`) || pathItem.id.endsWith(`->${card.id}`);
      if (!isEndpointEdge && insideLength(segment, { x: card.x + 4, y: card.y + 4, w: card.w - 8, h: card.h - 8 }) > 1) {
        routeCardHits++;
      }
    }
  }

  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    const left = paths[i]; const right = paths[j];
    for (const a of left.segments) for (const b of right.segments) {
      const sameHorizontal = isHorizontal(a) && isHorizontal(b) && Math.abs(a[1] - b[1]) < 1;
      const sameVertical = isVertical(a) && isVertical(b) && Math.abs(a[0] - b[0]) < 1;
      if (sameHorizontal || sameVertical) {
        const horizontal = sameHorizontal;
        const overlap = overlapLength(a, b, horizontal);
        if (overlap > 1) {
          sharedSegments++;
          const allowed = allowedPairs.has(pairKey(left.id, right.id));
          if (!allowed) illegalSharedSegments++;
          sharedDetails.push(`${left.id}/${right.id} overlap=${overlap.toFixed(1)}px allowed=${allowed}`);
        }
      } else if (cross(a, b)) {
        crossings++;
        crossingDetails.push(`${left.id}/${right.id} @(${isHorizontal(a) ? b[0] : a[0]},${isHorizontal(a) ? a[1] : b[1]})`);
      } else {
        const sameOrientation = (isHorizontal(a) && isHorizontal(b)) || (isVertical(a) && isVertical(b));
        if (sameOrientation) {
          const horizontal = isHorizontal(a);
          const overlap = overlapLength(a, b, horizontal);
          const gap = parallelGap(a, b, horizontal);
          if (overlap > VISUAL_WARNING_THRESHOLDS.parallelOverlap && gap < VISUAL_WARNING_THRESHOLDS.parallelGap) {
            parallelWarnings.push(`${left.id}/${right.id} gap=${gap.toFixed(1)}px overlap=${overlap.toFixed(1)}px`);
          }
        }
      }
    }
  }

  return { routeCardHits, crossings, crossingDetails, sharedSegments, sharedDetails, illegalSharedSegments, parallelWarnings, shortWarnings };
}

for (const file of files) {
  const svg = fs.readFileSync(path.join(OUTPUT_DIR, file), 'utf8');
  const cards = [...svg.matchAll(/<g data-node="([^"]+)"><rect x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g)]
    .map(m => ({ id: m[1], x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]) }));
  const paths = [...svg.matchAll(/<path data-edge="([^"]+)" d="([^"]+)"/g)]
    .map(m => ({ id: decodeXml(m[1]), segments: segments(m[2]) }));
  const sequence = /data-layout-model="mermaid-sequence/.test(svg);
  const symmetryMode = (svg.match(/data-symmetry-mode="([^"]+)"/) || [])[1] || 'none';
  const allowedPairs = parseAllowedEdgePairs(svg);
  const arrowSpec = parseArrowSpec(svg, sequence);
  const issues = [];
  let overlaps = 0;
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i]; const b = cards[j];
    const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    if (x * y > 1) overlaps++;
  }
  const geometry = describeSegments(paths, cards, allowedPairs);
  if (overlaps) issues.push(`CARD_OVERLAP=${overlaps}`);
  if (geometry.routeCardHits) issues.push(`ROUTE_CARD_HIT=${geometry.routeCardHits}`);
  if (geometry.crossings) issues.push(`CROSSING=${geometry.crossings}`);
  if (geometry.illegalSharedSegments) issues.push(`ILLEGAL_SHARED_SEGMENT=${geometry.illegalSharedSegments}`);
  if (!arrowSpec || !arrowSpec.valid) issues.push(`ARROW_SPEC=${arrowSpec ? `${arrowSpec.actual} expected ${arrowSpec.expected}` : 'missing'}`);

  const status = issues.length ? 'FAIL' : 'PASS';
  console.log(`${file}: ${status} cards=${cards.length} paths=${paths.length} cardOverlaps=${overlaps} routeCardHits=${geometry.routeCardHits} crossings=${geometry.crossings} sharedSegments=${geometry.sharedSegments} symmetry=${symmetryMode} arrow=${arrowSpec ? arrowSpec.actual : 'missing'}`);
  if (geometry.crossingDetails.length) console.log(`  crossingDetails: ${geometry.crossingDetails.join('; ')}`);
  if (geometry.sharedDetails.length) console.log(`  sharedDetails: ${geometry.sharedDetails.join('; ')}`);
  if (geometry.parallelWarnings.length) console.log(`  visualWarnings PARALLEL_MERGE: ${geometry.parallelWarnings.join('; ')}`);
  if (geometry.shortWarnings.length) console.log(`  visualWarnings SHORT_ARROW: ${geometry.shortWarnings.join('; ')}`);
  if (issues.length) {
    console.log(`  blockers: ${issues.join(', ')}`);
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  console.log(`QA summary: ${files.length} SVGs discovered automatically; all structural/geometry hard gates passed.`);
  console.log('Visual warnings remain reviewable findings; they do not silently become a pass when a route is technically valid.');
}
