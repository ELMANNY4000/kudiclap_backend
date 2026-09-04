const mongoose = require("mongoose");

const walletSchema = new mongoose.Schema(
  {
    accountNumber: { type: String, required: true },
    accountName: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Creator", required: true },
    balance: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Wallet", walletSchema);