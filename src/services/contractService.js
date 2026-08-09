const Contract = require('../models/Contract');
const Room = require('../models/Room');
const Building = require('../models/Building');
const User = require('../models/User');
const MeterReading = require('../models/MeterReading');
const { createError } = require('../utils/errors');

// 1. TẠO HỢP ĐỒNG
exports.createContract = async (landlordId, data) => {
    const { 
        tenantId, roomId, startDate, endDate, deposit,
        electricityPrice, waterPrice, internetPrice, cleaningPrice,
        initialElectricity, initialWater,
        landlordName, landlordPhone, landlordCccd, landlordDob, landlordHometown, landlordAddress,
        tenantCccd, tenantDob, tenantHometown, tenantPhone,
        numTenants, paymentDay, inventory
    } = data;

    if (!tenantId || !roomId || !startDate || !endDate || !electricityPrice || !waterPrice) {
        throw createError(400, 'Vui lòng cung cấp đầy đủ thông tin hợp đồng');
    }

    if (initialElectricity === undefined || initialWater === undefined) {
        throw createError(400, 'Vui lòng cung cấp chỉ số điện nước bắt đầu cho phòng trọ');
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

    // Kiểm tra xem khách thuê này đã có hợp đồng nào đang hoạt động chưa
    const activeContract = await Contract.findOne({
        where: { tenantId, status: 'active' }
    });

    if (activeContract) {
        throw createError(400, 'Khách thuê này đang có một hợp đồng hoạt động ở phòng khác. Vui lòng thanh lý trước khi tạo mới.');
    }

    // Tạo hợp đồng
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
        landlordName,
        landlordPhone,
        landlordCccd,
        landlordDob,
        landlordHometown,
        landlordAddress,
        tenantCccd,
        tenantDob,
        tenantHometown,
        tenantPhone,
        numTenants: numTenants || 1,
        paymentDay: paymentDay || 30,
        inventory: inventory ? (typeof inventory === 'string' ? inventory : JSON.stringify(inventory)) : null,
        status: 'active'
    });

    // Tạo chỉ số điện nước bắt đầu (isInitial: true)
    await MeterReading.bulkCreate([
        {
            roomId,
            type: 'electricity',
            readingValue: initialElectricity,
            isInitial: true,
            readingDate: startDate
        },
        {
            roomId,
            type: 'water',
            readingValue: initialWater,
            isInitial: true,
            readingDate: startDate
        }
    ]);

    // Cập nhật trạng thái phòng thành occupied
    room.status = 'occupied';
    await room.save();

    return contract;
};

// 2. LẤY DANH SÁCH HỢP ĐỒNG
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

// 3. CHI TIẾT HỢP ĐỒNG
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

// 4. THANH LÝ HỢP ĐỒNG
exports.terminateContract = async (landlordId, id) => {
    const contract = await Contract.findByPk(id, {
        include: [{ model: Room, as: 'room', include: [{ model: Building, as: 'building' }] }]
    });

    if (!contract || contract.room.building.landlordId !== landlordId) {
        throw createError(404, 'Hợp đồng không tồn tại hoặc bạn không có quyền thanh lý');
    }

    if (contract.status !== 'active') {
        throw createError(400, 'Hợp đồng này đã kết thúc hoặc được thanh lý trước đó');
    }

    // Cập nhật trạng thái hợp đồng thành terminated
    contract.status = 'terminated';
    await contract.save();

    // Reset trạng thái phòng trọ về trống (empty)
    const room = contract.room;
    room.status = 'empty';
    await room.save();

    return {
        message: 'Thanh lý hợp đồng thành công và phòng trọ đã chuyển sang trạng thái Trống.',
        contract
    };
};
