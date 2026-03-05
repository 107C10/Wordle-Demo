/**
 * Redis Room Store — 可选的 Redis 持久化存储
 *
 * 当环境变量 REDIS_URL 设置时自动启用。
 * 与 roomManager.js 兼容的接口，用于跨进程持久化房间数据。
 *
 * 使用方式:
 *   npm install ioredis
 *   REDIS_URL=redis://localhost:6379 npm start
 */

let Redis;
try {
    Redis = require('ioredis');
} catch (e) {
    // ioredis 未安装，此模块不可用
    Redis = null;
}

const REDIS_PREFIX = 'wordle:room:';
const ROOM_TTL     = 3600; // 房间 1 小时过期

class RedisRoomStore {
    constructor(redisUrl) {
        if (!Redis) {
            throw new Error('ioredis 未安装。请运行 npm install ioredis');
        }
        this.client = new Redis(redisUrl);
        this.client.on('connect', () => console.log('[Redis] 已连接'));
        this.client.on('error', (err) => console.error('[Redis] 错误:', err.message));
    }

    _key(roomId) {
        return REDIS_PREFIX + roomId;
    }

    /**
     * 保存房间到 Redis
     * @param {object} room - 房间对象（与 roomManager 中的一致）
     */
    async saveRoom(room) {
        const data = {
            id: room.id,
            wordLength: room.wordLength,
            answer: room.answer,
            hostId: room.hostId,
            createdAt: room.createdAt,
            players: Object.fromEntries(
                Array.from(room.players.entries()).map(([sid, p]) => [sid, {
                    nickname: p.nickname,
                    currentRow: p.currentRow,
                    currentCol: p.currentCol,
                    candidateRow: p.candidateRow,
                    gameOver: p.gameOver,
                    won: p.won,
                    disconnected: p.disconnected || false
                }])
            ),
            history: Object.fromEntries(
                Array.from(room.history.entries())
            )
        };
        await this.client.setex(this._key(room.id), ROOM_TTL, JSON.stringify(data));
    }

    /**
     * 从 Redis 读取房间
     * @param {string} roomId
     * @returns {object|null} 反序列化的房间对象（players/history 为普通对象）
     */
    async loadRoom(roomId) {
        const raw = await this.client.get(this._key(roomId));
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    /**
     * 删除房间
     * @param {string} roomId
     */
    async deleteRoom(roomId) {
        await this.client.del(this._key(roomId));
    }

    /**
     * 刷新房间 TTL
     * @param {string} roomId
     */
    async refreshTTL(roomId) {
        await this.client.expire(this._key(roomId), ROOM_TTL);
    }

    /**
     * 将 Redis 加载的房间数据转换为 roomManager 兼容的 Map 格式
     * @param {object} data - loadRoom 返回的数据
     * @returns {object} 包含 Map 类型的 players 和 history 的房间对象
     */
    static toRoomObject(data) {
        if (!data) return null;
        return {
            id: data.id,
            wordLength: data.wordLength,
            answer: data.answer,
            hostId: data.hostId,
            createdAt: data.createdAt,
            players: new Map(Object.entries(data.players || {})),
            history: new Map(Object.entries(data.history || {}))
        };
    }

    /**
     * 关闭连接
     */
    async close() {
        await this.client.quit();
    }
}

/**
 * 创建 Redis 存储实例（如果环境变量 REDIS_URL 存在）
 * @returns {RedisRoomStore|null}
 */
function createRedisStore() {
    const url = process.env.REDIS_URL;
    if (!url) {
        console.log('[Redis] REDIS_URL 未设置，使用内存存储');
        return null;
    }
    if (!Redis) {
        console.warn('[Redis] ioredis 未安装，使用内存存储。运行 npm install ioredis 启用 Redis。');
        return null;
    }
    try {
        return new RedisRoomStore(url);
    } catch (e) {
        console.error('[Redis] 初始化失败:', e.message);
        return null;
    }
}

module.exports = {
    RedisRoomStore,
    createRedisStore
};
