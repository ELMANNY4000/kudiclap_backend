const bcrypt = require("bcrypt");
const CreatorModel = require("../models/creator.model");
const WalletModel = require("../models/wallet.model");
const TransactionModel = require("../models/transaction.model");
const CommissionModel = require("../models/commission.model");

const initiateUssdWithdrawal = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount, pin } = req.body;

    if (!amount || !pin) {
      return res.status(400).json({ error: "Amount and PIN required" });
    }

    const user = await CreatorModel.findById(userId);
      if (!user) return res.status(404).json
          ({ error: "Creator not found" });
      if (!user.pin) return res.status(400).json
          ({ error: "User PIN not set" });

    const validPin = await bcrypt.compare(pin.toString(), user.pin);
      if (!validPin) return res.status(400).json
          ({ error: "Invalid PIN" });

    const wallet = await WalletModel.findOne({ userId: user._id });
      if (!wallet) return res.status(404).json
          ({ error: "Wallet not found" });

    const comm = await CommissionModel.findOne({ transactionType: "withdraw" });
    const withdrawalCommission = comm ? comm.amount : 0;

    const amountInNumber = Number(amount);
    const totalAmount = amountInNumber + withdrawalCommission;

    if (wallet.balance < totalAmount) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    const ussdRef = `USSD-${Date.now()}-${user._id.toString().slice(-4)}`;

    await TransactionModel.create({
      userId: user._id,
      walletId: wallet._id,
      type: "withdrawal",
      amount: amountInNumber,
      commissionFee: withdrawalCommission,
      netAmount: amountInNumber,
      status: "pending",
      reference: ussdRef,
      description: "USSD withdrawal initiated",
    });

    return res.status(200).json({
      message: "USSD prompt initiated successfully",
      reference: ussdRef,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

const verifyUssdTransaction = async (req, res) => {
  try {
    const userId = req.user.id;
    const { reference, confirmationCode } = req.body;

    if (!reference || !confirmationCode) {
      return res.status(400).json({ error: "Reference and confirmation code required" });
    }

    const user = await CreatorModel.findById(userId);
    if (!user) return res.status(404).json({ error: "Creator not found" });

    const pendingTransaction = await TransactionModel.findOne({
      reference,
      userId: user._id,
      status: "pending",
    });

    if (!pendingTransaction) {
      return res.status(404).json({ error: "Pending transaction not found" });
    }

    const wallet = await WalletModel.findOne({ userId: user._id });
    if (!wallet) return res.status(404).json({ error: "Wallet not found" });

    const totalDeduction = pendingTransaction.amount + pendingTransaction.commissionFee;
    if (wallet.balance < totalDeduction) {
      return res.status(400).json({ error: "Insufficient wallet balance" });
    }

    wallet.balance -= totalDeduction;
    await wallet.save();

    pendingTransaction.status = "success";
    pendingTransaction.description = "USSD withdrawal completed";
    await pendingTransaction.save();

    return res.status(200).json({ message: "USSD withdrawal successful", balance: wallet.balance });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

const cancelUssdTransaction = async (req, res) => {
  try {
    const userId = req.user.id;
    const { reference } = req.body;

    if (!reference) return res.status(400).json({ error: "Reference required" });

    const pendingTransaction = await TransactionModel.findOne({
      reference,
      userId,
      status: "pending",
    });

    if (!pendingTransaction) {
      return res.status(404).json({ error: "Pending transaction not found" });
    }

    pendingTransaction.status = "failed";
    pendingTransaction.description = "USSD withdrawal cancelled by user";
    await pendingTransaction.save();

    return res.status(200).json({ message: "USSD transaction cancelled successfully" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

module.exports = {
  initiateUssdWithdrawal,
  verifyUssdTransaction,
  cancelUssdTransaction,
};