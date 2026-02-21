const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for simplicity, tighten in production
    methods: ["GET", "POST"]
  }
});

const wordData = require('./word.json');

// Flatten all category pairs into one pool
// Each entry: { citizen, imposter, category }
const WORDS_DB = wordData.categories.flatMap(cat =>
  cat.pairs.map(pair => ({
    citizen: pair.citizen,
    imposter: pair.undercover,
    category: cat.name
  }))
);

console.log(`Loaded ${WORDS_DB.length} word pairs across ${wordData.categories.length} categories.`);

// In-memory storage
const rooms = {};

// Pick a random word pair
const getRandomWordPair = () => WORDS_DB[Math.floor(Math.random() * WORDS_DB.length)];

// Helper to generate short room ID
const generateRoomId = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

// ── Turn Timer ────────────────────────────────────────────────────
const TURN_SECONDS = 30;
const timers = {}; // { [roomId]: intervalId }

function clearTurnTimer(roomId) {
  if (timers[roomId]) {
    clearInterval(timers[roomId]);
    delete timers[roomId];
  }
}

function startTurnTimer(roomId) {
  clearTurnTimer(roomId); // Always clear any existing timer first
  const room = rooms[roomId];
  if (!room) return;

  let remaining = TURN_SECONDS;
  io.to(roomId).emit('timerTick', remaining);

  timers[roomId] = setInterval(() => {
    remaining--;
    io.to(roomId).emit('timerTick', remaining);

    if (remaining <= 0) {
      clearTurnTimer(roomId);
      const r = rooms[roomId];
      if (!r || r.gameState !== 'PLAYING') return;

      const skippedPlayer = r.players[r.turnIndex];

      // Announce time up
      io.to(roomId).emit('playerAction', {
        username: skippedPlayer.username,
        action: 'WORD',
        payload: '⏰ (time\'s up — skipped)'
      });

      // Advance turn
      const nextIndex = (r.turnIndex + 1) % r.players.length;
      if (nextIndex === 0) {
        r.gameState = 'VOTING';
        r.votes = {};
        r.players.forEach(p => p.hasVoted = false);
        io.to(roomId).emit('phaseChange', 'VOTING');
      } else {
        r.turnIndex = nextIndex;
        io.to(roomId).emit('turnUpdate', { currentPlayerId: r.players[r.turnIndex].id });
        startTurnTimer(roomId);
      }
    }
  }, 1000);
}

