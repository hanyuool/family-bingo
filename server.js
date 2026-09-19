const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createBoardItems } = require('./bingo-items');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let players = [];
let drawnNumbers = new Set();
let currentTurnIndex = 0;
let gameBoardSize = 5;
const playerItemIds = new Map();
let isGameStarted = false;
let isPreparing = false;
let preparationTimer = null;
let preparationEndsAt = 0;
const confirmedPlayers = new Set();

function finishPreparation() {
  if (!isGameStarted || !isPreparing) return;
  clearTimeout(preparationTimer);
  preparationTimer = null;
  isPreparing = false;
  io.emit('playStarted', { currentTurn: players[currentTurnIndex].nickname });
}

function broadcastPreparation() {
  io.emit('preparationUpdated', { confirmedPlayerIds: [...confirmedPlayers] });
  if (players.every(player => confirmedPlayers.has(player.id))) finishPreparation();
}

function broadcastLobby() {
  io.emit('updateLobby', { players, hostId: players.find(player => player.isHost)?.id });
}

io.on('connection', (socket) => {
  // 플레이어 참가
  socket.on('joinGame', (nickname) => {
    if (isGameStarted) {
      socket.emit('errorMsg', '이미 게임이 진행 중입니다. 다음 게임을 기다려주세요.');
      return;
    }

    if (players.some(p => p.id === socket.id)) return;

    // 첫 참가자가 방장
    const isHost = players.length === 0;
    const player = { id: socket.id, nickname, isHost, wins: 0 };
    players.push(player);

    // 전체 플레이어 목록 전송
    broadcastLobby();

    socket.emit('joinedSuccess', { isHost });
  });

  // 방장이 게임 시작 버튼을 눌렀을 때
  socket.on('startGame', (settings) => {
    const player = players.find(p => p.id === socket.id);
    if (!player || !player.isHost) {
      socket.emit('errorMsg', '방장만 게임을 시작할 수 있습니다.');
      return;
    }

    if (isGameStarted) return;

    if (players.length < 2) {
      socket.emit('errorMsg', '최소 2명 이상 접속해야 게임을 시작할 수 있습니다!');
      return;
    }

    // 기존 숫자 게임 클라이언트의 크기만 보내는 요청도 지원합니다.
    const boardSize = Number(settings?.boardSize ?? settings);
    const category = settings?.category ?? 'numbers';
    if (![3, 4, 5, 6].includes(boardSize) || !['numbers', 'snacks'].includes(category)) {
      socket.emit('errorMsg', '빙고판 크기 또는 카테고리를 확인해주세요.');
      return;
    }
    gameBoardSize = boardSize;
    playerItemIds.clear();
    const targetBingoCount = (gameBoardSize === 5) ? 5 : gameBoardSize;
    isGameStarted = true;
    // 매 게임은 현재 방장부터 시작합니다.
    currentTurnIndex = players.findIndex(participant => participant.id === player.id);
    drawnNumbers.clear();
    isPreparing = true;
    confirmedPlayers.clear();
    preparationEndsAt = Date.now() + 10000;
    preparationTimer = setTimeout(finishPreparation, 10000);

    // 참가자마다 독립 추첨한 목록을 해당 참가자에게만 전송합니다.
    for (const participant of players) {
      const boardItems = createBoardItems(category, gameBoardSize);
      playerItemIds.set(participant.id, new Set(boardItems.map(item => item.id)));
      io.to(participant.id).emit('gameStarted', {
        players,
        preparationEndsAt,
        preparationDuration: 10000,
        boardSize: gameBoardSize,
        category,
        boardItems,
        targetBingoCount,
        drawnNumbers: Array.from(drawnNumbers)
      });
    }
  });

  socket.on('confirmBoard', () => {
    if (!isPreparing || !players.some(p => p.id === socket.id)) return;
    if (Date.now() >= preparationEndsAt) {
      finishPreparation();
      return;
    }
    confirmedPlayers.add(socket.id);
    broadcastPreparation();
  });

  // 항목 ID 선택 처리 (숫자는 기존 숫자 ID 유지)
  socket.on('selectNumber', (num) => {
    if (!isGameStarted || isPreparing) return;

    if (players[currentTurnIndex]?.id !== socket.id) {
      socket.emit('errorMsg', '아직 본인 턴이 아닙니다!');
      return;
    }

    if (!playerItemIds.get(socket.id)?.has(num)) return;

    if (!drawnNumbers.has(num)) {
      drawnNumbers.add(num);
      currentTurnIndex = (currentTurnIndex + 1) % players.length;

      io.emit('numberSelected', {
        number: num,
        drawnNumbers: Array.from(drawnNumbers),
        nextTurn: players[currentTurnIndex].nickname
      });
    }
  });

  // 빙고 완성 신고
  socket.on('claimBingo', ({ bingoCount }) => {
    if (!isGameStarted || isPreparing) return;

    const player = players.find(p => p.id === socket.id);
    if (Number.isInteger(bingoCount) && bingoCount >= gameBoardSize && player) {
      isGameStarted = false;
      drawnNumbers.clear();
      currentTurnIndex = 0;
      player.wins += 1;
      players.forEach(participant => { participant.isHost = participant.id === player.id; });
      broadcastLobby();
      io.emit('gameOver', `🎉 ${player.nickname}님이 ${bingoCount}개 빙고를 완성하여 승리했습니다! 🎉`);
    }
  });

  // 접속 종료 처리
  socket.on('disconnect', () => {
    const turnPlayerId = players[currentTurnIndex]?.id;
    const wasHost = players.find(player => player.id === socket.id)?.isHost;
    players = players.filter(p => p.id !== socket.id);

    confirmedPlayers.delete(socket.id);
    playerItemIds.delete(socket.id);
    if (players.length === 0) {
      clearTimeout(preparationTimer);
      preparationTimer = null;
      isPreparing = false;
      confirmedPlayers.clear();
      isGameStarted = false;
      drawnNumbers.clear();
      currentTurnIndex = 0;
    } else if (wasHost) {
      // 방장이 나가면 다음 사람에게 방장 권한 위임
      players[0].isHost = true;
    }

    if (isGameStarted) {
      if (players.length === 0) {
        isGameStarted = false;
        drawnNumbers.clear();
        currentTurnIndex = 0;
      } else {
        const remainingTurnIndex = players.findIndex(p => p.id === turnPlayerId);
        currentTurnIndex = remainingTurnIndex >= 0 ? remainingTurnIndex : currentTurnIndex % players.length;
        io.emit('playerLeft', {
          players,
          currentTurn: players[currentTurnIndex]?.nickname,
          drawnNumbers: Array.from(drawnNumbers)
        });
        if (isPreparing) broadcastPreparation();
      }
    }
    broadcastLobby();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));