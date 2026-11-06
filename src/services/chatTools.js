const { createError } = require("../utils/errors");
const buildingService = require("./buildingService");
const meterService = require("./meterService");
const invoiceService = require("./invoiceService");
const contractService = require("./contractService");
const supportService = require("./supportService");
const adminService = require("./adminService");
const tenantService = require("./tenantService");
const notificationService = require("./notificationService");

/**
 * Tool registry cho chatbot function calling.
 * Mỗi tool khai báo: vai trò được phép, spec (OpenAI function format), và hàm run.
 * Backend luôn kiểm tra lại quyền + tham số — không tin gì AI/client trả ra.
 * Toàn bộ service bên dưới đã tự kiểm tra quyền sở hữu dữ liệu theo landlordId/tenantId.
 */

// Helper: yêu cầu trường bắt buộc
const req = (params, fields) => {
    for (const f of fields) {
        const v = params?.[f];
        if (v === undefined || v === null || v === "") {
            throw createError(400, `Thiếu thông tin bắt buộc: ${f}`);
        }
    }
};

// Helper: tham số tùy chọn — chỉ truyền khi AI cung cấp
const opt = (params, fields) => {
    const out = {};
    for (const f of fields) {
        if (params?.[f] !== undefined && params?.[f] !== null && params?.[f] !== "") out[f] = params[f];
    }
    return out;
};

const PERIOD_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

