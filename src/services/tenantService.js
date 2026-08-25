const Contract = require('../models/Contract');
const Room = require('../models/Room');
const Building = require('../models/Building');
const User = require('../models/User');
const Invoice = require('../models/Invoice');
const SupportRequest = require('../models/SupportRequest');
const { createError } = require('../utils/errors');

exports.getDashboardSummary = async (userId) => {
    // 1. Tìm hợp đồng active của người thuê này
    let contract = await Contract.findOne({
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

    // 2. Nếu không có hợp đồng active, tìm hợp đồng chờ ký (pending_tenant_signature)
    let hasPendingContract = false;
    let pendingContractData = null;

    if (!contract) {
        const pendingContract = await Contract.findOne({
            where: { tenantId: userId, status: 'pending_tenant_signature' },
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

        if (pendingContract) {
            hasPendingContract = true;
            contract = pendingContract;
        }
    }

    if (!contract) {
        return {
            hasActiveContract: false,
            hasPendingContract: false,
            profile,
            message: "Bạn hiện chưa được gán vào hợp đồng thuê phòng nào."
        };
    }

    const invoices = contract.status === 'active' ? await Invoice.findAll({
        where: { roomId: contract.roomId },
        order: [['year', 'DESC'], ['month', 'DESC']]
    }) : [];

    const supportRequests = await SupportRequest.findAll({
        where: { tenantId: userId },
        order: [['createdAt', 'DESC']],
        limit: 5
    });

    return {
        hasActiveContract: contract.status === 'active',
        hasPendingContract: contract.status === 'pending_tenant_signature',
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
            initialElectricity: contract.initialElectricity,
            initialWater: contract.initialWater,
            landlordName: contract.landlordName,
            landlordPhone: contract.landlordPhone,
            landlordCccd: contract.landlordCccd,
            landlordDob: contract.landlordDob,
            landlordHometown: contract.landlordHometown,
            landlordAddress: contract.landlordAddress,
            landlordSignature: contract.landlordSignature,
            landlordSignedAt: contract.landlordSignedAt,
            tenantSignature: contract.tenantSignature,
            tenantSignedAt: contract.tenantSignedAt,
            tenantCccd: contract.tenantCccd,
            tenantDob: contract.tenantDob,
            tenantHometown: contract.tenantHometown,
            tenantPhone: contract.tenantPhone,
            numTenants: contract.numTenants,
            paymentDay: contract.paymentDay,
            inventory: contract.inventory,
            status: contract.status
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
