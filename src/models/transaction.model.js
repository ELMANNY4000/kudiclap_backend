const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Creator", required: true },
    walletId: { type: mongoose.Schema.Types.ObjectId, ref: "Wallet", required: true },
    type: {
      type: String,
      enum: ["deposit", "withdrawal", "commission_deduction", "refund"],
      required: true,
    },
    amount: { type: Number, required: true },
    commissionFee: { type: Number, default: 0 },
    netAmount: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "success", "failed"],
      default: "pending",
    },
    reference: { type: String, required: true, unique: true },
    description: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Transaction", transactionSchema);