// --- Socket Logic ---
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 1. Create Room
  socket.on('createRoom', ({ username, avatar }) => {
    if (!username) return;

    const roomId = generateRoomId();

    rooms[roomId] = {
      id: roomId,
      host: socket.id,
      players: [],
      gameState: 'LOBBY',
      turnIndex: 0,
      wordPair: null,
      votes: {},
      playAgainVotes: new Set()
    };

    socket.join(roomId);

    const newPlayer = {
      id: socket.id,
      username,
      avatar: avatar || '🐺',
      role: null,
      word: null,
      isAlive: true,
      hasVoted: false
    };
    rooms[roomId].players.push(newPlayer);

    socket.emit('roomCreated', roomId);
    io.to(roomId).emit('updateRoom', rooms[roomId]);
  });

  // 2. Join Room
  socket.on('joinRoom', ({ roomId, username, avatar }) => {
    if (!roomId || !username) return;

    const roomKey = roomId.toUpperCase();

    if (!rooms[roomKey]) {
      socket.emit('error', 'Room not found!');
      return;
    }

    const room = rooms[roomKey];

    if (room.gameState !== 'LOBBY') {
      socket.emit('error', 'Game already in progress');
      return;
    }

    socket.join(roomKey);

    const newPlayer = {
      id: socket.id,
      username,
      avatar: avatar || '🐺',
      role: null,
      word: null,
      isAlive: true,
      hasVoted: false
    };
    room.players.push(newPlayer);

    io.to(roomKey).emit('updateRoom', room);
  });

  // 3. Start Game
  socket.on('startGame', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.players.length < 3) { // Min 3 players for logic to work well
      socket.emit('error', 'Need at least 3 players to start');
      return; // In dev, maybe allow less for testing, but game logic needs 3 usually
    }

    if (room.host !== socket.id) {
      socket.emit('error', 'Only the host can start the game');
      return;
    }

    room.gameState = 'PLAYING';
    room.turnIndex = 0;

    // Assign Roles
    const wordPair = getRandomWordPair();
    room.wordPair = wordPair;

    // Random imposter index
    const imposterIndex = Math.floor(Math.random() * room.players.length);

    room.players.forEach((p, index) => {
      if (index === imposterIndex) {
        p.role = 'IMPOSTER';
        p.word = wordPair.imposter;
      } else {
        p.role = 'CITIZEN';
        p.word = wordPair.citizen;
      }
      // Send private role info + category (all players see the category)
      io.to(p.id).emit('gameStarted', {
        role: p.role,
        word: p.word,
        category: wordPair.category,
        players: room.players.map(pl => ({ id: pl.id, username: pl.username, avatar: pl.avatar }))
      });
    });

    // Notify whose turn it is and start timer
    io.to(roomId).emit('turnUpdate', {
      currentPlayerId: room.players[room.turnIndex].id
    });
    startTurnTimer(roomId);
  });

  // 4. Submit Word (Turn Action)
  socket.on('submitWord', ({ roomId, word }) => {
    const room = rooms[roomId];
    if (!room || room.gameState !== 'PLAYING') return;

    const currentPlayer = room.players[room.turnIndex];
    if (currentPlayer.id !== socket.id) {
      socket.emit('error', 'Not your turn');
      return;
    }

    clearTurnTimer(roomId); // Stop timer as soon as word is submitted

    // Broadcast the word
    io.to(roomId).emit('playerAction', {
      username: currentPlayer.username,
      action: 'WORD',
      payload: word
    });

    // Move to next turn
    const nextIndex = (room.turnIndex + 1) % room.players.length;

    if (nextIndex === 0) {
      room.gameState = 'VOTING';
      room.votes = {};
      room.players.forEach(p => p.hasVoted = false);
      io.to(roomId).emit('phaseChange', 'VOTING');
    } else {
      room.turnIndex = nextIndex;
      io.to(roomId).emit('turnUpdate', {
        currentPlayerId: room.players[room.turnIndex].id
      });
      startTurnTimer(roomId); // Start fresh timer for next player
    }
  });

  // 5. Voting
  socket.on('vote', ({ roomId, suspectId }) => {
    const room = rooms[roomId];
    if (!room || room.gameState !== 'VOTING') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.hasVoted || !player.isAlive) return;

    // Record vote ('SKIP' is a valid suspectId meaning the player skips)
    if (!room.votes[suspectId]) room.votes[suspectId] = 0;
    room.votes[suspectId]++;
    player.hasVoted = true;

    // Check if all ALIVE players voted (only count alive voters to avoid dead-player deadlock)
    const activePlayersCount = room.players.filter(p => p.isAlive).length;
    const votesCast = room.players.filter(p => p.isAlive && p.hasVoted).length;

    io.to(roomId).emit('voteUpdate', { votesCast, total: activePlayersCount });

    if (votesCast === activePlayersCount) {
      // Tally votes — find the top voted suspectId
      let maxVotes = 0;
      let eliminatedId = null;
      let tie = false;

      for (const [pid, count] of Object.entries(room.votes)) {
        if (count > maxVotes) {
          maxVotes = count;
          eliminatedId = pid;
          tie = false;
        } else if (count === maxVotes) {
          tie = true;
        }
      }

      // If the winning vote is SKIP, or there's a tie → no elimination
      if (tie || !eliminatedId || eliminatedId === 'SKIP') {
        const skipMsg = eliminatedId === 'SKIP' && !tie
          ? 'The group voted to skip! No one eliminated.'
          : 'Tie! No one eliminated.';
        io.to(roomId).emit('roundResult', { message: skipMsg, eliminated: null });
        room.gameState = 'PLAYING';
        room.turnIndex = 0;
        room.votes = {};
        room.players.forEach(p => p.hasVoted = false);
        io.to(roomId).emit('phaseChange', 'PLAYING');
        io.to(roomId).emit('turnUpdate', { currentPlayerId: room.players[0].id });
        startTurnTimer(roomId);
      } else {
        const eliminatedPlayer = room.players.find(p => p.id === eliminatedId);
        eliminatedPlayer.isAlive = false;

        const isImposter = eliminatedPlayer.role === 'IMPOSTER';

        const playersReveal = room.players.map(p => ({
          username: p.username,
          role: p.role,
          isAlive: p.isAlive,
          word: p.word
        }));

        io.to(roomId).emit('roundResult', {
          message: `${eliminatedPlayer.username} was eliminated!`,
          eliminated: eliminatedPlayer.username,
          role: eliminatedPlayer.role
        });

        if (isImposter) {
          io.to(roomId).emit('gameOver', { winner: 'CITIZENS', players: playersReveal });
          room.gameState = 'ENDED';
        } else {
          const citizensAlive = room.players.filter(p => p.role === 'CITIZEN' && p.isAlive).length;
          if (citizensAlive <= 1) {
            io.to(roomId).emit('gameOver', { winner: 'IMPOSTER', players: playersReveal });
            room.gameState = 'ENDED';
          } else {
            room.gameState = 'PLAYING';
            room.turnIndex = 0;
            room.votes = {};
            room.players.forEach(p => p.hasVoted = false);
            io.to(roomId).emit('updateRoom', room); // sync dead-player state to all clients
            io.to(roomId).emit('phaseChange', 'PLAYING');
            io.to(roomId).emit('turnUpdate', { currentPlayerId: room.players.find(p => p.isAlive).id });
            startTurnTimer(roomId);
          }
        }
      }
    }
  });

  // 6. Play Again
  socket.on('playAgain', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.gameState !== 'ENDED') return;

    // Immediately restart — no waiting for all players
    room.playAgainVotes.clear();
    room.votes = {};
    room.players.forEach(p => {
      p.isAlive = true;
      p.hasVoted = false;
      p.role = null;
      p.word = null;
    });

    // Assign new roles + words
    const wordPair = getRandomWordPair();
    room.wordPair = wordPair;
    room.gameState = 'PLAYING';
    room.turnIndex = 0;

    const imposterIndex = Math.floor(Math.random() * room.players.length);
    room.players.forEach((p, index) => {
      p.role = index === imposterIndex ? 'IMPOSTER' : 'CITIZEN';
      p.word = index === imposterIndex ? wordPair.imposter : wordPair.citizen;
      io.to(p.id).emit('gameStarted', {
        role: p.role,
        word: p.word,
        category: wordPair.category,
        players: room.players.map(pl => ({ id: pl.id, username: pl.username, avatar: pl.avatar }))
      });
    });

    io.to(roomId).emit('updateRoom', room);
    io.to(roomId).emit('turnUpdate', { currentPlayerId: room.players[0].id });
    startTurnTimer(roomId);
  });

  // 7. Disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        room.players.splice(index, 1);
        io.to(roomId).emit('updateRoom', room);
        if (room.players.length === 0) {
          clearTurnTimer(roomId);
          delete rooms[roomId];
        }
        break;
      }
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
