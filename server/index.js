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

    // ── 断开连接 ──
    socket.on('disconnect', () => {
        const roomId = RoomManager.findRoomBySocket(socket.id);
        if (roomId) {
            handleLeaveRoom(socket, roomId, true);
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
    console.log(`[房间] ${nickname} ${isDisconnect ? '断线离开' : '离开'}房间 ${roomId}`);
}

// ─── 启动 ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Wordle server running on http://localhost:${PORT}`);
});
