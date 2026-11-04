const { createError } = require("../utils/errors");
const buildingService = require("./buildingService");
const meterService = require("./meterService");
const invoiceService = require("./invoiceService");
const contractService = require("./contractService");
const supportService = require("./supportService");

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
