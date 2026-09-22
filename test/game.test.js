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
  function connection(id) {
    const handlers = {};
    connect({
      id,
      on: (name, fn) => { handlers[name] = fn; },
      emit: (name, data) => events.push({ name, data, recipient: id }),
      join() {},
      leave() {}
    });
    return handlers;
  }
  const host = connection('host');
  host.createRoom({ password: '' });
  host.joinGame('host');
  const guest = connection('guest');
  guest.enterRoom({ roomId: '1', password: '' });
  guest.joinGame('guest');
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
  const firstSelection = events.filter(event => event.name === 'numberSelected').at(-1).data;
  assert.equal(firstSelection.numberLabel, start.boardItems.find(item => item.id === id).label);
  assert.equal(firstSelection.selectedBy, 'host');
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
  const third = connection('third');
  third.enterRoom({ roomId: '1' });
  third.joinGame('third');
  assert.equal(lobby().hostId, 'guest');
  host.disconnect();
  assert.equal(lobby().hostId, 'guest');
  guest.disconnect();
  assert.equal(lobby().hostId, 'third');
  assert.equal(lobby().players.filter(p => p.isHost).length, 1);
  const returningGuest = connection('guest');
  returningGuest.enterRoom({ roomId: '1' });
  returningGuest.joinGame('guest');
  assert.equal(lobby().players.find(p => p.id === 'guest').wins, 0);
});
}

test('서버 방 관리: 4자리 비밀번호, 최대 3개, 방장 유지 및 게임 격리', () => {
  let connect;
  const events = [];
  const io = {
    on: (_, fn) => { connect = fn; },
    emit: (name, data) => events.push({ name, data }),
    to: recipient => ({ emit: (name, data) => events.push({ name, data, recipient }) })
  };
  const express = () => ({ use() {} });
  express.static = () => {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'), {
    require: name => ({ express, http: { createServer: () => ({ listen() {} }) },
      'socket.io': { Server: function () { return io; } }, './bingo-items': { createBoardItems } })[name],
    process: { env: {} }, console, setTimeout: () => 1, clearTimeout() {}
  });

  function actor(id) {
    const handlers = {};
    connect({
      id,
      on: (name, fn) => { handlers[name] = fn; },
      emit: (name, data) => events.push({ name, data, recipient: id }),
      join() {}, leave() {}
    });
    return handlers;
  }

  const a = actor('a');
  a.createRoom({ password: '123' });
  assert.equal(events.at(-1).data, '비밀번호는 숫자 4자리로 설정해주세요.');
  a.createRoom({ password: '1234' });
  const publicRoom = events.find(event => event.name === 'roomEntered' && event.recipient === 'a').data.room;
  assert.equal(publicRoom.hasPassword, true);
  assert.equal(Object.hasOwn(publicRoom, 'password'), false);

  const b = actor('b');
  b.enterRoom({ roomId: '1', password: '0000' });
  assert.equal(events.at(-1).data, '비밀번호가 맞지 않습니다.');
  b.enterRoom({ roomId: '1', password: '1234' });
  b.joinGame('비회원');
  let roomOneLobby = events.filter(event => event.name === 'updateLobby' && event.recipient === 'room:1').at(-1).data;
  assert.equal(roomOneLobby.hostId, undefined, '방 생성자가 닉네임을 정하기 전에는 참가자가 방장을 가져가면 안 된다');
  a.joinGame('방장');
  roomOneLobby = events.filter(event => event.name === 'updateLobby' && event.recipient === 'room:1').at(-1).data;
  assert.equal(roomOneLobby.hostId, 'a');

  const c = actor('c');
  c.createRoom({});
  c.joinGame('둘째방장');
  const d = actor('d');
  d.createRoom({});
  d.joinGame('셋째방장');
  const e = actor('e');
  e.createRoom({});
  assert.equal(events.at(-1).data, '방은 최대 3개까지 만들 수 있습니다.');

  const f = actor('f');
  f.enterRoom({ roomId: '2' });
  f.joinGame('둘째손님');
  a.startGame({ boardSize: 3, category: 'numbers' });
  c.startGame({ boardSize: 3, category: 'numbers' });
  a.confirmBoard();
  b.confirmBoard();
  c.confirmBoard();
  f.confirmBoard();
  a.selectNumber(1);
  c.selectNumber(1);
  const selections = events.filter(event => event.name === 'numberSelected');
  assert.deepEqual(selections.map(event => event.recipient), ['room:1', 'room:2']);

  a.disconnect();
  roomOneLobby = events.filter(event => event.name === 'updateLobby' && event.recipient === 'room:1').at(-1).data;
  assert.equal(roomOneLobby.hostId, 'b');
  b.disconnect();
  const latestRooms = events.filter(event => event.name === 'roomsUpdated' && !event.recipient).at(-1).data;
  assert.equal(latestRooms.map(room => room.id).join(','), '2,3');
  e.createRoom({});
  assert.equal(events.filter(event => event.name === 'roomEntered' && event.recipient === 'e').at(-1).data.room.id, '1');
});

