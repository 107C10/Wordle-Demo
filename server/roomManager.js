/**
 * Room Manager — 内存房间管理
 *
 * 支持两种模式:
 * - versus: 对抗模式，各自猜词，任一方完成则全局结束
 * - coop:   合作模式，共享棋盘，共用6次机会
 *
 * 房间角色:
 * - 房主 (host): 创建房间，可以开始游戏
 * - 选手 (players): 最多 MAX_SEATS 人，参与游戏
 * - 观众 (spectators): 无上限，只能观战
 */

const rooms = new Map();
const disconnectedPlayers = new Map();
const DISCONNECT_TIMEOUT = 60000;
const MAX_SEATS = 4;

/** 生成 4 位数字房间码 */
function generateRoomId() {
    let id;
    do {
        id = String(Math.floor(1000 + Math.random() * 9000));
    } while (rooms.has(id));
    return id;
}

function createPlayerData(nickname) {
    return {
        nickname,
        currentRow: 0,
        currentCol: 0,
        candidateRow: [],
        gameOver: false,
        won: false,
        disconnected: false
    };
}

// ─── 公开 API ─────────────────────────────────────

function createRoom(hostSocketId, nickname, wordLength, answer, mode) {
    if (![5, 6, 7].includes(wordLength)) {
        return { ok: false, error: '无效的单词长度' };
    }
    if (!answer || answer.length !== wordLength) {
        return { ok: false, error: '无效的目标单词' };
    }
    if (!['versus', 'coop'].includes(mode)) mode = 'versus';

    const id = generateRoomId();
    const room = {
        id,
        wordLength,
        answer: answer.toUpperCase(),
        mode,
        hostId: hostSocketId,
        gameStarted: false,
        players: new Map(),       // 选手席
        spectators: new Map(),    // 观众席
        history: new Map(),
        coopHistory: [],
        roundOver: false,
        roundAnswer: '',
        playAgainVotes: new Set(),
        createdAt: Date.now()
    };

    room.players.set(hostSocketId, createPlayerData(nickname));
    room.history.set(hostSocketId, []);

    rooms.set(id, room);
    return { ok: true, room };
}

function joinRoom(roomId, socketId, nickname) {
    const room = rooms.get(roomId);
    if (!room) return { ok: false, error: '房间不存在' };
    if (room.players.has(socketId) || room.spectators.has(socketId)) {
        return { ok: false, error: '你已在房间中' };
    }

    // 检查昵称重复
    for (const [, p] of room.players) {
        if (p.nickname === nickname) {
            return { ok: false, error: '昵称与房间内玩家重复，请更换昵称' };
        }
    }
    for (const [, s] of room.spectators) {
        if (s.nickname === nickname) {
            return { ok: false, error: '昵称与房间内玩家重复，请更换昵称' };
        }
    }

    // 游戏未开始 且 选手席未满 → 进入选手席；否则 → 观众席
    if (!room.gameStarted && room.players.size < MAX_SEATS) {
        room.players.set(socketId, createPlayerData(nickname));
        room.history.set(socketId, []);
        return { ok: true, room, role: 'player' };
    } else {
        room.spectators.set(socketId, { nickname, disconnected: false });
        return { ok: true, room, role: 'spectator' };
    }
}

/** 房主开始游戏 */
function startGame(roomId, socketId) {
    const room = rooms.get(roomId);
    if (!room) return { ok: false, error: '房间不存在' };
    if (room.hostId !== socketId) return { ok: false, error: '只有房主可以开始游戏' };
    if (room.gameStarted) return { ok: false, error: '游戏已经开始' };

    let activeSeats = 0;
    for (const [, p] of room.players) {
        if (!p.disconnected) activeSeats++;
    }
    if (activeSeats < 2) return { ok: false, error: '至少需要 2 名选手才能开始' };

    room.gameStarted = true;
    return { ok: true };
}

