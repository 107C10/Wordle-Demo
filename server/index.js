/**
 * Wordle Multiplayer Server
 * Express 提供静态文件 + Socket.IO 实时通信
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

// ─── Express ──────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// 静态文件：项目根目录
const ROOT = path.join(__dirname, '..');
app.use(express.static(ROOT));

// ─── Socket.IO ────────────────────────────────────
const io = new Server(server, {
    cors: { origin: '*' }
});

io.on('connection', (socket) => {
    console.log(`[连接] ${socket.id}`);

    socket.on('disconnect', () => {
        console.log(`[断开] ${socket.id}`);
    });
});

// ─── 启动 ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Wordle server running on http://localhost:${PORT}`);
});
