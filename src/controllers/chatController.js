const chatService = require('../services/chatService');
const chatTools = require('../services/chatTools');

// Bộ nhớ chống thực thi trùng (replay) actionId trong vòng 15 phút (T2.16)
const executedActions = new Map();
const ACTION_TTL_MS = 15 * 60 * 1000;

const pruneExpiredActions = (now = Date.now()) => {
    for (const [key, timestamp] of executedActions.entries()) {
        if (now - timestamp > ACTION_TTL_MS) {
            executedActions.delete(key);
        }
    }
};

exports.chat = async (req, res) => {
    try {
        // Dữ liệu tra cứu luôn lấy theo req.user (từ JWT), không theo bất kỳ id nào client gửi
        // Chuẩn hóa: service có thể trả string thuần hoặc object {reply, pendingAction}
        const result = await chatService.chat(req.user, req.body?.messages, { toolsForUser: chatTools.toolsForUser });
        res.status(200).json(typeof result === 'string' ? { reply: result } : result);
    } catch (err) {
        if (err.statusCode) {
            return res.status(err.statusCode).json({ message: err.message });
        }
        console.error('[chatController] Lỗi không xác định:', err.message);
        res.status(500).json({ message: 'Có lỗi xảy ra, vui lòng thử lại sau.' });
    }
};

/**
 * Thực thi tool sau khi người dùng đã bấm Xác nhận trên widget.
 * Quyền + tham số được kiểm tra lại từ đầu trong chatTools.executeTool.
 */
exports.execute = async (req, res) => {
    try {
        const { tool, params, actionId } = req.body || {};
        if (!tool) {
            return res.status(400).json({ message: 'Thiếu tên hành động' });
        }

        const now = Date.now();
        pruneExpiredActions(now);
        const dedupKey = actionId ? `${req.user?.id ?? 'anon'}:${String(actionId)}` : null;
        if (dedupKey && executedActions.has(dedupKey)) {
            return res.status(409).json({ message: 'Thao tác này đã được thực hiện trước đó.' });
        }

        const result = await chatTools.executeTool(req.user, tool, params || {});
        if (dedupKey) {
            executedActions.set(dedupKey, Date.now());
        }
        res.status(200).json(result);
    } catch (err) {
        if (err.statusCode) {
            return res.status(err.statusCode).json({ message: err.message });
        }
        console.error('[chatController] Lỗi execute:', err.message);
        res.status(500).json({ message: 'Có lỗi xảy ra, vui lòng thử lại sau.' });
    }
};