const CHAT_TOOLS = {
    // ─── QUẢN LÝ PHÒNG & TÒA NHÀ (landlord) ───
    create_room: {
        allowedRoles: ["landlord"],
        spec: {
            type: "function",
            function: {
                name: "create_room",
                description: "Tạo một phòng trọ mới trong tòa nhà của chủ nhà. Chỉ dùng khi người dùng yêu cầu rõ ràng tạo/thêm phòng.",
                parameters: {
                    type: "object",
                    properties: {
                        buildingId: { type: "integer", description: "ID tòa nhà cần thêm phòng" },
                        roomNumber: { type: "string", description: "Số phòng, ví dụ: 101" },
                        price: { type: "number", description: "Giá thuê theo tháng (VND)" },
                        capacity: { type: "integer", description: "Sức chứa tối đa (người), mặc định 2" },
                        area: { type: "number", description: "Diện tích (m2), mặc định 20" }
                    },
                    required: ["buildingId", "roomNumber", "price"]
                }
            }
        },
        async run(user, params, { service = buildingService } = {}) {
            req(params, ["buildingId", "roomNumber", "price"]);
            const room = await service.createRoom(user.id, {
                buildingId: params.buildingId,
                roomNumber: params.roomNumber,
                price: params.price,
                ...opt(params, ["capacity", "area"])
            });
            return { room, message: `Đã tạo phòng ${room.roomNumber} thành công.` };
        }
    },

    update_room: {
        allowedRoles: ["landlord"],
        spec: {
            type: "function",
            function: {
                name: "update_room",
                description: "Cập nhật thông tin phòng: số phòng, giá thuê, sức chứa, diện tích, hoặc chuyển phòng sang trạng thái 'empty' (trống) / 'maintenance' (bảo trì).",
                parameters: {
                    type: "object",
                    properties: {
                        roomId: { type: "integer", description: "ID phòng cần cập nhật" },
                        roomNumber: { type: "string" },
                        price: { type: "number", description: "Giá thuê mới (VND/tháng)" },
                        capacity: { type: "integer" },
                        area: { type: "number" },
                        status: { type: "string", enum: ["empty", "maintenance"], description: "Chỉ nhận empty hoặc maintenance" }
                    },
                    required: ["roomId"]
                }
            }
        },
        async run(user, params, { service = buildingService } = {}) {
            req(params, ["roomId"]);
            const room = await service.updateRoom(user.id, params.roomId,
                opt(params, ["roomNumber", "price", "capacity", "area", "status"]));
            return { room, message: `Đã cập nhật phòng ${room.roomNumber} thành công.` };
        }
    },

    delete_room: {
        allowedRoles: ["landlord"],
        spec: {
            type: "function",
            function: {
                name: "delete_room",
                description: "Xóa vĩnh viễn một phòng trọ. Chỉ xóa được khi phòng không còn hợp đồng đang hoạt động. Yêu cầu xác nhận của người dùng trước khi gọi.",
                parameters: {
                    type: "object",
                    properties: { roomId: { type: "integer", description: "ID phòng cần xóa" } },
                    required: ["roomId"]
                }
            }
        },
        async run(user, params, { service = buildingService } = {}) {
            req(params, ["roomId"]);
            const result = await service.deleteRoom(user.id, params.roomId);
            return { message: result.message || "Đã xóa phòng thành công." };
        }
    },

    create_building: {
        allowedRoles: ["landlord"],
        spec: {
            type: "function",
            function: {
                name: "create_building",
                description: "Tạo tòa nhà mới cho chủ nhà.",
                parameters: {
                    type: "object",
                    properties: {
                        name: { type: "string", description: "Tên tòa nhà" },
                        address: { type: "string", description: "Địa chỉ tòa nhà" }
                    },
                    required: ["name", "address"]
                }
            }
        },
        async run(user, params, { service = buildingService } = {}) {
            req(params, ["name", "address"]);
            const building = await service.createBuilding(user.id, opt(params, ["name", "address"]));
            return { building, message: `Đã tạo tòa nhà ${building.name} thành công.` };
        }
    },

    delete_building: {
        allowedRoles: ["landlord"],
        spec: {
            type: "function",
            function: {
                name: "delete_building",
                description: "Xóa vĩnh viễn một tòa nhà. Chỉ xóa được khi tòa không còn phòng nào. Yêu cầu xác nhận của người dùng trước khi gọi.",
                parameters: {
                    type: "object",
                    properties: { buildingId: { type: "integer", description: "ID tòa nhà cần xóa" } },
                    required: ["buildingId"]
                }
            }
        },
        async run(user, params, { service = buildingService } = {}) {
            req(params, ["buildingId"]);
            const result = await service.deleteBuilding(user.id, params.buildingId);
            return { message: result.message || "Đã xóa tòa nhà thành công." };
        }
    },

    // ─── ĐIỆN NƯỚC & HÓA ĐƠN (landlord) ───
    update_meter_readings: {
        allowedRoles: ["landlord"],
        spec: {
            type: "function",
            function: {
                name: "update_meter_readings",
                description: "Chốt chỉ số điện và/hoặc nước của phòng cho một kỳ (mặc định kỳ hiện tại). Dùng khi chủ nhà ghi số đồng hồ.",
                parameters: {
                    type: "object",
                    properties: {
                        roomId: { type: "integer", description: "ID phòng" },
                        electricityValue: { type: "number", description: "Chỉ số điện (kWh)" },
                        waterValue: { type: "number", description: "Chỉ số nước (m3)" },
                        period: { type: "string", description: "Kỳ dạng YYYY-MM, bỏ trống = kỳ hiện tại" }
                    },
                    required: ["roomId"]
                }
            }
        },
        async run(user, params, { service = meterService } = {}) {
            req(params, ["roomId"]);
            const hasElec = params?.electricityValue !== undefined && params?.electricityValue !== null && params?.electricityValue !== "";
            const hasWater = params?.waterValue !== undefined && params?.waterValue !== null && params?.waterValue !== "";
            if (!hasElec && !hasWater) {
                throw createError(400, "Vui lòng cung cấp ít nhất chỉ số điện hoặc chỉ số nước");
            }
            if (params?.period !== undefined && params?.period !== null && params?.period !== "") {
                if (!PERIOD_REGEX.test(String(params.period))) {
                    throw createError(400, "Kỳ chốt số phải có định dạng YYYY-MM hợp lệ");
                }
            }
            await service.updateRoomReadings(user.id, {
                roomId: params.roomId,
                ...opt(params, ["electricityValue", "waterValue", "period"])
            });
            return { message: "Đã chốt chỉ số điện nước thành công." };
        }
    },

    generate_invoice: {
        allowedRoles: ["landlord"],
        spec: {
            type: "function",
            function: {
                name: "generate_invoice",
                description: "Xuất hóa đơn tháng cho một phòng (cần phòng có hợp đồng đang hoạt động và đã chốt số điện nước của kỳ đó).",
                parameters: {
                    type: "object",
                    properties: {
                        roomId: { type: "integer", description: "ID phòng" },
                        month: { type: "integer", description: "Tháng (1-12)" },
                        year: { type: "integer", description: "Năm, ví dụ 2026" }
                    },
                    required: ["roomId", "month", "year"]
                }
            }
        },
        async run(user, params, { service = invoiceService } = {}) {
            req(params, ["roomId", "month", "year"]);
            const { roomId, month, year } = params;
            if (!Number.isInteger(month) || month < 1 || month > 12) {
                throw createError(400, "Tháng phải là số nguyên từ 1 đến 12");
            }
            const invoice = await service.generateInvoice({ roomId, month, year }, user.id);
            return { invoice, message: `Đã xuất hóa đơn tháng ${month}/${year} thành công.` };
        }
    },

    update_invoice_payment: {
        allowedRoles: ["landlord"],
        spec: {
            type: "function",
            function: {
                name: "update_invoice_payment",
                description: "Đánh dấu hóa đơn đã thanh toán hoặc chưa thanh toán.",
                parameters: {
                    type: "object",
                    properties: {
                        invoiceId: { type: "integer", description: "ID hóa đơn" },
                        isPaid: { type: "boolean", description: "true = đã đóng, false = chưa đóng" }
                    },
                    required: ["invoiceId", "isPaid"]
                }
            }
        },
        async run(user, params, { service = invoiceService } = {}) {
            req(params, ["invoiceId", "isPaid"]);
            if (typeof params.isPaid !== "boolean") {
                throw createError(400, "isPaid phải là true hoặc false");
            }
            await service.updatePaymentStatus(params.invoiceId, { isPaid: params.isPaid }, user.id);
            return { message: params.isPaid ? "Đã đánh dấu hóa đơn là đã thanh toán." : "Đã đánh dấu hóa đơn là chưa thanh toán." };
        }
    },

    // ─── HỢP ĐỒNG (landlord) ───
    cancel_contract: {
        allowedRoles: ["landlord"],
        spec: {
            type: "function",
            function: {
                name: "cancel_contract",
                description: "Hủy hợp đồng đang chờ khách thuê ký (giải phóng phòng về trống). Không hủy được hợp đồng đã hoạt động.",
                parameters: {
                    type: "object",
                    properties: { contractId: { type: "integer", description: "ID hợp đồng cần hủy" } },
                    required: ["contractId"]
                }
            }
        },
        async run(user, params, { service = contractService } = {}) {
            req(params, ["contractId"]);
            const result = await service.cancelContractByLandlord(user.id, params.contractId);
            return { message: result.message || "Đã hủy hợp đồng chờ thành công." };
        }
    },

    terminate_contract: {
        allowedRoles: ["landlord"],
        spec: {
            type: "function",
            function: {
                name: "terminate_contract",
                description: "Thanh lý hợp đồng đang hoạt động (kết thúc hợp đồng, giải phóng phòng). Yêu cầu xác nhận của người dùng trước khi gọi. Nếu tháng thanh lý chưa có hóa đơn, phải hỏi chủ nhà chỉ số điện và nước cuối rồi truyền finalElectricity/finalWater.",
                parameters: {
                    type: "object",
                    properties: {
                        contractId: { type: "integer", description: "ID hợp đồng cần thanh lý" },
                        finalElectricity: { type: "number", description: "Chỉ số điện cuối (đọc trên đồng hồ khi khách trả phòng)" },
                        finalWater: { type: "number", description: "Chỉ số nước cuối (đọc trên đồng hồ khi khách trả phòng)" },
                        terminationDate: { type: "string", description: "Ngày trả phòng YYYY-MM-DD, mặc định hôm nay" },
                        damageAmount: { type: "number", description: "Tiền hư hỏng trừ vào cọc (VND), mặc định 0" },
                        forfeitDeposit: { type: "boolean", description: "true = khách mất cọc (trả phòng không báo trước)" },
                        note: { type: "string", description: "Ghi chú thanh lý" }
                    },
                    required: ["contractId"]
                }
            }
        },
        async run(user, params, { service = contractService } = {}) {
            req(params, ["contractId"]);
            const body = opt(params, ["finalElectricity", "finalWater", "terminationDate", "damageAmount", "note"]);
            if (params.forfeitDeposit !== undefined && params.forfeitDeposit !== null) body.forfeit = !!params.forfeitDeposit;
            try {
                const result = await service.terminateContract(user.id, params.contractId, body);
                return { message: result.message || "Đã thanh lý hợp đồng thành công." };
            } catch (err) {
                // Thiếu chỉ số cuối không phải lỗi: hỏi lại chủ nhà để lần sau thanh lý được ngay
                if (err.code === "FINAL_READINGS_REQUIRED") {
                    return {
                        needsFinalReadings: true,
                        missing: ["finalElectricity", "finalWater"],
                        message: "Tháng thanh lý chưa có hóa đơn nên cần chỉ số cuối. Vui lòng cho tôi biết chỉ số điện và chỉ số nước cuối cùng trên đồng hồ khi khách trả phòng, tôi sẽ thanh lý và tính tiền hoàn cọc ngay."
                    };
                }
                throw err;
            }
        }
    },

    // ─── SỰ CỐ (landlord cập nhật / tenant tạo) ───
    update_support_status: {
        allowedRoles: ["landlord"],
        spec: {
            type: "function",
            function: {
                name: "update_support_status",
                description: "Cập nhật trạng thái yêu cầu sửa chữa: pending (chờ), in_progress (đang xử lý), resolved (đã xong).",
                parameters: {
                    type: "object",
                    properties: {
                        requestId: { type: "integer", description: "ID yêu cầu sửa chữa" },
                        status: { type: "string", enum: ["pending", "in_progress", "resolved"] }
                    },
                    required: ["requestId", "status"]
                }
            }
        },
        async run(user, params, { service = supportService } = {}) {
            req(params, ["requestId", "status"]);
            if (!["pending", "in_progress", "resolved"].includes(params.status)) {
                throw createError(400, "Trạng thái không hợp lệ");
            }
            await service.updateRequestStatus(user.id, params.requestId, { status: params.status });
            return { message: "Đã cập nhật trạng thái yêu cầu sửa chữa." };
        }
    },

    create_support_request: {
        allowedRoles: ["tenant"],
        spec: {
            type: "function",
            function: {
                name: "create_support_request",
                description: "Gửi yêu cầu báo hỏng/sửa chữa cho phòng đang thuê (dành cho người thuê).",
                parameters: {
                    type: "object",
                    properties: {
                        description: { type: "string", description: "Mô tả chi tiết sự cố" },
                        severity: { type: "string", enum: ["low", "medium", "high"], description: "Mức độ khẩn cấp, mặc định medium" },
                        roomId: { type: "integer", description: "ID phòng gặp sự cố (khi khách thuê nhiều phòng), bỏ trống = phòng đầu tiên đang thuê" }
                    },
                    required: ["description"]
                }
            }
        },
        async run(user, params, { service = supportService } = {}) {
            req(params, ["description"]);
            const severity = ["low", "medium", "high"].includes(params.severity) ? params.severity : "medium";
            const result = await service.createTenantRequest(user.id, { description: params.description, severity, ...opt(params, ["roomId"]) });
            return { request: result.supportRequest, message: result.message || "Đã gửi báo sự cố." };
        }
    },

    // ─── TÁC VỤ CHO NGƯỜI THUÊ (tenant) ───
    request_move_out: {
        allowedRoles: ["tenant"],
        spec: {
            type: "function",
            function: {
                name: "request_move_out",
                description: "Gửi yêu cầu báo trả phòng cho hợp đồng đang thuê (dành cho người thuê).",
                parameters: {
                    type: "object",
                    properties: {
                        contractId: { type: "integer", description: "ID hợp đồng (tùy chọn nếu chỉ có 1 hợp đồng)" },
                        desiredDate: { type: "string", description: "Ngày mong muốn trả phòng (YYYY-MM-DD)" },
                        note: { type: "string", description: "Lý do hoặc ghi chú trả phòng" }
                    }
                }
            }
        },
        async run(user, params, { contractService: service = contractService } = {}) {
            let contractId = params?.contractId;
            if (!contractId) {
                const Contract = require("../models/Contract");
                const active = await Contract.findOne({ where: { tenantId: user.id, status: "active" } });
                if (!active) throw createError(404, "Không tìm thấy hợp đồng đang hiệu lực của bạn");
                contractId = active.id;
            }
            const result = await service.createTenantRequest(user.id, contractId, {
                type: "move_out",
                ...opt(params, ["desiredDate", "note"])
            });
            return { message: result.message || "Đã gửi yêu cầu trả phòng tới chủ nhà.", request: result.request };
        }
    },

    request_renewal: {
        allowedRoles: ["tenant"],
        spec: {
            type: "function",
            function: {
                name: "request_renewal",
                description: "Gửi đề nghị gia hạn hợp đồng thuê phòng (dành cho người thuê).",
                parameters: {
                    type: "object",
                    properties: {
                        contractId: { type: "integer", description: "ID hợp đồng" },
                        desiredDate: { type: "string", description: "Ngày kết thúc mới mong muốn (YYYY-MM-DD)" },
                        note: { type: "string", description: "Ghi chú gia hạn" }
                    }
                }
            }
        },
        async run(user, params, { contractService: service = contractService } = {}) {
            let contractId = params?.contractId;
            if (!contractId) {
                const Contract = require("../models/Contract");
                const active = await Contract.findOne({ where: { tenantId: user.id, status: "active" } });
                if (!active) throw createError(404, "Không tìm thấy hợp đồng đang hiệu lực của bạn");
                contractId = active.id;
            }
            const result = await service.createTenantRequest(user.id, contractId, {
                type: "renewal",
                ...opt(params, ["desiredDate", "note"])
            });
            return { message: result.message || "Đã gửi đề nghị gia hạn hợp đồng tới chủ nhà.", request: result.request };
        }
    },

    get_invoice_payment_qr: {
        allowedRoles: ["tenant"],
        spec: {
            type: "function",
            function: {
                name: "get_invoice_payment_qr",
                description: "Tra cứu hóa đơn chưa thanh toán và lấy mã QR VietQR để thanh toán tiền phòng nhanh (dành cho người thuê).",
                parameters: {
                    type: "object",
                    properties: {
                        invoiceId: { type: "integer", description: "ID hóa đơn cụ thể (nếu có)" }
                    }
                }
            }
        },
        async run(user, params, { tenantService: service = tenantService } = {}) {
            const invoices = await service.getInvoices(user.id);
            const unpaid = (invoices || []).filter((i) => !i.isPaid);
            if (unpaid.length === 0) {
                return {
                    unpaidCount: 0,
                    message: "Tuyệt vời! Bạn hiện không có hóa đơn nào chưa thanh toán."
                };
            }
            const target = (params?.invoiceId && unpaid.find((i) => i.id === Number(params.invoiceId))) || unpaid[0];
            return {
                unpaidCount: unpaid.length,
                latestInvoice: {
                    id: target.id,
                    month: target.month,
                    year: target.year,
                    totalAmount: Number(target.totalAmount || 0),
                    qrCodeUrl: target.qrCodeUrl,
                    roomNumber: target.roomDetails?.roomNumber || "N/A"
                },
                message: `Hóa đơn tháng ${target.month}/${target.year} của bạn là ${Number(target.totalAmount || 0).toLocaleString("vi-VN")} VNĐ. Quét mã QR VietQR để thanh toán tự động.`
            };
        }
    },

    add_roommate: {
        allowedRoles: ["tenant"],
        spec: {
            type: "function",
            function: {
                name: "add_roommate",
                description: "Khai báo thêm người ở cùng phòng trong hợp đồng thuê để chủ nhà đăng ký tạm trú (dành cho người thuê).",
                parameters: {
                    type: "object",
                    properties: {
                        contractId: { type: "integer", description: "ID hợp đồng" },
                        fullName: { type: "string", description: "Họ và tên người ở cùng" },
                        phone: { type: "string", description: "Số điện thoại" },
                        relation: { type: "string", description: "Quan hệ (bạn bè, người thân, đồng nghiệp...)" },
                        note: { type: "string", description: "Ghi chú thêm" }
                    },
                    required: ["fullName"]
                }
            }
        },
        async run(user, params, { contractService: service = contractService } = {}) {
            req(params, ["fullName"]);
            let contractId = params?.contractId;
            if (!contractId) {
                const Contract = require("../models/Contract");
                const active = await Contract.findOne({ where: { tenantId: user.id, status: "active" } });
                if (!active) throw createError(404, "Không tìm thấy hợp đồng đang hiệu lực của bạn");
                contractId = active.id;
            }
            const result = await service.addOccupant(user, contractId, opt(params, ["fullName", "phone", "relation", "note"]));
            return { message: result.message || "Đã thêm người ở cùng thành công.", occupant: result.occupant };
        }
    },

    // ─── TÁC VỤ NÂNG CAO CHO CHỦ NHÀ (landlord) ───
    renew_contract_quick: {
        allowedRoles: ["landlord"],
        spec: {
            type: "function",
            function: {
                name: "renew_contract_quick",
                description: "Tạo hợp đồng gia hạn nối tiếp cho hợp đồng đang hoạt động (dành cho chủ nhà).",
                parameters: {
                    type: "object",
                    properties: {
                        contractId: { type: "integer", description: "ID hợp đồng hiện tại" },
                        startDate: { type: "string", description: "Ngày bắt đầu gia hạn (YYYY-MM-DD)" },
                        endDate: { type: "string", description: "Ngày kết thúc gia hạn (YYYY-MM-DD)" },
                        rentPrice: { type: "number", description: "Giá thuê mới (VND/tháng, bỏ trống = giữ giá cũ)" }
                    },
                    required: ["contractId", "startDate", "endDate"]
                }
            }
        },
        async run(user, params, { contractService: service = contractService } = {}) {
            req(params, ["contractId", "startDate", "endDate"]);
            const result = await service.renewContract(user.id, params.contractId, opt(params, ["startDate", "endDate", "rentPrice", "numTenants", "firstLastMonthPolicy"]));
            return { message: result.message || "Đã tạo hợp đồng gia hạn thành công. Chờ khách thuê ký xác nhận.", contract: result.contract };
        }
    },

    send_overdue_reminders: {
        allowedRoles: ["landlord"],
        spec: {
            type: "function",
            function: {
                name: "send_overdue_reminders",
                description: "Gửi thông báo nhắc nợ tới tất cả các phòng có hóa đơn chưa thanh toán hoặc quá hạn.",
                parameters: {
                    type: "object",
                    properties: {
                        buildingId: { type: "integer", description: "Lọc theo tòa nhà cụ thể (tùy chọn)" }
                    }
                }
            }
        },
        async run(user, params, { invoiceService: invSvc = invoiceService, notificationService: notiSvc = notificationService } = {}) {
            const invoices = await invSvc.listInvoices(user.id, { status: "unpaid", ...opt(params, ["buildingId"]) });
            const unpaid = (invoices || []).filter((i) => !i.isPaid && i.tenantId);
            if (unpaid.length === 0) {
                return { count: 0, message: "Không có hóa đơn nợ nào cần nhắc nhở." };
            }
            let sentCount = 0;
            const notifiedTenants = new Set();
            for (const inv of unpaid) {
                if (notifiedTenants.has(inv.tenantId)) continue;
                notifiedTenants.add(inv.tenantId);
                const roomNum = inv.roomDetails?.roomNumber || "phòng trọ";
                await notiSvc.createNotification(
                    inv.tenantId,
                    "Nhắc nhở thanh toán tiền phòng",
                    `Bạn có hóa đơn tháng ${inv.month}/${inv.year} của ${roomNum} chưa thanh toán (${Number(inv.totalAmount || 0).toLocaleString("vi-VN")} đ). Vui lòng thanh toán sớm.`,
                    "invoice",
                    inv.id
                );
                sentCount++;
            }
            return { count: sentCount, message: `Đã gửi thông báo nhắc nợ thành công tới ${sentCount} khách thuê.` };
        }
    },

    get_revenue_stats: {
        allowedRoles: ["landlord"],
        spec: {
            type: "function",
            function: {
                name: "get_revenue_stats",
                description: "Thống kê doanh thu dự kiến, tiền đã thu, tiền cấn trừ cọc, số tiền còn nợ và số phòng chưa đóng tiền theo tháng cụ thể hoặc theo cả năm (dành cho chủ nhà).",
                parameters: {
                    type: "object",
                    properties: {
                        year: {
                            type: "integer",
                            description: "Năm cần thống kê (ví dụ: 2026). Nếu bỏ trống sẽ lấy năm hiện tại."
                        },
                        month: {
                            type: "string",
                            description: "Tháng cần thống kê (từ '1' đến '12', hoặc 'all' để thống kê cả năm). Bỏ trống = 'all'."
                        }
                    }
                }
            }
        },
        async run(user, params, { invoiceService: invSvc = invoiceService } = {}) {
            const currentYear = new Date().getFullYear();
            const year = params?.year ? Number(params.year) : currentYear;
            const monthRaw = params?.month != null && String(params.month).trim() !== "" ? String(params.month).trim().toLowerCase() : "all";
            const month = monthRaw === "all" || monthRaw === "cả năm" ? "all" : String(Number(monthRaw) || monthRaw);

            const result = await invSvc.getRevenueStats(user.id, { month, year });
            const stats = result?.stats || {
                totalExpected: 0,
                totalCollected: 0,
                cashCollected: 0,
                depositOffset: 0,
                unpaidAmount: 0,
                unpaidRooms: 0,
                invoiceCount: 0
            };

            const periodLabel = month === "all" ? `Năm ${year}` : `Tháng ${month}/${year}`;
            const collectionRate = stats.totalExpected > 0
                ? `${Math.round((stats.totalCollected / stats.totalExpected) * 1000) / 10}%`
                : "100%";

            const formatVND = (v) => Number(v || 0).toLocaleString("vi-VN") + " VNĐ";

            return {
                period: periodLabel,
                stats: {
                    ...stats,
                    collectionRate,
                    totalExpectedFormatted: formatVND(stats.totalExpected),
                    totalCollectedFormatted: formatVND(stats.totalCollected),
                    cashCollectedFormatted: formatVND(stats.cashCollected),
                    depositOffsetFormatted: formatVND(stats.depositOffset),
                    unpaidAmountFormatted: formatVND(stats.unpaidAmount)
                },
                message: `Báo cáo doanh thu ${periodLabel}: Dự kiến ${formatVND(stats.totalExpected)}, thực thu ${formatVND(stats.totalCollected)} (${collectionRate}), còn nợ ${formatVND(stats.unpaidAmount)} (${stats.unpaidRooms} phòng chưa đóng).`
            };
        }
    },

    // ─── TÁC VỤ QUẢN TRỊ VIÊN (admin) ───
    get_platform_metrics: {
        allowedRoles: ["admin"],
        spec: {
            type: "function",
            function: {
                name: "get_platform_metrics",
                description: "Xem báo cáo tổng quan chỉ số nền tảng SaaS (doanh thu thực thu, MRR, tổng số chủ nhà, phân bố gói cước Free/Basic/Pro).",
                parameters: {
                    type: "object",
                    properties: {}
                }
            }
        },
        async run(user, params, { adminService: service = adminService } = {}) {
            const stats = await service.getSystemStats();
            return {
                stats,
                message: `Chỉ số nền tảng: Tổng số chủ nhà: ${stats.totalLandlords || 0}, Doanh thu thực thu: ${Number(stats.totalRevenue || 0).toLocaleString("vi-VN")} VNĐ, MRR: ${Number(stats.mrr || 0).toLocaleString("vi-VN")} VNĐ.`
            };
        }
    },

    query_failed_sepay: {
        allowedRoles: ["admin"],
        spec: {
            type: "function",
            function: {
                name: "query_failed_sepay",
                description: "Tra cứu các giao dịch SePay bị từ chối hoặc lỗi gần đây để rà soát sự cố.",
                parameters: {
                    type: "object",
                    properties: {
                        limit: { type: "integer", description: "Số lượng giao dịch cần lấy, mặc định 5" }
                    }
                }
            }
        },
        async run(user, params, { adminService: service = adminService } = {}) {
            const limit = params?.limit && Number.isInteger(Number(params.limit)) ? Number(params.limit) : 5;
            const events = await service.getSePayEvents({ status: "REJECTED", pageSize: limit });
            const list = events?.rows || [];
            return {
                count: events?.count || list.length,
                events: list.map((e) => ({ id: e.id, content: e.content, transferAmount: e.transferAmount, errorReason: e.errorReason })),
                message: list.length > 0 ? `Tìm thấy ${list.length} giao dịch SePay bị từ chối gần đây.` : "Không có giao dịch SePay bị lỗi nào."
            };
        }
    },

    resolve_landlord_ticket: {
        allowedRoles: ["admin"],
        spec: {
            type: "function",
            function: {
                name: "resolve_landlord_ticket",
                description: "Duyệt hoặc từ chối phiếu khiếu nại mở khóa tài khoản của chủ nhà.",
                parameters: {
                    type: "object",
                    properties: {
                        ticketId: { type: "integer", description: "ID phiếu khiếu nại" },
                        status: { type: "string", enum: ["resolved", "rejected"], description: "resolved (duyệt mở khóa) hoặc rejected (từ chối)" },
                        adminResponse: { type: "string", description: "Lý do hoặc phản hồi của Admin" },
                        resetPassword: { type: "boolean", description: "Có đặt lại mật khẩu ngẫu nhiên và gửi email không (mặc định false)" }
                    },
                    required: ["ticketId", "status"]
                }
            }
        },
        async run(user, params, { adminService: service = adminService } = {}) {
            req(params, ["ticketId", "status"]);
            if (!["resolved", "rejected"].includes(params.status)) {
                throw createError(400, "Trạng thái khiếu nại phải là resolved hoặc rejected");
            }
            const result = await service.resolveLandlordTicket(user.id, params.ticketId, opt(params, ["status", "adminResponse", "resetPassword"]));
            return { message: result.message || "Đã xử lý phiếu khiếu nại thành công." };
        }
    },

    update_landlord_status: {
        allowedRoles: ["admin"],
        spec: {
            type: "function",
            function: {
                name: "update_landlord_status",
                description: "Khóa hoặc mở khóa tài khoản chủ nhà vi phạm kèm lý do giải thích.",
                parameters: {
                    type: "object",
                    properties: {
                        landlordId: { type: "integer", description: "ID chủ nhà" },
                        status: { type: "string", enum: ["locked", "active"], description: "Trạng thái mới: locked (khóa) hoặc active (mở khóa)" },
                        lockReason: { type: "string", description: "Lý do khóa tài khoản (bắt buộc khi khóa, tối thiểu 5 ký tự)" }
                    },
                    required: ["landlordId", "status"]
                }
            }
        },
        async run(user, params, { adminService: service = adminService } = {}) {
            req(params, ["landlordId", "status"]);
            if (!["locked", "active"].includes(params.status)) {
                throw createError(400, "Trạng thái tài khoản phải là locked hoặc active");
            }
            const result = await service.updateLandlordStatus(user.id, params.landlordId, opt(params, ["status", "lockReason", "resetPassword"]));
            return { message: result.message || `Đã cập nhật trạng thái chủ nhà ID ${params.landlordId} thành công.` };
        }
    }
};

exports.CHAT_TOOLS = CHAT_TOOLS;

/** Danh sách spec để gửi cho AI (function calling). Lọc theo vai trò người dùng. */
exports.toolsForUser = (user) => {
    const role = user?.roleData?.name;
    return Object.values(CHAT_TOOLS)
        .filter((t) => t.allowedRoles.includes(role))
        .map((t) => t.spec);
};

/** Kiểm tra quyền + tham số. Ném createError(statusCode) nếu không hợp lệ. */
exports.validateToolCall = (name, params, user) => {
    const tool = CHAT_TOOLS[name];
    if (!tool) throw createError(400, "Hành động không được hỗ trợ");

    const role = user?.roleData?.name;
    if (!role || !tool.allowedRoles.includes(role)) {
        throw createError(403, "Bạn không có quyền thực hiện hành động này");
    }
};

/** Thực thi tool sau khi đã validate (service tự kiểm tra tham số & quyền sở hữu). */
exports.executeTool = async (user, name, params, deps = {}) => {
    exports.validateToolCall(name, params, user);
    return CHAT_TOOLS[name].run(user, params || {}, deps);
};
