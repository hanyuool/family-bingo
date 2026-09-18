const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let players = [];
let drawnNumbers = new Set();
let currentTurnIndex = 0;
let gameBoardSize = 5;
let isGameStarted = false;

io.on('connection', (socket) => {
  // 플레이어 참가
  socket.on('joinGame', (nickname) => {
    if (isGameStarted) {
      socket.emit('errorMsg', '이미 게임이 진행 중입니다. 다음 게임을 기다려주세요.');
      return;
    }

    // 첫 참가자가 방장
    const isHost = players.length === 0;
    const player = { id: socket.id, nickname, isHost };
    players.push(player);

    // 전체 플레이어 목록 전송
    io.emit('updateLobby', { 
      players, 
      hostId: players[0]?.id 
    });

    socket.emit('joinedSuccess', { isHost });
  });

  // 방장이 게임 시작 버튼을 눌렀을 때
  socket.on('startGame', (boardSize) => {
    const player = players.find(p => p.id === socket.id);
    if (!player || !player.isHost) {
      socket.emit('errorMsg', '방장만 게임을 시작할 수 있습니다.');
      return;
    }

    if (players.length < 2) {
      socket.emit('errorMsg', '최소 2명 이상 접속해야 게임을 시작할 수 있습니다!');
      return;
    }

    gameBoardSize = parseInt(boardSize) || 5;
    const targetBingoCount = (gameBoardSize === 5) ? 5 : gameBoardSize;
    isGameStarted = true;
    currentTurnIndex = 0;
    drawnNumbers.clear();

    io.emit('gameStarted', {
      players,
      currentTurn: players[currentTurnIndex].nickname,
      boardSize: gameBoardSize,
      targetBingoCount,
      drawnNumbers: Array.from(drawnNumbers)
    });
  });

  // 숫자 선택 처리
  socket.on('selectNumber', (num) => {
    if (!isGameStarted) return;

    if (players[currentTurnIndex]?.id !== socket.id) {
      socket.emit('errorMsg', '아직 본인 턴이 아닙니다!');
      return;
    }

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
  socket.on('claimBingo', ({ bingoCount, targetBingoCount }) => {
    if (!isGameStarted) return;

    const player = players.find(p => p.id === socket.id);
    if (bingoCount >= targetBingoCount && player) {
      isGameStarted = false;
      drawnNumbers.clear();
      currentTurnIndex = 0;
      io.emit('gameOver', `🎉 ${player.nickname}님이 ${bingoCount}개 빙고를 완성하여 승리했습니다! 🎉`);
    }
  });

  // 접속 종료 처리
  socket.on('disconnect', () => {
    const wasHost = players[0]?.id === socket.id;
    players = players.filter(p => p.id !== socket.id);

    if (players.length === 0) {
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
        // currentTurnIndex 재조정
        if (currentTurnIndex >= players.length) {
          currentTurnIndex = currentTurnIndex % players.length;
        }
        io.emit('playerLeft', {
          players,
          currentTurn: players[currentTurnIndex]?.nickname,
          drawnNumbers: Array.from(drawnNumbers)
        });
      }
    } else {
      io.emit('updateLobby', { players, hostId: players[0]?.id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));