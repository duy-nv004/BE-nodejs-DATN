const notificationService = require('../services/notificationService');

exports.getNotifications = async (req, res) => {
    try {
        const notifications = await notificationService.getNotifications(req.user.id);
        res.json(notifications);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

exports.markAsRead = async (req, res) => {
    try {
        const { id } = req.params;
        const notification = await notificationService.markAsRead(req.user.id, id);
        if (!notification) {
            return res.status(404).json({ message: "Không tìm thấy thông báo" });
        }
        res.json({ message: "Đã đánh dấu đã đọc", notification });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

exports.markAllAsRead = async (req, res) => {
    try {
        const result = await notificationService.markAllAsRead(req.user.id);
        res.json(result);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};
