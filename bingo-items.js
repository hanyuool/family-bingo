const pools = require('./data/bingo-pools.json');

const poolSizes = { 3: 15, 4: 25, 5: 36, 6: 50 };

function createBoardItems(category, size) {
  if (!Object.hasOwn(poolSizes, size)) throw new Error('지원하지 않는 판 크기입니다.');
  if (category === 'numbers') {
    return Array.from({ length: size * size }, (_, i) => ({ id: i + 1, label: String(i + 1) }));
  }
  if (category !== 'snacks') throw new Error('지원하지 않는 카테고리입니다.');

  // JSON 순서대로 크기에 맞는 후보를 제한한 뒤 중복 없이 추첨합니다.
  const candidates = pools.snacks.slice(0, poolSizes[size]);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, size * size);
}

module.exports = { createBoardItems };