/** 观众加入选手席（仅在回合结束后、下一轮开始前可用） */
function joinSeat(roomId, socketId) {
    const room = rooms.get(roomId);
    if (!room) return { ok: false, error: '房间不存在' };
    if (!room.spectators.has(socketId)) return { ok: false, error: '你不是观众' };
    if (room.players.size >= MAX_SEATS) return { ok: false, error: '选手席已满' };
    if (room.gameStarted && !room.roundOver) return { ok: false, error: '游戏进行中，无法加入选手席' };

    const spec = room.spectators.get(socketId);
    room.spectators.delete(socketId);
    room.players.set(socketId, createPlayerData(spec.nickname));
    room.history.set(socketId, []);

    return { ok: true, nickname: spec.nickname };
}

/** 选手退回观众席（仅在回合结束后或未开始时可用） */
function leaveSeat(roomId, socketId) {
    const room = rooms.get(roomId);
    if (!room) return { ok: false, error: '房间不存在' };
    if (!room.players.has(socketId)) return { ok: false, error: '你不是选手' };
    if (room.gameStarted && !room.roundOver) return { ok: false, error: '游戏进行中，无法切换身份' };

    const player = room.players.get(socketId);
    room.players.delete(socketId);
    room.history.delete(socketId);
    room.playAgainVotes.delete(socketId);
    room.spectators.set(socketId, { nickname: player.nickname, disconnected: false });

    // 如果退出的是房主，转移房主
    if (room.hostId === socketId) {
        let newHostId = null;
        for (const [sid, p] of room.players) {
            if (!p.disconnected) { newHostId = sid; break; }
        }
        if (!newHostId) {
            for (const [sid, s] of room.spectators) {
                if (!s.disconnected) { newHostId = sid; break; }
            }
        }
        if (newHostId) room.hostId = newHostId;
    }

    return { ok: true, nickname: player.nickname };
}

function leaveRoom(roomId, socketId) {
    const room = rooms.get(roomId);
    if (!room) return { ok: false, isEmpty: true };

    const isPlayer = room.players.has(socketId);
    const isSpectator = room.spectators.has(socketId);

    if (isPlayer) {
        room.players.delete(socketId);
        room.history.delete(socketId);
        room.playAgainVotes.delete(socketId);
    } else if (isSpectator) {
        room.spectators.delete(socketId);
    }

    const totalPeople = room.players.size + room.spectators.size;
    if (totalPeople === 0) {
        rooms.delete(roomId);
        return { ok: true, isEmpty: true, wasPlayer: isPlayer };
    }

    // 转移房主
    let newHostId = room.hostId;
    if (room.hostId === socketId) {
        newHostId = null;
        for (const [sid, p] of room.players) {
            if (!p.disconnected) { newHostId = sid; break; }
        }
        if (!newHostId) {
            for (const [sid, s] of room.spectators) {
                if (!s.disconnected) { newHostId = sid; break; }
            }
        }
        if (newHostId) room.hostId = newHostId;
    }

    return { ok: true, isEmpty: false, newHostId: room.hostId, wasPlayer: isPlayer };
}

function getRoom(roomId) {
    return rooms.get(roomId) || null;
}

function findRoomBySocket(socketId) {
    for (const [roomId, room] of rooms) {
        if (room.players.has(socketId) || room.spectators.has(socketId)) return roomId;
    }
    return null;
}

function getRole(room, socketId) {
    if (room.players.has(socketId)) return 'player';
    if (room.spectators.has(socketId)) return 'spectator';
    return null;
}

/** 记录 versus 模式猜测 */
function recordGuess(roomId, socketId, guess, evaluation) {
    const room = rooms.get(roomId);
    if (!room) return { ok: false, error: '房间不存在' };
    if (!room.gameStarted) return { ok: false, error: '游戏尚未开始' };
    if (room.roundOver) return { ok: false, error: '本轮已结束' };

    const player = room.players.get(socketId);
    if (!player) return { ok: false, error: '你不是选手' };
    if (player.gameOver) return { ok: false, error: '你的游戏已结束' };

    const hist = room.history.get(socketId);
    hist.push({ guess, evaluation });
    player.currentRow = hist.length;
    player.currentCol = 0;
    player.candidateRow = [];

    const won = evaluation.every(e => e === 'correct');
    if (won) {
        player.gameOver = true;
        player.won = true;
    } else if (hist.length >= 6) {
        player.gameOver = true;
        player.won = false;
    }

    return { ok: true };
}

