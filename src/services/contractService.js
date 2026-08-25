const Contract = require('../models/Contract');
const Room = require('../models/Room');
const Building = require('../models/Building');
const User = require('../models/User');
const MeterReading = require('../models/MeterReading');
const { createError } = require('../utils/errors');

// 1. TẠO HỢP ĐỒNG (Chủ nhà khởi tạo & ký số)
exports.createContract = async (landlordId, data) => {
    const { 
        tenantId, roomId, startDate, endDate, deposit,
        electricityPrice, waterPrice, internetPrice, cleaningPrice,
        initialElectricity, initialWater,
        landlordName, landlordPhone, landlordCccd, landlordDob, landlordHometown, landlordAddress,
        landlordSignature,
        tenantCccd, tenantDob, tenantHometown, tenantPhone,
        numTenants, paymentDay, inventory
    } = data;

    if (!tenantId || !roomId || !startDate || !endDate || !electricityPrice || !waterPrice) {
        throw createError(400, 'Vui lòng cung cấp đầy đủ thông tin hợp đồng');
    }

    if (initialElectricity === undefined || initialWater === undefined) {
        throw createError(400, 'Vui lòng cung cấp chỉ số điện nước bắt đầu cho phòng trọ');
    }

    if (!landlordSignature) {
        throw createError(400, 'Vui lòng thực hiện ký số đại diện Bên A (Chủ nhà) trước khi khởi tạo hợp đồng');
    }

    // Xác nhận xem phòng có thuộc sở hữu của landlord hay không
    const room = await Room.findByPk(roomId, {
        include: [{ model: Building, as: 'building' }]
    });

    if (!room || room.building.landlordId !== landlordId) {
        throw createError(404, 'Phòng trọ không tồn tại hoặc bạn không có quyền gán hợp đồng');
    }

    if (room.status === 'occupied') {
        throw createError(400, 'Phòng này đang có khách thuê, vui lòng thanh lý hợp đồng cũ trước.');
    }

    // Kiểm tra xem khách thuê này đã có hợp đồng nào đang hoạt động hoặc đang chờ ký không
    const existingContract = await Contract.findOne({
        where: { 
            tenantId, 
            status: ['active', 'pending_tenant_signature']
        }
    });

    if (existingContract) {
        if (existingContract.status === 'active') {
            throw createError(400, 'Khách thuê này đang có một hợp đồng hoạt động ở phòng khác. Vui lòng thanh lý trước khi tạo mới.');
        } else {
            throw createError(400, 'Khách thuê này đang có một hợp đồng chờ ký nhận. Vui lòng xử lý hợp đồng cũ trước khi tạo mới.');
        }
    }

    // Tạo hợp đồng ở trạng thái CHỜ KHÁCH KÝ
    const contract = await Contract.create({
        tenantId,
        roomId,
        startDate,
        endDate,
        deposit: deposit || 0,
        electricityPrice,
        waterPrice,
        internetPrice: internetPrice || 0,
        cleaningPrice: cleaningPrice || 0,
        initialElectricity: initialElectricity || 0,
        initialWater: initialWater || 0,
        landlordName,
        landlordPhone,
        landlordCccd,
        landlordDob,
        landlordHometown,
        landlordAddress,
        landlordSignature,
        landlordSignedAt: new Date(),
        tenantCccd,
        tenantDob,
        tenantHometown,
        tenantPhone,
        numTenants: numTenants || 1,
        paymentDay: paymentDay || 30,
        inventory: inventory ? (typeof inventory === 'string' ? inventory : JSON.stringify(inventory)) : null,
        status: 'pending_tenant_signature'
    });

    // Giữ chỗ cho phòng trọ (reserved)
    room.status = 'reserved';
    await room.save();

    return contract;
};

// 2. KÍ HỢP ĐỒNG (Dành cho Người thuê)
exports.signContractByTenant = async (tenantId, contractId, tenantSignature) => {
    if (!tenantSignature) {
        throw createError(400, 'Vui lòng cung cấp chữ ký điện tử để hoàn tất ký hợp đồng');
    }

    const contract = await Contract.findOne({
        where: { id: contractId, tenantId, status: 'pending_tenant_signature' },
        include: [{ model: Room, as: 'room' }]
    });

    if (!contract) {
        throw createError(404, 'Không tìm thấy hợp đồng chờ ký phù hợp.');
    }

    contract.tenantSignature = tenantSignature;
    contract.tenantSignedAt = new Date();
    contract.status = 'active';
    await contract.save();

    // Tạo chỉ số điện nước bắt đầu (isInitial: true)
    await MeterReading.bulkCreate([
        {
            roomId: contract.roomId,
            type: 'electricity',
            readingValue: contract.initialElectricity || 0,
            isInitial: true,
            readingDate: contract.startDate
        },
        {
            roomId: contract.roomId,
            type: 'water',
            readingValue: contract.initialWater || 0,
            isInitial: true,
            readingDate: contract.startDate
        }
    ]);

    // Cập nhật trạng thái phòng thành occupied
    if (contract.room) {
        contract.room.status = 'occupied';
        await contract.room.save();
    }

    return contract;
};

