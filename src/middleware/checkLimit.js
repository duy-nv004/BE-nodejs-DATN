const Room = require('../models/Room');
const Building = require('../models/Building');

const checkRoomLimit = async (req, res, next) => {
    const { buildingId } = req.body;
    const user = req.user; // Lấy từ protect middleware

    if (user.plan === 'free') {
        const roomCount = await Room.count({ where: { buildingId } });
        if (roomCount >= 5) {
            return res.status(403).json({ 
                message: 'Gói Free chỉ cho phép tối đa 5 phòng mỗi tòa nhà. Vui lòng nâng cấp!' 
            });
        }
    }
    next();
};

module.exports = { checkRoomLimit };