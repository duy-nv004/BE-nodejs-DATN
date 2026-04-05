const Building = require('../models/Building');
const Room = require('../models/Room');

// Tạo tòa nhà
exports.createBuilding = async (req, res) => {
    try {
        const building = await Building.create({
            ...req.body,
            landlordId: req.user.id
        });
        res.status(201).json(building);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
};

// Tạo phòng (Có áp dụng checkLimit ở Route)
exports.createRoom = async (req, res) => {
    try {
        const room = await Room.create(req.body);
        res.status(201).json(room);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
};