const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createBoardItems } = require('../bingo-items');
const pools = require('../data/bingo-pools.json');

test('과자 50개는 ID와 이름이 중복되지 않는다', () => {
  assert.equal(pools.snacks.length, 50);
  assert.equal(new Set(pools.snacks.map(item => item.id)).size, 50);
  assert.equal(new Set(pools.snacks.map(item => item.label)).size, 50);
});

for (const [size, limit] of [[3, 15], [4, 25], [5, 36], [6, 50]]) {
  test(`${size}×${size}: 과자 후보 범위와 숫자 모드`, () => {
    const original = JSON.stringify(pools);
    const allowed = new Set(pools.snacks.slice(0, limit).map(item => item.id));
    for (let attempt = 0; attempt < 100; attempt++) {
      const items = createBoardItems('snacks', size);
      assert.equal(items.length, size * size);
      assert.equal(new Set(items.map(item => item.id)).size, size * size);
      assert.ok(items.every(item => allowed.has(item.id)));
    }
    assert.equal(JSON.stringify(pools), original);
    assert.deepEqual(createBoardItems('numbers', size).map(item => item.id),
      Array.from({ length: size * size }, (_, i) => i + 1));
  });
}

for (const size of [3, 4, 5, 6]) {
test(`서버 ${size}×${size}: 개별 추첨, 준비, 확정, 본인 항목 검증, 자동 시작`, () => {
  let connect;
  let timeout;
  const events = [];
  const io = {
    on: (_, fn) => { connect = fn; },
    emit: (name, data) => events.push({ name, data }),
    to: recipient => ({ emit: (name, data) => events.push({ name, data, recipient }) })
  };
  let draws = 0;
  function drawItems(category, boardSize) {
    if (category === 'numbers') return createBoardItems(category, boardSize);
    // 서로 다른 추첨 결과를 고정해 확률에 의존하지 않고 개별 전송을 검사합니다.
    const offset = draws++ % 2;
    return pools.snacks.slice(offset, offset + boardSize * boardSize);
  }
  const express = () => ({ use() {} });
  express.static = () => {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), {
    require: name => ({ express, http: { createServer: () => ({ listen() {} }) },
      'socket.io': { Server: function () { return io; } }, './bingo-items': { createBoardItems: drawItems } })[name],
    process: { env: {} }, console,
    setTimeout: fn => { timeout = fn; return 1; }, clearTimeout() {}
  });
  function player(id) {
    const handlers = {};
    connect({ id, on: (name, fn) => { handlers[name] = fn; }, emit() {} });
    handlers.joinGame(id);
    return handlers;
  }
  const host = player('host');
  const guest = player('guest');
  const count = name => events.filter(event => event.name === name).length;
  guest.startGame({ boardSize: 3, category: 'snacks' });
  host.startGame({ boardSize: 7, category: 'snacks' });
  host.startGame({ boardSize: 3, category: 'unknown' });
  assert.equal(count('gameStarted'), 0);
  host.startGame({ boardSize: size, category: 'snacks' });
  const start = events.find(event => event.name === 'gameStarted').data;
  assert.equal(start.category, 'snacks');
  assert.equal(start.boardItems.length, size * size);
  const starts = events.filter(event => event.name === 'gameStarted');
  assert.deepEqual(starts.map(event => event.recipient), ['host', 'guest']);
  assert.equal(draws, 2);
  const guestItems = starts[1].data.boardItems;
  assert.notDeepEqual(start.boardItems, guestItems);
  const id = start.boardItems[0].id;
  host.selectNumber(id);
  assert.equal(count('numberSelected'), 0);
  host.confirmBoard();
  assert.equal(count('playStarted'), 0);
  guest.confirmBoard();
  assert.equal(count('playStarted'), 1);
  host.selectNumber(guestItems.at(-1).id);
  assert.equal(count('numberSelected'), 0);
  host.selectNumber('invalid');
  assert.equal(count('numberSelected'), 0);
  host.selectNumber(id);
  assert.equal(count('numberSelected'), 1);
  assert.ok(!guestItems.some(item => item.id === id));
  assert.equal(events.at(-1).data.nextTurn, 'guest');
  guest.selectNumber(guestItems.at(-1).id);
  assert.equal(count('numberSelected'), 2);
  guest.claimBingo({ bingoCount: size, targetBingoCount: size });
  const lobby = () => events.filter(event => event.name === 'updateLobby').at(-1).data;
  assert.equal(lobby().hostId, 'guest');
  assert.equal(lobby().players.find(p => p.id === 'guest').wins, 1);
  guest.claimBingo({ bingoCount: size });
  assert.equal(lobby().players.find(p => p.id === 'guest').wins, 1);
  host.startGame('5');
  assert.equal(count('gameStarted'), 2);
  guest.startGame('5');
  assert.equal(events.filter(event => event.name === 'gameStarted').at(-1).data.category, 'numbers');
  timeout();
  assert.equal(count('playStarted'), 2);
  assert.equal(events.filter(event => event.name === 'playStarted').at(-1).data.currentTurn, 'guest');
  host.selectNumber(1);
  assert.equal(count('numberSelected'), 2);
  guest.selectNumber(1);
  assert.equal(count('numberSelected'), 3);
  assert.equal(events.at(-1).data.nextTurn, 'host');
  host.selectNumber(2);
  assert.equal(count('numberSelected'), 4);
  assert.equal(events.at(-1).data.nextTurn, 'guest');
  guest.claimBingo({ bingoCount: 5 });
  assert.equal(lobby().players.find(p => p.id === 'guest').wins, 2);
  const third = player('third');
  assert.equal(lobby().hostId, 'guest');
  host.disconnect();
  assert.equal(lobby().hostId, 'guest');
  guest.disconnect();
  assert.equal(lobby().hostId, 'third');
  assert.equal(lobby().players.filter(p => p.isHost).length, 1);
  player('guest');
  assert.equal(lobby().players.find(p => p.id === 'guest').wins, 0);
});
}

