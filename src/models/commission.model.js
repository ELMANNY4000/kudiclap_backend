const mongoose = require("mongoose");

const commissionSchema = new mongoose.Schema(
  {
    transactionType: {
      type: String,
      enum: ["withdraw", "deposit", "payment"],
      required: true,
      unique: true,
    },
    amount: { type: Number, required: true, default: 0 },
    percentage: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    description: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Commission", commissionSchema);