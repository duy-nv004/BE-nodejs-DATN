const Contract = require('../models/Contract');
const Room = require('../models/Room');
const Building = require('../models/Building');
const User = require('../models/User');
const Invoice = require('../models/Invoice');
const SupportRequest = require('../models/SupportRequest');
const { createError } = require('../utils/errors');

exports.getDashboardSummary = async (userId) => {
    // Tìm hợp đồng active của người thuê này
    const contract = await Contract.findOne({
        where: { tenantId: userId, status: 'active' },
        include: [
            {
                model: Room,
                as: 'room',
                include: [
                    {
                        model: Building,
                        as: 'building',
                        include: [
                            {
                                model: User,
                                as: 'landlord',
                                attributes: ['name', 'phone', 'email']
                            }
                        ]
                    }
                ]
            }
        ]
    });

    const user = await User.findByPk(userId);
    if (!user) throw createError(404, "Không tìm thấy thông tin tài khoản.");

    const profile = {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        telegramChatId: user.telegramChatId
    };

    if (!contract) {
        return {
            hasActiveContract: false,
            profile,
            message: "Bạn hiện chưa được gán vào hợp đồng thuê phòng nào."
        };
    }

    const invoices = await Invoice.findAll({
        where: { roomId: contract.roomId },
        order: [['year', 'DESC'], ['month', 'DESC']]
    });

    const supportRequests = await SupportRequest.findAll({
        where: { tenantId: userId },
        order: [['createdAt', 'DESC']],
        limit: 5
    });

    return {
        hasActiveContract: true,
        profile,
        contract: {
            id: contract.id,
            startDate: contract.startDate,
            endDate: contract.endDate,
            deposit: contract.deposit,
            electricityPrice: contract.electricityPrice,
            waterPrice: contract.waterPrice,
            internetPrice: contract.internetPrice,
            cleaningPrice: contract.cleaningPrice,
        },
        room: {
            id: contract.room.id,
            roomNumber: contract.room.roomNumber,
            price: contract.room.price,
        },
        building: {
            id: contract.room.building.id,
            name: contract.room.building.name,
            address: contract.room.building.address,
        },
        landlord: contract.room.building.landlord,
        invoices,
        supportRequests
    };
};

exports.getInvoices = async (userId) => {
    const contract = await Contract.findOne({
        where: { tenantId: userId, status: 'active' }
    });

    if (!contract) {
        return [];
    }

    const invoices = await Invoice.findAll({
        where: { roomId: contract.roomId },
        order: [['year', 'DESC'], ['month', 'DESC']]
    });

    return invoices;
};
