const db = require('../models');

exports.createQuickPayment = async (req, res) => {
    try {
        // currentReading là con số cuối cùng chủ nhà đã xác nhận (có thể lấy từ AI hoặc nhập tay)
        const { roomId, currentReading, meterType } = req.body; 

        // 1. Tìm phòng để lấy chỉ số cũ và đơn giá
        const room = await db.Room.findByPk(roomId);
        if (!room) return res.status(404).json({ message: "Không tìm thấy phòng" });

        const lastReading = meterType === 'electricity' ? room.last_elect_reading : room.last_water_reading;
        const unitPrice = meterType === 'electricity' ? room.elect_price : room.water_price;

        // 2. Tính toán tiền tiêu thụ
        const consumption = currentReading - lastReading;
        if (consumption < 0) return res.status(400).json({ message: "Số mới không được nhỏ hơn số cũ!" });
        
        const totalAmount = consumption * unitPrice;

        // 3. Tạo Link VietQR (VietQR.io API)
        const bankId = process.env.BANK_ID;
        const accountNo = process.env.BANK_ACCOUNT;
        const accountName = encodeURIComponent(process.env.BANK_NAME);
        const description = encodeURIComponent(`Thanh toan tien ${meterType === 'electricity' ? 'dien' : 'nuoc'} phong ${room.room_number}`);

        // Trả về link ảnh QR có sẵn số tiền
        const qrCodeUrl = `https://img.vietqr.io/image/${bankId}-${accountNo}-compact2.png?amount=${totalAmount}&addInfo=${description}&accountName=${accountName}`;

        res.status(200).json({
            message: "Đã tạo mã thanh toán thành công",
            paymentInfo: {
                meterType,
                consumption,
                unitPrice,
                totalAmount,
                qrCodeUrl // Giao diện chỉ cần hiển thị ảnh từ link này
            }
        });

    } catch (err) {
        res.status(500).json({ message: "Lỗi tạo thanh toán: " + err.message });
    }
};