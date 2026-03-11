/**
 * Wordle Multiplayer Server
 * Express 静态文件 + Socket.IO 实时通信
 * 支持 versus / coop 模式，选手席 + 观众席架构
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const vm      = require('vm');
const fs      = require('fs');

const Judge       = require('../js/judge');
const RoomManager = require('./roomManager');
const { createRedisStore } = require('./redisStore');

// ─── 可选 Redis 持久化 ───────────────────────────
const redisStore = createRedisStore();

async function persistRoom(roomId) {
    if (!redisStore) return;
    const room = RoomManager.getRoom(roomId);
    if (room) {
        try { await redisStore.saveRoom(room); } catch (e) {
            console.error('[Redis] 保存失败:', e.message);
        }
    } else {
        try { await redisStore.deleteRoom(roomId); } catch (e) {}
    }
}

// ─── 加载词库 ────────────────────────────────────
const sandbox = { WORD_DATA: {} };
vm.createContext(sandbox);
const jsDir = path.join(__dirname, '..', 'js');
const wordsCode = fs.readFileSync(path.join(jsDir, 'words.js'), 'utf8')
    .replace(/^const WORD_DATA\s*=\s*\{\};?/m, '');
vm.runInContext(wordsCode, sandbox);
vm.runInContext(fs.readFileSync(path.join(jsDir, 'words6.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(jsDir, 'words7.js'), 'utf8'), sandbox);
const WORD_DATA = sandbox.WORD_DATA;

function getWordSet(len) {
    const data = WORD_DATA[len];
    if (!data) return null;
    return {
        answers:     data.answers,
        validGuesses: new Set([...data.answers, ...data.extras])
    };
}

function pickRandomWord(len) {
    const ws = getWordSet(len);
    if (!ws) return null;
    return ws.answers[Math.floor(Math.random() * ws.answers.length)].toUpperCase();
}

// ─── Express ──────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const ROOT   = path.join(__dirname, '..');
app.use(express.static(ROOT));

// ─── Socket.IO ────────────────────────────────────
const io = new Server(server, { cors: { origin: '*' } });

// ─── 速率限制 ─────────────────────────────────────
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 1000;
const RATE_LIMIT_MAX    = 30;

function checkRateLimit(socketId) {
    const now = Date.now();
    let entry = rateLimits.get(socketId);
    if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
        rateLimits.set(socketId, entry);
    }
    entry.count++;
    return entry.count <= RATE_LIMIT_MAX;
}

/** 序列化玩家胜负状态 */
function serializePlayersStatus(room) {
    const result = {};
    for (const [sid, p] of room.players) {
        const hist = room.history.get(sid);
        result[sid] = {
            nickname: p.nickname,
            won: p.won,
            gameOver: p.gameOver,
            guessCount: hist ? hist.length : 0
        };
    }
    return result;
}

/** 广播投票状态 + 检查是否全票通过 → 开始新轮 */
function broadcastVoteStatus(roomId) {
    const room = RoomManager.getRoom(roomId);
    if (!room || !room.roundOver) return;

    const status = RoomManager.getPlayAgainStatus(room);
    io.to(roomId).emit('play-again-vote', {
        voteCount: status.voteCount,
        totalNeeded: status.totalNeeded,
        seatCount: room.players.size,
        maxSeats: RoomManager.MAX_SEATS
    });

    if (status.allAgreed) {
        const newAnswer = pickRandomWord(room.wordLength);
        RoomManager.resetRound(room, newAnswer);

        io.to(roomId).emit('new-round', {
            state: RoomManager.serializeRoom(room)
        });

        persistRoom(roomId);
        console.log(`[新轮] 房间 ${roomId} 全员同意，新一轮开始`);
    }
}

