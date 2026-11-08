/**
 * Dịch vụ Server-Sent Events (SSE) để truyền tin thời gian thực đến client
 */
const clients = new Map(); // userId -> Set of res objects

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

exports.broadcast = (event, data) => {
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

