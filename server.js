const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createBoardItems } = require('./bingo-items');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const MAX_ROOMS = 3;
const rooms = new Map();
const socketRoomIds = new Map();

function roomChannel(roomId) {
  return `room:${roomId}`;
}

function publicRoom(room) {
  return {
    id: room.id,
    name: `${room.id}번 방`,
    hasPassword: Boolean(room.password),
    playerCount: room.players.length,
    isGameStarted: room.isGameStarted
  };
}

function roomList() {
  return [...rooms.values()]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map(publicRoom);
}

function broadcastRooms() {
  io.emit('roomsUpdated', roomList());
}

function createRoomState(id, password, creatorId) {
  return {
    id,
    password,
    creatorId,
    pendingSocketIds: new Set([creatorId]),
    players: [],
    drawnNumbers: new Set(),
    currentTurnIndex: 0,
    gameBoardSize: 5,
    playerItemIds: new Map(),
    playerItemLabels: new Map(),
    isGameStarted: false,
    isPreparing: false,
    preparationTimer: null,
    preparationEndsAt: 0,
    confirmedPlayers: new Set()
  };
}

function roomForSocket(socketId) {
  return rooms.get(socketRoomIds.get(socketId));
}

function emitToRoom(room, event, data) {
  io.to(roomChannel(room.id)).emit(event, data);
}

function finishPreparation(room) {
  if (!room.isGameStarted || !room.isPreparing || room.players.length === 0) return;
  clearTimeout(room.preparationTimer);
  room.preparationTimer = null;
  room.isPreparing = false;
  emitToRoom(room, 'playStarted', { currentTurn: room.players[room.currentTurnIndex].nickname });
}

function broadcastPreparation(room) {
  emitToRoom(room, 'preparationUpdated', { confirmedPlayerIds: [...room.confirmedPlayers] });
  if (room.players.length > 0 && room.players.every(player => room.confirmedPlayers.has(player.id))) {
    finishPreparation(room);
  }
}

function broadcastLobby(room) {
  emitToRoom(room, 'updateLobby', {
    room: publicRoom(room),
    players: room.players,
    hostId: room.players.find(player => player.isHost)?.id
  });
}

function resetGame(room) {
  clearTimeout(room.preparationTimer);
  room.preparationTimer = null;
  room.isPreparing = false;
  room.confirmedPlayers.clear();
  room.isGameStarted = false;
  room.drawnNumbers.clear();
  room.playerItemIds.clear();
  room.playerItemLabels.clear();
  room.currentTurnIndex = 0;
}

function assignHost(room, preferredId) {
  const nextHost = room.players.find(player => player.id === preferredId) || room.players[0];
  room.players.forEach(player => { player.isHost = player.id === nextHost?.id; });
  if (nextHost) room.creatorId = nextHost.id;
}

function removeSocketFromRoom(socket, { leaveChannel = false } = {}) {
  const room = roomForSocket(socket.id);
  if (!room) return;

  const turnPlayerId = room.players[room.currentTurnIndex]?.id;
  const leavingPlayer = room.players.find(player => player.id === socket.id);
  room.players = room.players.filter(player => player.id !== socket.id);
  room.pendingSocketIds.delete(socket.id);
  room.confirmedPlayers.delete(socket.id);
  room.playerItemIds.delete(socket.id);
  room.playerItemLabels.delete(socket.id);
  socketRoomIds.delete(socket.id);
  if (leaveChannel) socket.leave?.(roomChannel(room.id));

  if (room.players.length === 0 && room.pendingSocketIds.size === 0) {
    resetGame(room);
    rooms.delete(room.id);
    broadcastRooms();
    return;
  }

  if (leavingPlayer?.isHost || room.creatorId === socket.id) {
    const successorId = room.players[0]?.id || room.pendingSocketIds.values().next().value;
    room.creatorId = successorId;
    assignHost(room, successorId);
  }

  if (room.isGameStarted && leavingPlayer) {
    if (room.players.length === 0) {
      resetGame(room);
    } else {
      const remainingTurnIndex = room.players.findIndex(player => player.id === turnPlayerId);
      room.currentTurnIndex = remainingTurnIndex >= 0
        ? remainingTurnIndex
        : room.currentTurnIndex % room.players.length;
      emitToRoom(room, 'playerLeft', {
        players: room.players,
        currentTurn: room.players[room.currentTurnIndex]?.nickname,
        drawnNumbers: [...room.drawnNumbers]
      });
      if (room.isPreparing) broadcastPreparation(room);
    }
  }

  broadcastLobby(room);
  broadcastRooms();
}