test('프론트엔드: 과자 표시, 배치만 변경, 확정 잠금, ID 선택 및 빙고 판정', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const elements = new Map();
  function element() {
    return { style: { setProperty() {} }, classList: { toggle() {} }, children: [],
      appendChild(child) { this.children.push(child); },
      setAttribute(name, value) { this[name] = value; },
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
  handlers.roomsUpdated([
    { id: '1', name: '1번 방', hasPassword: false, playerCount: 1, isGameStarted: false },
    { id: '2', name: '2번 방', hasPassword: true, playerCount: 2, isGameStarted: false }
  ]);
  const roomCards = elements.get('room-list').children;
  assert.equal(roomCards.length, 2);
  assert.equal(roomCards[0].children[0].children[0].innerText, '🔓 1번 방');
  const lockedControls = roomCards[1].children[2];
  elements.set('room-password-2', lockedControls.children[0]);
  lockedControls.children[0].value = '1234';
  lockedControls.children[1].onclick();
  assert.equal(lockedControls.children[0].type, 'text');
  assert.equal(lockedControls.children[1]['aria-label'], '비밀번호 숨기기');
  lockedControls.children[1].onclick();
  assert.equal(lockedControls.children[0].type, 'password');
  lockedControls.children[2].onclick();
  assert.equal(emitted.at(-1).name, 'enterRoom');
  assert.equal(emitted.at(-1).data.roomId, '2');
  assert.equal(emitted.at(-1).data.password, '1234');
  handlers.roomEntered({ room: { id: '2', name: '2번 방' } });
  assert.equal(elements.get('room-area').style.display, 'none');
  assert.equal(elements.get('login-area').style.display, 'block');
  emitted.length = 0;
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
  handlers.numberSelected({
    number: absent.id,
    numberLabel: absent.label,
    selectedBy: '엄마',
    drawnNumbers: [absent.id],
    nextTurn: 'guest'
  });
  assert.ok(board.children.every(cell => !cell.className.includes('selected')));
  assert.equal(elements.get('selection-notice').className, 'selection-notice missing');
  assert.ok(elements.get('selection-notice').innerText.includes(`“${absent.label}”`));
  assert.ok(elements.get('selection-notice').innerText.includes('내 빙고판에 없습니다'));
  assert.equal(elements.get('bingo-count').innerText, 0);
  assert.equal(elements.get('current-turn').innerText, 'guest');
  handlers.numberSelected({
    number: items[0].id,
    numberLabel: items[0].label,
    selectedBy: '아빠',
    drawnNumbers: items.map(item => item.id),
    nextTurn: 'guest'
  });
  assert.equal(elements.get('selection-notice').className, 'selection-notice present');
  assert.equal(elements.get('bingo-lines').children.length, 8);
  assert.equal(emitted.at(-1).name, 'claimBingo');
  assert.equal(emitted.at(-1).data.bingoCount, 8);
  const completedBoardCells = board.children.length;
  handlers.gameOver('엄마님이 승리했습니다!');
  assert.equal(elements.get('game-result-modal').style.display, 'flex');
  assert.equal(elements.get('game-result-message').innerText, '엄마님이 승리했습니다!');
  assert.equal(board.children.length, completedBoardCells);
  assert.equal(elements.get('bingo-lines').children.length, 8);
  assert.equal(elements.get('game-area').style.display, 'block');
  vm.runInContext('returnToLobby()', context);
  assert.equal(elements.get('game-result-modal').style.display, 'none');
  assert.equal(elements.get('game-area').style.display, 'none');
  assert.equal(elements.get('lobby-area').style.display, 'block');
  assert.equal(elements.get('bingo-lines').children.length, 0);
});
