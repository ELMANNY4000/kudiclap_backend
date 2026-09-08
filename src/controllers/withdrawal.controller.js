const bcrypt = require("bcrypt");
const CreatorModel = require("../models/creator.model");
const WalletModel = require("../models/wallet.model");
const CommissionModel = require("../models/commission.model");
const TransactionModel = require("../models/transaction.model");

const withdrawAmount = async (req, res) => {
  try {
    const userId = req.user.id;
    const { pin, amount } = req.body;

    if (!pin || !amount) {
      return res.status(400).json({ error: "Please fill all fields" });
    }

    const user = await CreatorModel.findById(userId);
    if (!user) return res.status(404).json({ error: "Creator not found" });
    if (!user.pin) return res.status(400).json({ error: "User PIN not set" });

    const validPin = await bcrypt.compare(pin.toString(), user.pin);
    if (!validPin) return res.status(400).json({ error: "Invalid PIN" });

    const comm = await CommissionModel.findOne({ transactionType: "withdraw" });
    const withdrawalCommission = comm ? comm.amount : 0;

    const wallet = await WalletModel.findOne({ userId: user._id });
    if (!wallet) return res.status(404).json({ error: "Wallet not found" });

    const amountInNumber = Number(amount);
    const totalAmount = amountInNumber + withdrawalCommission;

    if (wallet.balance < totalAmount) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    wallet.balance -= totalAmount;
    await wallet.save();

    await TransactionModel.create({
      userId: user._id,
      walletId: wallet._id,
      type: "withdrawal",
      amount: amountInNumber,
      commissionFee: withdrawalCommission,
      netAmount: amountInNumber,
      status: "success",
      reference: `WTH-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      description: "Direct bank withdrawal",
    });

    return res.status(200).json({
      message: "Withdrawal successful",
      remainingBalance: wallet.balance,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

module.exports = { withdrawAmount };