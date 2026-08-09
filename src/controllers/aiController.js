const aiService = require('../services/aiService');

exports.readMeter = async (req, res) => {
    try {
        const result = await aiService.readMeterFromImage(req.file);
        res.status(200).json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};

exports.scanCccd = async (req, res) => {
    try {
        const result = await aiService.readCccdFromImage(req.file);
        res.status(200).json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ message: err.message });
    }
};