test('프론트엔드: 과자 표시, 배치만 변경, 확정 잠금, ID 선택 및 빙고 판정', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const elements = new Map();
  function element() {
    return { style: { setProperty() {} }, classList: { toggle() {} }, children: [],
      appendChild(child) { this.children.push(child); },
      set innerHTML(value) { this.children = []; } };
  }
  for (const match of html.matchAll(/id="([^"]+)"/g)) elements.set(match[1], element());
  const handlers = {};
  const emitted = [];
  const context = vm.createContext({
    io: () => ({ id: 'host', on: (name, fn) => { handlers[name] = fn; },
      emit: (name, data) => emitted.push({ name, data }) }),
    document: { getElementById: id => elements.get(id), createElement: element },
    performance: { now: () => 0 }, setInterval() {}, clearInterval() {}, alert() {}
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  const lobbyPlayers = [
    { id: 'host', nickname: '아빠', wins: 2, isHost: false },
    { id: 'guest', nickname: '엄마', wins: 3, isHost: true }
  ];
  handlers.updateLobby({ players: lobbyPlayers, hostId: 'guest' });
  assert.equal(elements.get('host-controls').style.display, 'none');
  assert.equal(elements.get('player-list-ul').children[0].children[0].innerText, '아빠 · 2승');
  assert.equal(elements.get('game-scores').children[1].innerText, '👑 엄마 · 3승');
  handlers.updateLobby({ players: lobbyPlayers, hostId: 'host' });
  assert.equal(elements.get('host-controls').style.display, 'block');
  const items = createBoardItems('snacks', 3);
  handlers.gameStarted({ boardSize: 3, category: 'snacks', boardItems: items,
    targetBingoCount: 3, drawnNumbers: [], players: [], preparationDuration: 10000 });
  const board = elements.get('bingo-board');
  assert.deepEqual(new Set(board.children.map(cell => cell.innerText)), new Set(items.map(item => item.label)));
  vm.runInContext('generateRandomBoard()', context);
  assert.deepEqual(new Set(board.children.map(cell => cell.innerText)), new Set(items.map(item => item.label)));
  board.children[0].onclick();
  assert.equal(emitted.length, 0);
  vm.runInContext('confirmBoard()', context);
  const labels = board.children.map(cell => cell.innerText);
  vm.runInContext('generateRandomBoard()', context);
  assert.deepEqual(board.children.map(cell => cell.innerText), labels);
  assert.equal(elements.get('shuffle-board').disabled, true);
  handlers.playStarted({ currentTurn: 'host' });
  board.children[0].onclick();
  assert.equal(emitted.at(-1).data, items.find(item => item.label === labels[0]).id);
  const absent = pools.snacks.find(item => !items.some(own => own.id === item.id));
  handlers.numberSelected({ drawnNumbers: [absent.id], nextTurn: 'guest' });
  assert.ok(board.children.every(cell => !cell.className.includes('selected')));
  assert.equal(elements.get('bingo-count').innerText, 0);
  assert.equal(elements.get('current-turn').innerText, 'guest');
  handlers.numberSelected({ drawnNumbers: items.map(item => item.id), nextTurn: 'guest' });
  assert.equal(emitted.at(-1).name, 'claimBingo');
  assert.equal(emitted.at(-1).data.bingoCount, 8);
});