// 3. TỪ CHỐI KÍ HỢP ĐỒNG (Dành cho Người thuê)
exports.rejectContractByTenant = async (tenantId, contractId, reason) => {
    const contract = await Contract.findOne({
        where: { id: contractId, tenantId, status: 'pending_tenant_signature' },
        include: [{ model: Room, as: 'room' }]
    });

    if (!contract) {
        throw createError(404, 'Không tìm thấy hợp đồng chờ ký phù hợp.');
    }

    contract.status = 'rejected';
    contract.rejectionReason = reason || 'Người thuê từ chối ký hợp đồng.';
    await contract.save();

    // Reset trạng thái phòng về empty
    if (contract.room) {
        contract.room.status = 'empty';
        await contract.room.save();
    }

    return contract;
};

// 4. HỦY HỢP ĐỒNG CHỜ (Dành cho Chủ nhà)
exports.cancelContractByLandlord = async (landlordId, id) => {
    const contract = await Contract.findByPk(id, {
        include: [{ model: Room, as: 'room', include: [{ model: Building, as: 'building' }] }]
    });

    if (!contract || contract.room.building.landlordId !== landlordId) {
        throw createError(404, 'Hợp đồng không tồn tại hoặc bạn không có quyền thao tác');
    }

    if (contract.status !== 'pending_tenant_signature') {
        throw createError(400, 'Chỉ có thể hủy hợp đồng đang ở trạng thái Chờ khách ký');
    }

    contract.status = 'cancelled';
    await contract.save();

    if (contract.room) {
        contract.room.status = 'empty';
        await contract.room.save();
    }

    return { message: 'Đã hủy hợp đồng chờ thành công. Phòng trọ đã giải phóng về Trạng thái Trống.', contract };
};

// 5. LẤY DANH SÁCH HỢP ĐỒNG (Dành cho Chủ nhà)
exports.getContracts = async (landlordId) => {
    const contracts = await Contract.findAll({
        include: [
            {
                model: Room,
                as: 'room',
                required: true,
                include: [
                    {
                        model: Building,
                        as: 'building',
                        where: { landlordId }
                    }
                ]
            },
            {
                model: User,
                as: 'tenant',
                attributes: ['id', 'name', 'phone', 'email']
            }
        ],
        order: [['createdAt', 'DESC']]
    });
    return contracts;
};

// 6. CHI TIẾT HỢP ĐỒNG
exports.getContractDetail = async (landlordId, id) => {
    const contract = await Contract.findByPk(id, {
        include: [
            {
                model: Room,
                as: 'room',
                include: [
                    {
                        model: Building,
                        as: 'building'
                    }
                ]
            },
            {
                model: User,
                as: 'tenant',
                attributes: ['id', 'name', 'phone', 'email']
            }
        ]
    });

    if (!contract || contract.room.building.landlordId !== landlordId) {
        throw createError(404, 'Hợp đồng không tồn tại hoặc bạn không có quyền xem');
    }

    return contract;
};

// 7. THANH LÝ HỢP ĐỒNG
exports.terminateContract = async (landlordId, id) => {
    const contract = await Contract.findByPk(id, {
        include: [{ model: Room, as: 'room', include: [{ model: Building, as: 'building' }] }]
    });

    if (!contract || contract.room.building.landlordId !== landlordId) {
        throw createError(404, 'Hợp đồng không tồn tại hoặc bạn không có quyền thanh lý');
    }

    if (contract.status !== 'active') {
        throw createError(400, 'Hợp đồng này đã kết thúc hoặc chưa được kích hoạt');
    }

    // Cập nhật trạng thái hợp đồng thành terminated
    contract.status = 'terminated';
    await contract.save();

    // Reset trạng thái phòng trọ về trống (empty)
    const room = contract.room;
    if (room) {
        room.status = 'empty';
        await room.save();
    }

    return {
        message: 'Thanh lý hợp đồng thành công và phòng trọ đã chuyển sang trạng thái Trống.',
        contract
    };
};
