const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Creator", required: true },
    txRef: { type: String, required: true, unique: true },
    flwRef: { type: String, default: "" },
    amount: { type: Number, required: true },
    currency: { type: String, default: "NGN" },
    status: {
      type: String,
      enum: ["pending", "successful", "failed", "cancelled"],
      default: "pending",
    },
    paymentMethod: {
      type: String,
      enum: ["card", "ussd", "mobile_money", "bank_transfer"],
      default: "card",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);