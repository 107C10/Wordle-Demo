/**
 * Wordle Multiplayer Server
 * Express 提供静态文件 + Socket.IO 实时通信
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

/** 保存房间到 Redis（如果可用） */
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

// ─── 加载词库（在沙箱中执行浏览器端 JS）──────────
const sandbox = { WORD_DATA: {} };
vm.createContext(sandbox);
const jsDir = path.join(__dirname, '..', 'js');
vm.runInContext(fs.readFileSync(path.join(jsDir, 'words.js'),  'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(jsDir, 'words6.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(jsDir, 'words7.js'), 'utf8'), sandbox);
const WORD_DATA = sandbox.WORD_DATA;

/** 根据长度获取词库 */
function getWordSet(len) {
    const data = WORD_DATA[len];
    if (!data) return null;
    return {
        answers:     data.answers,
        validGuesses: new Set([...data.answers, ...data.extras])
    };
}

/** 随机选词 */
function pickRandomWord(len) {
    const ws = getWordSet(len);
    if (!ws) return null;
    return ws.answers[Math.floor(Math.random() * ws.answers.length)].toUpperCase();
}

// ─── Express ──────────────────────────────────────
const app    = express();
const server = http.createServer(app);

const ROOT = path.join(__dirname, '..');
app.use(express.static(ROOT));

// ─── Socket.IO ────────────────────────────────────
const io = new Server(server, {
    cors: { origin: '*' }
});

// ─── 速率限制 ─────────────────────────────────────
const rateLimits = new Map(); // socketId -> { count, resetAt }
const RATE_LIMIT_WINDOW = 1000; // 1 秒
const RATE_LIMIT_MAX    = 30;   // 每秒最多 30 条消息

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