io.on('connection', (socket) => {
  socket.emit('roomsUpdated', roomList());

  socket.on('createRoom', ({ password = '' } = {}) => {
    if (socketRoomIds.has(socket.id)) return;
    if (rooms.size >= MAX_ROOMS) {
      socket.emit('errorMsg', '방은 최대 3개까지 만들 수 있습니다.');
      return;
    }
    if (password !== '' && !/^\d{4}$/.test(password)) {
      socket.emit('errorMsg', '비밀번호는 숫자 4자리로 설정해주세요.');
      return;
    }

    const roomId = ['1', '2', '3'].find(id => !rooms.has(id));
    const room = createRoomState(roomId, password, socket.id);
    rooms.set(roomId, room);
    socketRoomIds.set(socket.id, roomId);
    socket.join?.(roomChannel(roomId));
    socket.emit('roomEntered', { room: publicRoom(room), isCreator: true });
    broadcastRooms();
  });

  socket.on('enterRoom', ({ roomId, password = '' } = {}) => {
    if (socketRoomIds.has(socket.id)) return;
    const room = rooms.get(String(roomId));
    if (!room) {
      socket.emit('errorMsg', '이미 사라진 방입니다. 방 목록을 확인해주세요.');
      broadcastRooms();
      return;
    }
    if (room.isGameStarted) {
      socket.emit('errorMsg', '이미 게임이 진행 중인 방입니다.');
      return;
    }
    if (room.password && password !== room.password) {
      socket.emit('errorMsg', '비밀번호가 맞지 않습니다.');
      return;
    }

    room.pendingSocketIds.add(socket.id);
    socketRoomIds.set(socket.id, room.id);
    socket.join?.(roomChannel(room.id));
    socket.emit('roomEntered', { room: publicRoom(room), isCreator: socket.id === room.creatorId });
  });

  socket.on('leaveRoom', () => {
    if (!socketRoomIds.has(socket.id)) return;
    removeSocketFromRoom(socket, { leaveChannel: true });
    socket.emit('roomLeft');
  });

  socket.on('joinGame', (nickname) => {
    const room = roomForSocket(socket.id);
    if (!room) {
      socket.emit('errorMsg', '먼저 방을 선택해주세요.');
      return;
    }
    if (room.isGameStarted) {
      socket.emit('errorMsg', '이미 게임이 진행 중입니다.');
      return;
    }
    if (room.players.some(player => player.id === socket.id)) return;

    const cleanNickname = typeof nickname === 'string' ? nickname.trim() : '';
    if (!cleanNickname || cleanNickname.length > 12) {
      socket.emit('errorMsg', '닉네임은 1~12자로 입력해주세요.');
      return;
    }
    if (room.players.some(player => player.nickname === cleanNickname)) {
      socket.emit('errorMsg', '이미 사용 중인 닉네임입니다.');
      return;
    }

    const isHost = socket.id === room.creatorId;
    room.players.push({ id: socket.id, nickname: cleanNickname, isHost, wins: 0 });
    room.pendingSocketIds.delete(socket.id);
    if (!room.players.some(player => player.isHost) && !room.pendingSocketIds.has(room.creatorId)) {
      assignHost(room, room.creatorId);
    }
    broadcastLobby(room);
    broadcastRooms();
    socket.emit('joinedSuccess', { isHost, room: publicRoom(room) });
  });

  socket.on('startGame', (settings) => {
    const room = roomForSocket(socket.id);
    const player = room?.players.find(participant => participant.id === socket.id);
    if (!room || !player || !player.isHost) {
      socket.emit('errorMsg', '방장만 게임을 시작할 수 있습니다.');
      return;
    }
    if (room.isGameStarted) return;
    if (room.players.length < 2) {
      socket.emit('errorMsg', '최소 2명 이상 접속해야 게임을 시작할 수 있습니다!');
      return;
    }

    const boardSize = Number(settings?.boardSize ?? settings);
    const category = settings?.category ?? 'numbers';
    if (![3, 4, 5, 6].includes(boardSize) || !['numbers', 'snacks'].includes(category)) {
      socket.emit('errorMsg', '빙고판 크기 또는 카테고리를 확인해주세요.');
      return;
    }

    room.gameBoardSize = boardSize;
    room.playerItemIds.clear();
    room.playerItemLabels.clear();
    room.isGameStarted = true;
    room.currentTurnIndex = room.players.findIndex(participant => participant.id === player.id);
    room.drawnNumbers.clear();
    room.isPreparing = true;
    room.confirmedPlayers.clear();
    room.preparationEndsAt = Date.now() + 10000;
    room.preparationTimer = setTimeout(() => finishPreparation(room), 10000);
    const targetBingoCount = boardSize === 5 ? 5 : boardSize;

    for (const participant of room.players) {
      const boardItems = createBoardItems(category, boardSize);
      room.playerItemIds.set(participant.id, new Set(boardItems.map(item => item.id)));
      room.playerItemLabels.set(participant.id, new Map(boardItems.map(item => [item.id, item.label])));
      io.to(participant.id).emit('gameStarted', {
        players: room.players,
        preparationEndsAt: room.preparationEndsAt,
        preparationDuration: 10000,
        boardSize,
        category,
        boardItems,
        targetBingoCount,
        drawnNumbers: []
      });
    }
    broadcastRooms();
  });

  socket.on('confirmBoard', () => {
    const room = roomForSocket(socket.id);
    if (!room?.isPreparing || !room.players.some(player => player.id === socket.id)) return;
    if (Date.now() >= room.preparationEndsAt) {
      finishPreparation(room);
      return;
    }
    room.confirmedPlayers.add(socket.id);
    broadcastPreparation(room);
  });

  socket.on('selectNumber', (number) => {
    const room = roomForSocket(socket.id);
    if (!room?.isGameStarted || room.isPreparing) return;
    if (room.players[room.currentTurnIndex]?.id !== socket.id) {
      socket.emit('errorMsg', '아직 본인 턴이 아닙니다!');
      return;
    }
    if (!room.playerItemIds.get(socket.id)?.has(number)) return;

    if (!room.drawnNumbers.has(number)) {
      const selectedBy = room.players[room.currentTurnIndex].nickname;
      const numberLabel = room.playerItemLabels.get(socket.id)?.get(number) ?? String(number);
      room.drawnNumbers.add(number);
      room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
      emitToRoom(room, 'numberSelected', {
        number,
        numberLabel,
        selectedBy,
        drawnNumbers: [...room.drawnNumbers],
        nextTurn: room.players[room.currentTurnIndex].nickname
      });
    }
  });

  socket.on('claimBingo', ({ bingoCount } = {}) => {
    const room = roomForSocket(socket.id);
    if (!room?.isGameStarted || room.isPreparing) return;
    const player = room.players.find(participant => participant.id === socket.id);
    if (Number.isInteger(bingoCount) && bingoCount >= room.gameBoardSize && player) {
      resetGame(room);
      player.wins += 1;
      assignHost(room, player.id);
      broadcastLobby(room);
      broadcastRooms();
      emitToRoom(room, 'gameOver', `🎉 ${player.nickname}님이 ${bingoCount}개 빙고를 완성하여 승리했습니다! 🎉`);
    }
  });

  socket.on('disconnect', () => removeSocketFromRoom(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
