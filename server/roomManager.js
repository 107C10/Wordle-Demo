/**
 * Room Manager — 内存房间管理
 *
 * 房间结构:
 * {
 *   id:          string,           // 6 位大写字母房间码
 *   wordLength:  number,           // 5 | 6 | 7
 *   answer:      string,           // 目标单词（大写）
 *   hostId:      string,           // 房主 socket.id
 *   players:     Map<socketId, PlayerInfo>,
 *   history:     Map<socketId, Array<{ guess, evaluation }>>,
 *   createdAt:   number
 * }
 *
 * PlayerInfo:
 * {
 *   nickname:     string,
 *   currentRow:   number,
 *   currentCol:   number,
 *   candidateRow: string[],   // 当前正在输入的行
 *   gameOver:     boolean,
 *   won:          boolean
 * }
 */

const crypto = require('crypto');

// ─── 内存存储 ─────────────────────────────────────
const rooms = new Map();
const disconnectedPlayers = new Map(); // socketId -> { roomId, nickname, timer }
const DISCONNECT_TIMEOUT = 60000;      // 60 秒断线保护

// ─── 工具函数 ─────────────────────────────────────

/** 生成 6 位大写字母房间码 */
function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符 I/O/0/1
    let id;
    do {
        id = '';
        const bytes = crypto.randomBytes(6);
        for (let i = 0; i < 6; i++) {
            id += chars[bytes[i] % chars.length];
        }
    } while (rooms.has(id));
    return id;
}

// ─── 公开 API ─────────────────────────────────────

/**
 * 创建房间
 * @param {string} hostSocketId
 * @param {string} nickname
 * @param {number} wordLength   5 | 6 | 7
 * @param {string} answer       目标单词（大写）
 * @returns {{ ok: boolean, room?: object, error?: string }}
 */
function createRoom(hostSocketId, nickname, wordLength, answer) {
    if (![5, 6, 7].includes(wordLength)) {
        return { ok: false, error: '无效的单词长度' };
    }
    if (!answer || answer.length !== wordLength) {
        return { ok: false, error: '无效的目标单词' };
    }

    const id = generateRoomId();
    const room = {
        id,
        wordLength,
        answer: answer.toUpperCase(),
        hostId: hostSocketId,
        players: new Map(),
        history: new Map(),
        createdAt: Date.now()
    };

    // 房主自动加入
    room.players.set(hostSocketId, {
        nickname,
        currentRow: 0,
        currentCol: 0,
        candidateRow: [],
        gameOver: false,
        won: false
    });
    room.history.set(hostSocketId, []);

    rooms.set(id, room);
    return { ok: true, room };
}

/**
 * 加入房间
 * @param {string} roomId
 * @param {string} socketId
 * @param {string} nickname
 * @returns {{ ok: boolean, room?: object, error?: string }}
 */
function joinRoom(roomId, socketId, nickname) {
    const room = rooms.get(roomId);
    if (!room) return { ok: false, error: '房间不存在' };
    if (room.players.size >= 8) return { ok: false, error: '房间已满（最多 8 人）' };
    if (room.players.has(socketId)) return { ok: false, error: '你已在房间中' };

    room.players.set(socketId, {
        nickname,
        currentRow: 0,
        currentCol: 0,
        candidateRow: [],
        gameOver: false,
        won: false
    });
    room.history.set(socketId, []);

    return { ok: true, room };
}

/**
 * 离开房间
 * @param {string} roomId
 * @param {string} socketId
 * @returns {{ ok: boolean, isEmpty: boolean, newHostId?: string }}
 */
function leaveRoom(roomId, socketId) {
    const room = rooms.get(roomId);
    if (!room) return { ok: false, isEmpty: true };

    room.players.delete(socketId);
    room.history.delete(socketId);

    if (room.players.size === 0) {
        rooms.delete(roomId);
        return { ok: true, isEmpty: true };
    }

    // 如果离开的是房主，转移房主
    if (room.hostId === socketId) {
        room.hostId = room.players.keys().next().value;
    }

    return { ok: true, isEmpty: false, newHostId: room.hostId };
}

/**
 * 获取房间
 * @param {string} roomId
 * @returns {object|null}
 */
function getRoom(roomId) {
    return rooms.get(roomId) || null;
}

/**
 * 获取玩家所在的房间 ID
 * @param {string} socketId
 * @returns {string|null}
 */
function findRoomBySocket(socketId) {
    for (const [roomId, room] of rooms) {
        if (room.players.has(socketId)) return roomId;
    }
    return null;
}

/**
 * 记录一次猜测
 * @param {string} roomId
 * @param {string} socketId
 * @param {string} guess
 * @param {string[]} evaluation
 * @returns {{ ok: boolean, error?: string }}
 */