// ─── Socket 事件处理 ──────────────────────────────
io.on('connection', (socket) => {
    console.log(`[连接] ${socket.id}`);

    // ── 创建房间 ──
    socket.on('create-room', ({ nickname, wordLength }) => {
        if (!checkRateLimit(socket.id)) return;
        if (!nickname || typeof nickname !== 'string') return;
        nickname = nickname.slice(0, 20); // 昵称最长 20 字符
        wordLength = Number(wordLength) || 5;

        const answer = pickRandomWord(wordLength);
        if (!answer) {
            socket.emit('room-error', { message: '无效的单词长度' });
            return;
        }

        const result = RoomManager.createRoom(socket.id, nickname, wordLength, answer);
        if (!result.ok) {
            socket.emit('room-error', { message: result.error });
            return;
        }

        socket.join(result.room.id);
        socket.emit('room-created', {
            roomId: result.room.id,
            state:  RoomManager.serializeRoom(result.room)
        });
        persistRoom(result.room.id);
        console.log(`[房间] ${nickname} 创建房间 ${result.room.id} (${wordLength}字母)`);
    });

    // ── 加入房间 ──
    socket.on('join-room', ({ roomId, nickname }) => {
        if (!checkRateLimit(socket.id)) return;
        if (!nickname || typeof nickname !== 'string') return;
        if (!roomId || typeof roomId !== 'string') return;
        nickname = nickname.slice(0, 20);
        roomId = roomId.toUpperCase().slice(0, 6);

        const result = RoomManager.joinRoom(roomId, socket.id, nickname);
        if (!result.ok) {
            socket.emit('room-error', { message: result.error });
            return;
        }

        socket.join(roomId);
        // 通知加入者
        socket.emit('room-joined', {
            roomId,
            state: RoomManager.serializeRoom(result.room)
        });
        // 通知房间其他人
        socket.to(roomId).emit('player-joined', {
            socketId: socket.id,
            nickname
        });
        persistRoom(roomId);
        console.log(`[房间] ${nickname} 加入房间 ${roomId}`);
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
        // 消息长度限制：candidateRow 最多 7 个字符
        if (candidateRow.length > 7) return;

        const room = RoomManager.getRoom(roomId);
        if (!room || !room.players.has(socket.id)) return;

        // 更新玩家状态
        const player = room.players.get(socket.id);
        player.currentRow = row;
        player.candidateRow = candidateRow;

        // 广播给房间其他人
        socket.to(roomId).emit('box-updated', {
            socketId: socket.id,
            row,
            candidateRow
        });
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

        const player = room.players.get(socket.id);
        if (!player) {
            socket.emit('room-error', { message: '你不在此房间' });
            return;
        }
        if (player.gameOver) {
            socket.emit('room-error', { message: '你的游戏已结束' });
            return;
        }

        // 消息长度限制
        guess = guess.toUpperCase().slice(0, room.wordLength);
        if (guess.length !== room.wordLength) {
            socket.emit('room-error', { message: '单词长度不正确' });
            return;
        }

        // 验证是否为合法单词
        const ws = getWordSet(room.wordLength);
        if (!ws || !ws.validGuesses.has(guess.toLowerCase())) {
            socket.emit('room-error', { message: '不在单词列表中' });
            return;
        }

        // 使用 Judge 评估
        const evaluation = Judge.evaluateGuess(guess, room.answer);

        // 记录猜测
        const recordResult = RoomManager.recordGuess(roomId, socket.id, guess, evaluation);
        if (!recordResult.ok) {
            socket.emit('room-error', { message: recordResult.error });
            return;
        }

        // 判断结果
        const won = evaluation.every(e => e === 'correct');
        const hist = room.history.get(socket.id);
        const isGameOver = won || hist.length >= 6;

        // 发送结果给提交者
        socket.emit('guess-result', {
            evaluation,
            won,
            gameOver: isGameOver,
            answer: isGameOver && !won ? room.answer : undefined
        });

        // 广播给房间其他人
        socket.to(roomId).emit('player-guess', {
            socketId: socket.id,
            guess,
            evaluation,
            row: hist.length - 1,
            won,
            gameOver: isGameOver
        });

        persistRoom(roomId);
        console.log(`[猜测] ${player.nickname} 在房间 ${roomId} 猜 ${guess} → ${won ? '✓' : (isGameOver ? '✗' : '...')}`);
    });

    // ── 重连房间 ──
    socket.on('rejoin-room', ({ roomId, nickname }) => {
        if (!checkRateLimit(socket.id)) return;
        if (!roomId || typeof roomId !== 'string') return;
        if (!nickname || typeof nickname !== 'string') return;
        nickname = nickname.slice(0, 20);
        roomId = roomId.toUpperCase().slice(0, 6);

        const result = RoomManager.rejoinRoom(roomId, socket.id, nickname);
        if (!result.ok) {
            // 重连失败，尝试普通加入
            socket.emit('rejoin-failed', { message: result.error, roomId });
            return;
        }

        socket.join(roomId);

        // 发送完整房间状态
        const state = RoomManager.serializeRoom(result.room);
        // 附加自己的历史（用于恢复棋盘）
        const myHistory = result.room.history.get(socket.id) || [];
        socket.emit('room-rejoined', {
            roomId,
            state,
            myHistory
        });

        // 通知其他玩家
        socket.to(roomId).emit('player-reconnected', {
            socketId: socket.id,
            oldSocketId: result.oldSocketId,
            nickname
        });

        persistRoom(roomId);
        console.log(`[重连] ${nickname} 重连到房间 ${roomId}`);
    });

    // ── 断开连接 ──
    socket.on('disconnect', () => {
        const roomId = RoomManager.findRoomBySocket(socket.id);
        if (roomId) {
            // 标记为断线而非立即移除
            const dcResult = RoomManager.disconnectPlayer(roomId, socket.id, (rid, sid, nick) => {
                // 超时回调：通知房间玩家已永久离开
                io.to(rid).emit('player-left', {
                    socketId: sid,
                    nickname: nick
                });
                console.log(`[超时] ${nick} 在房间 ${rid} 断线超时，已移除`);
            });

            if (dcResult.ok) {
                socket.to(roomId).emit('player-disconnected', {
                    socketId: socket.id,
                    nickname: dcResult.nickname
                });
                persistRoom(roomId);
            }
        }
        rateLimits.delete(socket.id);
        console.log(`[断开] ${socket.id}`);
    });
});

/** 处理离开房间 */
function handleLeaveRoom(socket, roomId, isDisconnect = false) {
    const room = RoomManager.getRoom(roomId);
    if (!room) return;

    const player = room.players.get(socket.id);
    const nickname = player ? player.nickname : '未知';

    const result = RoomManager.leaveRoom(roomId, socket.id);
    if (!result.ok) return;

    socket.leave(roomId);

    if (!result.isEmpty) {
        const eventName = isDisconnect ? 'player-disconnected' : 'player-left';
        io.to(roomId).emit(eventName, {
            socketId: socket.id,
            nickname,
            newHostId: result.newHostId
        });
    }
    persistRoom(roomId);
    console.log(`[房间] ${nickname} ${isDisconnect ? '断线离开' : '离开'}房间 ${roomId}`);
}

// ─── 启动 ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Wordle server running on http://localhost:${PORT}`);
});
