const mongoose = require("mongoose");

const otpSchema = new mongoose.Schema(
  {
    email: { type: String, required: true },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Creator", default: null
    },
    otpCode: { type: String, required: true },
    purpose: {
      type: String,
      enum: ["forgot_password", "reset_pin", "withdrawal_verification"],
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 3600},
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Otp", otpSchema);