function recordGuess(roomId, socketId, guess, evaluation) {
    const room = rooms.get(roomId);
    if (!room) return { ok: false, error: '房间不存在' };

    const player = room.players.get(socketId);
    if (!player) return { ok: false, error: '你不在此房间' };
    if (player.gameOver) return { ok: false, error: '你的游戏已结束' };

    const hist = room.history.get(socketId);
    hist.push({ guess, evaluation });
    player.currentRow = hist.length;
    player.currentCol = 0;
    player.candidateRow = [];

    // 检查是否猜对
    if (evaluation.every(e => e === 'correct')) {
        player.gameOver = true;
        player.won = true;
    } else if (hist.length >= 6) {
        player.gameOver = true;
        player.won = false;
    }

    return { ok: true };
}

/**
 * 序列化房间状态（安全版，不含 answer）
 * @param {object} room
 * @returns {object}
 */
function serializeRoom(room) {
    const players = {};
    for (const [sid, p] of room.players) {
        players[sid] = {
            nickname: p.nickname,
            currentRow: p.currentRow,
            gameOver: p.gameOver,
            won: p.won
        };
    }
    const history = {};
    for (const [sid, h] of room.history) {
        history[sid] = h;
    }
    return {
        id: room.id,
        wordLength: room.wordLength,
        hostId: room.hostId,
        players,
        history
    };
}

/**
 * 列出所有房间（调试用）
 */
function listRooms() {
    const result = [];
    for (const [id, room] of rooms) {
        result.push({
            id,
            wordLength: room.wordLength,
            playerCount: room.players.size,
            createdAt: room.createdAt
        });
    }
    return result;
}

/**
 * 标记玩家为断线状态（不立即移除，等待重连）
 * @param {string} roomId
 * @param {string} socketId
 * @param {function} onTimeout - 超时后的回调
 * @returns {{ ok: boolean, nickname?: string }}
 */
function disconnectPlayer(roomId, socketId, onTimeout) {
    const room = rooms.get(roomId);
    if (!room) return { ok: false };

    const player = room.players.get(socketId);
    if (!player) return { ok: false };

    const nickname = player.nickname;

    // 标记为断线
    player.disconnected = true;

    // 设置超时清理
    const timer = setTimeout(() => {
        disconnectedPlayers.delete(socketId);
        // 超时：正式移除
        const r = rooms.get(roomId);
        if (r && r.players.has(socketId)) {
            r.players.delete(socketId);
            r.history.delete(socketId);
            if (r.players.size === 0) {
                rooms.delete(roomId);
            } else if (r.hostId === socketId) {
                // 转移房主到第一个非断线玩家
                for (const [sid, p] of r.players) {
                    if (!p.disconnected) {
                        r.hostId = sid;
                        break;
                    }
                }
            }
        }
        if (onTimeout) onTimeout(roomId, socketId, nickname);
    }, DISCONNECT_TIMEOUT);

    disconnectedPlayers.set(socketId, { roomId, nickname, timer });
    return { ok: true, nickname };
}

/**
 * 尝试重连到房间
 * @param {string} roomId
 * @param {string} newSocketId  新的 socket.id
 * @param {string} nickname     昵称（用于匹配）
 * @returns {{ ok: boolean, room?: object, oldSocketId?: string, error?: string }}
 */
function rejoinRoom(roomId, newSocketId, nickname) {
    const room = rooms.get(roomId);
    if (!room) return { ok: false, error: '房间不存在' };

    // 查找断线的同名玩家
    let oldSocketId = null;
    for (const [sid, player] of room.players) {
        if (player.nickname === nickname && player.disconnected) {
            oldSocketId = sid;
            break;
        }
    }

    if (!oldSocketId) {
        return { ok: false, error: '未找到断线的玩家，请重新加入' };
    }

    // 取消超时定时器
    const dcInfo = disconnectedPlayers.get(oldSocketId);
    if (dcInfo) {
        clearTimeout(dcInfo.timer);
        disconnectedPlayers.delete(oldSocketId);
    }

    // 迁移数据到新 socketId
    const playerData = room.players.get(oldSocketId);
    playerData.disconnected = false;
    room.players.delete(oldSocketId);
    room.players.set(newSocketId, playerData);

    const histData = room.history.get(oldSocketId);
    room.history.delete(oldSocketId);
    room.history.set(newSocketId, histData || []);

    if (room.hostId === oldSocketId) {
        room.hostId = newSocketId;
    }

    return { ok: true, room, oldSocketId };
}

module.exports = {
    createRoom,
    joinRoom,
    leaveRoom,
    getRoom,
    findRoomBySocket,
    recordGuess,
    serializeRoom,
    listRooms,
    disconnectPlayer,
    rejoinRoom
};
