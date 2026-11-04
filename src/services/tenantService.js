const Contract = require('../models/Contract');
const Room = require('../models/Room');
const Building = require('../models/Building');
const User = require('../models/User');
const Invoice = require('../models/Invoice');
const SupportRequest = require('../models/SupportRequest');
const DepositRecord = require('../models/DepositRecord');
const { createError } = require('../utils/errors');

// T2.8: Tìm các hợp đồng của khách thuê (gồm cả hợp đồng đã thanh lý 'terminated')
const findTenantContracts = async (userId) => Contract.findAll({
    where: { tenantId: userId, status: ['active', 'pending_tenant_signature', 'renewed', 'terminated'] },
    order: [['id', 'ASC']],
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
exports.findTenantContracts = findTenantContracts;

// Một khách thuê có thể thuê nhiều phòng -> nhiều hợp đồng. `contractId` (tùy chọn) chọn hợp đồng
// muốn xem; mặc định ưu tiên hợp đồng đang hiệu lực, sau đó tới hợp đồng chờ ký, rồi hợp đồng đã thanh lý.
exports.getDashboardSummary = async (userId, contractId = null) => {
    const contracts = await findTenantContracts(userId);

    const user = await User.findByPk(userId);
    if (!user) throw createError(404, "Không tìm thấy thông tin tài khoản.");

    const profile = {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        telegramChatId: user.telegramChatId
    };

    const current = contracts.filter(c => c.status !== 'renewed');
    const pendingContractIds = current.filter(c => c.status === 'pending_tenant_signature').map(c => c.id);

    const contract = (contractId && current.find(c => c.id === Number(contractId)))
        || current.find(c => c.status === 'active')
        || current.find(c => c.status === 'pending_tenant_signature')
        || current.find(c => c.status === 'terminated')
        || current[0];

    if (!contract) {
        return {
            hasActiveContract: false,
            hasPendingContract: false,
            pendingContractIds: [],
            contracts: [],
            profile,
            message: "Bạn hiện chưa được gán vào hợp đồng thuê phòng nào."
        };
    }

    // Lọc theo hợp đồng, không theo phòng: nếu lọc theo roomId thì khách thuê mới
    // vào phòng sẽ nhìn thấy toàn bộ công nợ của khách thuê trước đó. Gồm cả các hợp đồng
    // đã gia hạn của chính khách này trên cùng phòng để không ẩn hóa đơn cũ chưa trả.
    const invoiceContractIds = contracts
        .filter(c => c.roomId === contract.roomId && c.status !== 'pending_tenant_signature')
        .map(c => c.id);
    const invoices = ['active', 'terminated'].includes(contract.status) ? await Invoice.findAll({
        where: { contractId: invoiceContractIds },
        order: [['year', 'DESC'], ['month', 'DESC']]
    }) : [];

    const supportRequests = await SupportRequest.findAll({
        where: { tenantId: userId },
        order: [['createdAt', 'DESC']],
        limit: 5
    });

    return {
        hasActiveContract: contract.status === 'active',
        // Còn hợp đồng chờ ký (hợp đồng mới hoặc bản gia hạn) ở bất kỳ phòng nào
        hasPendingContract: pendingContractIds.length > 0,
        pendingContractIds,
        // Danh sách để khách chọn phòng / lịch sử hợp đồng muốn xem
        contracts: current.map(c => ({
            id: c.id,
            status: c.status,
            roomId: c.roomId,
            roomNumber: c.room?.roomNumber,
            buildingName: c.room?.building?.name,
            startDate: c.startDate,
            endDate: c.endDate,
            terminatedAt: c.terminatedAt ?? null,
        })),
        profile,
        contract: {
            id: contract.id,
            startDate: contract.startDate,
            endDate: contract.endDate,
            deposit: contract.deposit,
            rentPrice: contract.rentPrice,
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
            status: contract.status,
            terminatedAt: contract.terminatedAt ?? null,
            finalElectricity: contract.finalElectricity ?? null,
            finalWater: contract.finalWater ?? null,
            terminationNote: contract.terminationNote ?? null,
            outstandingAmount: Number(contract.outstandingAmount || 0),
            // Lịch sử tiền cọc để khách xem hoàn cọc (C5 / T2.8)
            deposits: await DepositRecord.findAll({
                where: { contractId: contract.id },
                attributes: ['amount', 'status', 'refundedAmount', 'deductedAmount', 'note', 'refundedAt']
            })
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

// Hóa đơn của mọi hợp đồng của khách (nhiều phòng, gồm cả hợp đồng đã gia hạn/kết thúc)
exports.getInvoices = async (userId) => {
    const contracts = await Contract.findAll({
        where: { tenantId: userId },
        attributes: ['id']
    });

    if (contracts.length === 0) {
        return [];
    }

    const invoices = await Invoice.findAll({
        where: { contractId: contracts.map(c => c.id) },
        // Kèm số phòng để khách thuê nhiều phòng lọc hóa đơn theo phòng
        include: [{ model: Room, as: 'roomDetails', attributes: ['id', 'roomNumber'] }],
        order: [['year', 'DESC'], ['month', 'DESC']]
    });

    return invoices;
};
