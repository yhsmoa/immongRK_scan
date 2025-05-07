const mongoose = require('mongoose');

const chinaImportSchema = new mongoose.Schema({
    shipmentCode: {
        type: String,
        required: true
    },
    pallet: {
        type: String,
        required: true
    },
    boxName: {
        type: String,
        required: true
    },
    orderNumber: {
        type: String
    },
    productName: {
        type: String,
        required: true
    },
    quantity: {
        type: String,
        required: true
    },
    barcode: {
        type: String,
        index: true
    },
    availableOrders: {
        type: String
    },
    shippingDate: {
        type: String
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

chinaImportSchema.index({ shipmentCode: 1, barcode: 1 });

module.exports = mongoose.model('ChinaImport', chinaImportSchema); 