/** 记录 coop 模式猜测 */
function recordCoopGuess(roomId, socketId, guess, evaluation) {
    const room = rooms.get(roomId);
    if (!room) return { ok: false, error: '房间不存在' };
    if (!room.gameStarted) return { ok: false, error: '游戏尚未开始' };
    if (room.roundOver) return { ok: false, error: '本轮已结束' };

    const player = room.players.get(socketId);
    if (!player) return { ok: false, error: '你不是选手' };

    room.coopHistory.push({ guess, evaluation, nickname: player.nickname, socketId });

    const won = evaluation.every(e => e === 'correct');
    const usedAll = room.coopHistory.length >= 6;

    if (won || usedAll) {
        room.roundOver = true;
        room.roundAnswer = room.answer;
        for (const [, p] of room.players) {
            p.gameOver = true;
            p.won = won;
        }
    }

    return { ok: true, won, usedAll, roundOver: won || usedAll };
}

/** 检查 versus 模式是否全局结束 */
function checkVersusRoundOver(room) {
    if (room.roundOver) return true;

    let anyWon = false;
    let allDone = true;

    for (const [, player] of room.players) {
        if (player.disconnected) continue;
        if (player.won) anyWon = true;
        if (!player.gameOver) allDone = false;
    }

    if (anyWon || allDone) {
        room.roundOver = true;
        room.roundAnswer = room.answer;
        for (const [, player] of room.players) {
            if (!player.gameOver) {
                player.gameOver = true;
                player.won = false;
            }
        }
        return true;
    }
    return false;
}

/** 投票再来一局（仅选手可投票） */
function votePlayAgain(roomId, socketId) {
    const room = rooms.get(roomId);
    if (!room) return { ok: false, error: '房间不存在' };
    if (!room.roundOver) return { ok: false, error: '本轮尚未结束' };
    if (!room.players.has(socketId)) return { ok: false, error: '只有选手可以投票' };

    room.playAgainVotes.add(socketId);
    return getPlayAgainStatus(room);
}

/** 获取投票状态（排除断线选手） */
function getPlayAgainStatus(room) {
    // 清理断线/已离开选手的投票
    for (const sid of room.playAgainVotes) {
        const p = room.players.get(sid);
        if (!p || p.disconnected) {
            room.playAgainVotes.delete(sid);
        }
    }

    let activeCount = 0;
    for (const [, p] of room.players) {
        if (!p.disconnected) activeCount++;
    }

    const allAgreed = activeCount > 0 && room.playAgainVotes.size >= activeCount;
    return { ok: true, allAgreed, voteCount: room.playAgainVotes.size, totalNeeded: activeCount };
}

/** 重置房间开始新一轮 */
function resetRound(room, newAnswer) {
    room.answer = newAnswer.toUpperCase();
    room.roundOver = false;
    room.roundAnswer = '';
    room.playAgainVotes.clear();
    room.coopHistory = [];
    // gameStarted 保持 true

    for (const [sid, player] of room.players) {
        player.currentRow = 0;
        player.currentCol = 0;
        player.candidateRow = [];
        player.gameOver = false;
        player.won = false;
        room.history.set(sid, []);
    }
}

function serializeRoom(room) {
    const players = {};
    for (const [sid, p] of room.players) {
        players[sid] = {
            nickname: p.nickname,
            currentRow: p.currentRow,
            gameOver: p.gameOver,
            won: p.won,
            disconnected: !!p.disconnected
        };
    }
    const spectators = {};
    for (const [sid, s] of room.spectators) {
        spectators[sid] = {
            nickname: s.nickname,
            disconnected: !!s.disconnected
        };
    }
    const history = {};
    for (const [sid, h] of room.history) {
        history[sid] = h;
    }
    return {
        id: room.id,
        wordLength: room.wordLength,
        mode: room.mode,
        hostId: room.hostId,
        gameStarted: room.gameStarted,
        players,
        spectators,
        history,
        coopHistory: room.coopHistory,
        roundOver: room.roundOver,
        roundAnswer: room.roundAnswer,
        playAgainVotes: room.playAgainVotes.size
    };
}

