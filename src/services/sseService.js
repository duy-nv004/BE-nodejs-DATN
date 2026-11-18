/**
 * Dịch vụ Server-Sent Events (SSE) để truyền tin thời gian thực đến client
 * Tích hợp Redis Pub/Sub để hỗ trợ Scale-out nhiều container/pod.
 */
const { getRedisClient, getSubscriberClient } = require('../config/redis');

const clients = new Map(); // userId -> Set of res objects
const CHANNEL = 'sse:events';
const instanceId = `${process.pid}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

// Đăng ký nhận tin nhắn từ các node/pod khác qua kết nối Redis Subscriber riêng biệt
const subClient = typeof getSubscriberClient === 'function' ? getSubscriberClient() : getRedisClient();
if (subClient && typeof subClient.subscribe === 'function') {
    try {
        if (typeof subClient.on === 'function') {
            subClient.on('message', (channel, message) => {
                if (channel !== CHANNEL) return;
                try {
                    const parsed = typeof message === 'string' ? JSON.parse(message) : message;
                    if (!parsed || parsed.senderId === instanceId) return;

                    if (parsed.type === 'user' && parsed.userId) {
                        dispatchToLocalUser(parsed.userId, parsed.event, parsed.data);
                    } else if (parsed.type === 'broadcast') {
                        dispatchLocalBroadcast(parsed.event, parsed.data);
                    }
                } catch {
                    // Bỏ qua tin nhắn không đúng định dạng
                }
            });
            subClient.subscribe(CHANNEL);
        } else {
            subClient.subscribe(CHANNEL, (message) => {
                try {
                    const parsed = typeof message === 'string' ? JSON.parse(message) : message;
                    if (!parsed || parsed.senderId === instanceId) return;

                    if (parsed.type === 'user' && parsed.userId) {
                        dispatchToLocalUser(parsed.userId, parsed.event, parsed.data);
                    } else if (parsed.type === 'broadcast') {
                        dispatchLocalBroadcast(parsed.event, parsed.data);
                    }
                } catch {
                    // Bỏ qua tin nhắn không đúng định dạng
                }
            });
        }
    } catch {
        // Fallback im lặng nếu subscription không khả dụng
    }
}

const dispatchToLocalUser = (userId, event, data) => {
    const id = Number(userId);
    const userClients = clients.get(id);
    if (!userClients || userClients.size === 0) return false;

    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    userClients.forEach((res) => {
        try {
            res.write(payload);
        } catch (e) {
            userClients.delete(res);
        }
    });
    return true;
};

const dispatchLocalBroadcast = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [, set] of clients) {
        set.forEach((res) => {
            try {
                res.write(payload);
            } catch (e) {
                set.delete(res);
            }
        });
    }
};

exports.addClient = (userId, req, res) => {
    const id = Number(userId);
    if (!clients.has(id)) {
        clients.set(id, new Set());
    }
    clients.get(id).add(res);

    if (typeof res.writeHead === 'function') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
    }
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    res.write(`event: connected\ndata: ${JSON.stringify({ message: "SSE connected", userId: id })}\n\n`);

    const interval = setInterval(() => {
        try {
            res.write(`: ping\n\n`);
        } catch (e) {
            clearInterval(interval);
        }
    }, 30000);
    if (interval.unref) interval.unref();

    const cleanup = () => {
        clearInterval(interval);
        const set = clients.get(id);
        if (set) {
            set.delete(res);
            if (set.size === 0) clients.delete(id);
        }
    };

    if (req && typeof req.on === 'function') {
        req.on('close', cleanup);
        req.on('end', cleanup);
    }
};

exports.sendToUser = (userId, event, data) => {
    // 1. Phục vụ ngay trên instance hiện tại
    const dispatchedLocally = dispatchToLocalUser(userId, event, data);

    // 2. Publish qua Redis cho các instance khác (nếu có)
    try {
        const client = getRedisClient();
        if (client && typeof client.publish === 'function') {
            client.publish(CHANNEL, JSON.stringify({ senderId: instanceId, type: 'user', userId, event, data }));
        }
    } catch {
        // Fallback an toàn nếu publish gặp sự cố
    }

    return dispatchedLocally;
};

exports.broadcast = (event, data) => {
    dispatchLocalBroadcast(event, data);

    try {
        const client = getRedisClient();
        if (client && typeof client.publish === 'function') {
            client.publish(CHANNEL, JSON.stringify({ senderId: instanceId, type: 'broadcast', event, data }));
        }
    } catch {
        // Fallback an toàn
    }
};
