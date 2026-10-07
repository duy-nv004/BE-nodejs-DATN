const aiService = require('../services/aiService');
const { consumeAILimit } = require('../middleware/checkLimit');

exports.readMeter = async (req, res) => {
    try {
        const result = await aiService.readMeterFromImage(req.file);
        // Chỉ trừ lượt sau khi AI đã đọc được số. Upload lỗi hoặc AI trả 422
        // sẽ ném lỗi ở dòng trên và không tiêu tốn hạn mức của người dùng.
        await consumeAILimit(req.user.id);
        res.status(200).json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

exports.scanCccd = async (req, res) => {
    try {
        const files = req.files || (req.file ? [req.file] : []);
        const result = await aiService.readCccdFromImage(files);
        await consumeAILimit(req.user.id);
        res.status(200).json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};