function disconnectPlayer(roomId, socketId, onTimeout) {
    const room = rooms.get(roomId);
    if (!room) return { ok: false };

    const isPlayer = room.players.has(socketId);
    const isSpectator = room.spectators.has(socketId);
    if (!isPlayer && !isSpectator) return { ok: false };

    let nickname;
    if (isPlayer) {
        const player = room.players.get(socketId);
        nickname = player.nickname;
        player.disconnected = true;
    } else {
        const spec = room.spectators.get(socketId);
        nickname = spec.nickname;
        spec.disconnected = true;
    }

    const timer = setTimeout(() => {
        disconnectedPlayers.delete(socketId);
        const r = rooms.get(roomId);
        if (!r) return;

        if (r.players.has(socketId)) {
            r.players.delete(socketId);
            r.history.delete(socketId);
            r.playAgainVotes.delete(socketId);
        } else if (r.spectators.has(socketId)) {
            r.spectators.delete(socketId);
        }

        if (r.players.size + r.spectators.size === 0) {
            rooms.delete(roomId);
        } else if (r.hostId === socketId) {
            for (const [sid, p] of r.players) {
                if (!p.disconnected) { r.hostId = sid; break; }
            }
        }

        if (onTimeout) onTimeout(roomId, socketId, nickname);
    }, DISCONNECT_TIMEOUT);

    disconnectedPlayers.set(socketId, { roomId, nickname, timer, role: isPlayer ? 'player' : 'spectator' });
    return { ok: true, nickname, role: isPlayer ? 'player' : 'spectator' };
}

function rejoinRoom(roomId, newSocketId, nickname) {
    const room = rooms.get(roomId);
    if (!room) return { ok: false, error: '房间不存在' };

    let oldSocketId = null;
    let role = null;

    // 先在选手席中查找
    for (const [sid, player] of room.players) {
        if (player.nickname === nickname && player.disconnected) {
            oldSocketId = sid;
            role = 'player';
            break;
        }
    }

    // 再在观众席中查找
    if (!oldSocketId) {
        for (const [sid, spec] of room.spectators) {
            if (spec.nickname === nickname && spec.disconnected) {
                oldSocketId = sid;
                role = 'spectator';
                break;
            }
        }
    }

    if (!oldSocketId) return { ok: false, error: '未找到断线的玩家，请重新加入' };

    const dcInfo = disconnectedPlayers.get(oldSocketId);
    if (dcInfo) {
        clearTimeout(dcInfo.timer);
        disconnectedPlayers.delete(oldSocketId);
    }

    if (role === 'player') {
        const playerData = room.players.get(oldSocketId);
        playerData.disconnected = false;
        room.players.delete(oldSocketId);
        room.players.set(newSocketId, playerData);

        const histData = room.history.get(oldSocketId);
        room.history.delete(oldSocketId);
        room.history.set(newSocketId, histData || []);

        if (room.playAgainVotes.has(oldSocketId)) {
            room.playAgainVotes.delete(oldSocketId);
            room.playAgainVotes.add(newSocketId);
        }
    } else {
        const specData = room.spectators.get(oldSocketId);
        specData.disconnected = false;
        room.spectators.delete(oldSocketId);
        room.spectators.set(newSocketId, specData);
    }

    if (room.hostId === oldSocketId) room.hostId = newSocketId;

    return { ok: true, room, oldSocketId, role };
}

module.exports = {
    createRoom, joinRoom, leaveRoom, getRoom, findRoomBySocket, getRole,
    startGame, joinSeat, leaveSeat,
    recordGuess, recordCoopGuess, checkVersusRoundOver,
    votePlayAgain, resetRound, getPlayAgainStatus,
    serializeRoom, disconnectPlayer, rejoinRoom,
    MAX_SEATS
};