// ─── Socket 事件处理 ──────────────────────────────
io.on('connection', (socket) => {
    console.log(`[连接] ${socket.id}`);

    // ── 创建房间 ──
    socket.on('create-room', ({ nickname, wordLength, mode }) => {
        if (!checkRateLimit(socket.id)) return;
        if (!nickname || typeof nickname !== 'string') return;
        nickname = nickname.slice(0, 20);
        wordLength = Number(wordLength) || 5;
        if (!mode || !['versus', 'coop'].includes(mode)) mode = 'versus';

        const answer = pickRandomWord(wordLength);
        if (!answer) {
            socket.emit('room-error', { message: '无效的单词长度' });
            return;
        }

        const result = RoomManager.createRoom(socket.id, nickname, wordLength, answer, mode);
        if (!result.ok) {
            socket.emit('room-error', { message: result.error });
            return;
        }

        socket.join(result.room.id);
        socket.emit('room-created', {
            roomId: result.room.id,
            state:  RoomManager.serializeRoom(result.room),
            role:   'player'
        });
        persistRoom(result.room.id);
        console.log(`[房间] ${nickname} 创建房间 ${result.room.id} (${wordLength}字母, ${mode})`);
    });

    // ── 加入房间 ──
    socket.on('join-room', ({ roomId, nickname }) => {
        if (!checkRateLimit(socket.id)) return;
        if (!nickname || typeof nickname !== 'string') return;
        if (!roomId || typeof roomId !== 'string') return;
        nickname = nickname.slice(0, 20);
        roomId = roomId.trim().slice(0, 4);

        const result = RoomManager.joinRoom(roomId, socket.id, nickname);
        if (!result.ok) {
            socket.emit('room-error', { message: result.error });
            return;
        }

        socket.join(roomId);
        socket.emit('room-joined', {
            roomId,
            state: RoomManager.serializeRoom(result.room),
            role:  result.role
        });

        // 通知房间内其他人
        socket.to(roomId).emit('player-joined', {
            socketId: socket.id,
            nickname,
            role: result.role
        });

        persistRoom(roomId);
        console.log(`[房间] ${nickname} 以${result.role === 'player' ? '选手' : '观众'}身份加入房间 ${roomId}`);
    });

    // ── 房主开始游戏 ──
    socket.on('start-game', ({ roomId, customWord }) => {
        if (!checkRateLimit(socket.id)) return;
        if (!roomId || typeof roomId !== 'string') return;

        // 合作模式支持自定义单词
        if (customWord && typeof customWord === 'string') {
            const room = RoomManager.getRoom(roomId);
            if (room && room.mode === 'coop' && room.hostId === socket.id) {
                customWord = customWord.toUpperCase().slice(0, room.wordLength);
                if (customWord.length === room.wordLength) {
                    const ws = getWordSet(room.wordLength);
                    if (ws && ws.validGuesses.has(customWord.toLowerCase())) {
                        room.answer = customWord;
                    } else {
                        socket.emit('room-error', { message: '该单词不在词库中' });
                        return;
                    }
                }
            }
        }

        const result = RoomManager.startGame(roomId, socket.id);
        if (!result.ok) {
            socket.emit('room-error', { message: result.error });
            return;
        }

        const room = RoomManager.getRoom(roomId);
        io.to(roomId).emit('game-started', {
            state: RoomManager.serializeRoom(room)
        });

        persistRoom(roomId);
        console.log(`[开始] 房间 ${roomId} 游戏开始${customWord ? ' (自定义单词)' : ''}`);
    });

    // ── 离开房间 ──
    socket.on('leave-room', ({ roomId }) => {
        if (!checkRateLimit(socket.id)) return;
        handleLeaveRoom(socket, roomId);
    });

    // ── 实时候选框广播 ──
    socket.on('update-box', ({ roomId, row, candidateRow }) => {
        if (!checkRateLimit(socket.id)) return;
        if (!roomId || typeof roomId !== 'string') return;
        if (!Array.isArray(candidateRow)) return;
        if (candidateRow.length > 7) return;

        const room = RoomManager.getRoom(roomId);
        if (!room || !room.players.has(socket.id)) return;

        // 合作模式不需要广播候选框（共享棋盘，无对手面板）
        if (room.mode === 'coop') return;

        const player = room.players.get(socket.id);
        player.currentRow = row;
        player.candidateRow = candidateRow;

        // 给其他选手发（不含字母具体内容，只有是否有输入）
        for (const [sid] of room.players) {
            if (sid === socket.id) continue;
            io.to(sid).emit('box-updated', {
                socketId: socket.id,
                row,
                candidateRow: candidateRow.map(c => c ? '*' : '')
            });
        }

        // 给观众发完整信息
        for (const [sid] of room.spectators) {
            io.to(sid).emit('box-updated', {
                socketId: socket.id,
                row,
                candidateRow
            });
        }
    });

    // ── 提交猜测 ──
    socket.on('submit-guess', ({ roomId, guess }) => {
        if (!checkRateLimit(socket.id)) return;
        if (!roomId || typeof roomId !== 'string') return;
        if (!guess || typeof guess !== 'string') return;

        const room = RoomManager.getRoom(roomId);
        if (!room) {
            socket.emit('room-error', { message: '房间不存在' });
            return;
        }

        if (!room.gameStarted) {
            socket.emit('room-error', { message: '游戏尚未开始' });
            return;
        }

        const player = room.players.get(socket.id);
        if (!player) {
            socket.emit('room-error', { message: '你不是选手' });
            return;
        }

        if (room.roundOver) {
            socket.emit('room-error', { message: '本轮已结束' });
            return;
        }

        guess = guess.toUpperCase().slice(0, room.wordLength);
        if (guess.length !== room.wordLength) {
            socket.emit('room-error', { message: '单词长度不正确' });
            return;
        }

        const ws = getWordSet(room.wordLength);
        if (!ws || !ws.validGuesses.has(guess.toLowerCase())) {
            socket.emit('room-error', { message: '不在单词列表中' });
            return;
        }

        const evaluation = Judge.evaluateGuess(guess, room.answer);

        if (room.mode === 'coop') {
            // ── 合作模式 ──
            const coopResult = RoomManager.recordCoopGuess(roomId, socket.id, guess, evaluation);
            if (!coopResult.ok) {
                socket.emit('room-error', { message: coopResult.error });
                return;
            }

            const coopEntry = room.coopHistory[room.coopHistory.length - 1];

            // 广播给房间所有人（选手 + 观众）
            io.to(roomId).emit('coop-guess', {
                guess,
                evaluation,
                nickname: coopEntry.nickname,
                socketId: socket.id,
                row: room.coopHistory.length - 1,
                won: coopResult.won,
                roundOver: coopResult.roundOver,
                answer: coopResult.roundOver && !coopResult.won ? room.answer : undefined
            });

            if (coopResult.roundOver) {
                io.to(roomId).emit('round-over', {
                    won: coopResult.won,
                    answer: room.answer,
                    mode: 'coop',
                    players: serializePlayersStatus(room),
                    seatCount: room.players.size,
                    maxSeats: RoomManager.MAX_SEATS
                });
            }

            persistRoom(roomId);
            console.log(`[coop] ${player.nickname} 在房间 ${roomId} 猜 ${guess} → ${coopResult.won ? '✓' : (coopResult.roundOver ? '✗' : '...')}`);
        } else {
            // ── 对抗模式 ──
            if (player.gameOver) {
                socket.emit('room-error', { message: '你的游戏已结束' });
                return;
            }

            const recordResult = RoomManager.recordGuess(roomId, socket.id, guess, evaluation);
            if (!recordResult.ok) {
                socket.emit('room-error', { message: recordResult.error });
                return;
            }

            const won = evaluation.every(e => e === 'correct');
            const hist = room.history.get(socket.id);
            const isGameOver = won || hist.length >= 6;

            // 给自己发完整结果
            socket.emit('guess-result', {
                evaluation,
                won,
                gameOver: isGameOver,
                answer: isGameOver && !won ? room.answer : undefined
            });

            // 给其他选手发进度（不含猜测字母）
            for (const [sid] of room.players) {
                if (sid === socket.id) continue;
                io.to(sid).emit('player-guess', {
                    socketId: socket.id,
                    evaluation,
                    row: hist.length - 1,
                    won,
                    gameOver: isGameOver
                });
            }

            // 给观众发完整信息（含猜测字母）
            for (const [sid] of room.spectators) {
                io.to(sid).emit('spectator-guess', {
                    socketId: socket.id,
                    nickname: player.nickname,
                    guess,
                    evaluation,
                    row: hist.length - 1,
                    won,
                    gameOver: isGameOver
                });
            }

            // 检查全局结束
            if (RoomManager.checkVersusRoundOver(room)) {
                io.to(roomId).emit('round-over', {
                    won: false,
                    answer: room.answer,
                    mode: 'versus',
                    players: serializePlayersStatus(room),
                    seatCount: room.players.size,
                    maxSeats: RoomManager.MAX_SEATS
                });
            }

            persistRoom(roomId);
            console.log(`[versus] ${player.nickname} 在房间 ${roomId} 猜 ${guess} → ${won ? '✓' : (isGameOver ? '✗' : '...')}`);
        }
    });

    // ── 投票再来一局 ──
    socket.on('vote-play-again', ({ roomId }) => {
        if (!checkRateLimit(socket.id)) return;
        if (!roomId || typeof roomId !== 'string') return;

        const result = RoomManager.votePlayAgain(roomId, socket.id);
        if (!result.ok) {
            socket.emit('room-error', { message: result.error });
            return;
        }

        broadcastVoteStatus(roomId);
    });

    // ── 观众加入选手席 ──
    socket.on('join-seat', ({ roomId }) => {
        if (!checkRateLimit(socket.id)) return;
        if (!roomId || typeof roomId !== 'string') return;

        const result = RoomManager.joinSeat(roomId, socket.id);
        if (!result.ok) {
            socket.emit('room-error', { message: result.error });
            return;
        }

        const room = RoomManager.getRoom(roomId);
        // 通知自己角色变更
        socket.emit('role-changed', {
            role: 'player',
            state: RoomManager.serializeRoom(room)
        });

        // 通知房间内其他人
        socket.to(roomId).emit('spectator-to-player', {
            socketId: socket.id,
            nickname: result.nickname
        });

        persistRoom(roomId);
        console.log(`[选手席] ${result.nickname} 从观众转为选手 (房间 ${roomId})`);
    });

    // ── 选手退回观众席 ──
    socket.on('leave-seat', ({ roomId }) => {
        if (!checkRateLimit(socket.id)) return;
        if (!roomId || typeof roomId !== 'string') return;

        const result = RoomManager.leaveSeat(roomId, socket.id);
        if (!result.ok) {
            socket.emit('room-error', { message: result.error });
            return;
        }

        const room = RoomManager.getRoom(roomId);
        // 通知自己角色变更
        socket.emit('role-changed', {
            role: 'spectator',
            state: RoomManager.serializeRoom(room)
        });

        // 通知房间内其他人
        socket.to(roomId).emit('player-to-spectator', {
            socketId: socket.id,
            nickname: result.nickname
        });

        persistRoom(roomId);
        console.log(`[观众席] ${result.nickname} 从选手转为观众 (房间 ${roomId})`);
    });

    // ── 重连房间 ──
    socket.on('rejoin-room', ({ roomId, nickname }) => {
        if (!checkRateLimit(socket.id)) return;
        if (!roomId || typeof roomId !== 'string') return;
        if (!nickname || typeof nickname !== 'string') return;
        nickname = nickname.slice(0, 20);
        roomId = roomId.trim().slice(0, 4);

        const result = RoomManager.rejoinRoom(roomId, socket.id, nickname);
        if (!result.ok) {
            socket.emit('rejoin-failed', { message: result.error, roomId });
            return;
        }

        socket.join(roomId);
        const state = RoomManager.serializeRoom(result.room);
        const myHistory = result.role === 'player'
            ? (result.room.history.get(socket.id) || [])
            : [];

        socket.emit('room-rejoined', {
            roomId,
            state,
            myHistory,
            role: result.role
        });

        socket.to(roomId).emit('player-reconnected', {
            socketId: socket.id,
            oldSocketId: result.oldSocketId,
            nickname,
            role: result.role
        });

        persistRoom(roomId);
        console.log(`[重连] ${nickname} 以${result.role}身份重连到房间 ${roomId}`);
    });

    // ── 断开连接 ──
    socket.on('disconnect', () => {
        const roomId = RoomManager.findRoomBySocket(socket.id);
        if (roomId) {
            const room = RoomManager.getRoom(roomId);
            const wasRoundOver = room && room.roundOver;

            const dcResult = RoomManager.disconnectPlayer(roomId, socket.id, (rid, sid, nick) => {
                io.to(rid).emit('player-left', {
                    socketId: sid,
                    nickname: nick
                });
                // 如果在投票阶段，断线超时移除后更新投票
                const r = RoomManager.getRoom(rid);
                if (r && r.roundOver) {
                    broadcastVoteStatus(rid);
                }
                persistRoom(rid);
                console.log(`[超时] ${nick} 在房间 ${rid} 断线超时，已移除`);
            });

            if (dcResult.ok) {
                socket.to(roomId).emit('player-disconnected', {
                    socketId: socket.id,
                    nickname: dcResult.nickname,
                    role: dcResult.role
                });

                // 如果在投票阶段，断线时实时更新投票（断线者不计入总数）
                if (wasRoundOver) {
                    broadcastVoteStatus(roomId);
                }

                persistRoom(roomId);
            }
        }
        rateLimits.delete(socket.id);
        console.log(`[断开] ${socket.id}`);
    });
});

/** 处理离开房间 */
function handleLeaveRoom(socket, roomId) {
    const room = RoomManager.getRoom(roomId);
    if (!room) return;

    const role = RoomManager.getRole(room, socket.id);
    const player = room.players.get(socket.id);
    const spec = room.spectators.get(socket.id);
    const nickname = player ? player.nickname : (spec ? spec.nickname : '未知');
    const wasRoundOver = room.roundOver;

    const result = RoomManager.leaveRoom(roomId, socket.id);
    if (!result.ok) return;

    socket.leave(roomId);

    if (!result.isEmpty) {
        io.to(roomId).emit('player-left', {
            socketId: socket.id,
            nickname,
            newHostId: result.newHostId,
            wasPlayer: result.wasPlayer
        });

        // 如果在投票阶段，选手离开后更新投票
        if (wasRoundOver && result.wasPlayer) {
            broadcastVoteStatus(roomId);
        }
    }
    persistRoom(roomId);
    console.log(`[房间] ${nickname} 离开房间 ${roomId}`);
}

// ─── 启动 ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Wordle server running on http://localhost:${PORT}`);
});
