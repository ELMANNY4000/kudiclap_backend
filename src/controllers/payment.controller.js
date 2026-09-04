const CreatorModel = require("../models/creator.model");
const WalletModel = require("../models/wallet.model");
const TransactionModel = require("../models/transaction.model");
const PaymentModel = require("../models/payment.model");
const Flutterwave = require("flutterwave-node-v3");

const flw = new Flutterwave(
  process.env.FLW_PUBLIC_KEY || " ",
  process.env.FLW_SECRET_KEY || " "
);

const depositAmount = async (req, res) => {
  try {
    const userId = req.user.id;
    const { amount } = req.body;

    const user = await CreatorModel.findById(userId);
    if (!user) return res.status(404).json({ error: "Creator not found" });

    const wallet = await WalletModel.findOne({ userId: user._id });
    if (!wallet) return res.status(404).json({ error: "Wallet not found" });

    const amountInNumber = Number(amount);
    if (amountInNumber < 50) {
      return res.status(400).json({ error: "Amount must be at least 50" });
    }

    wallet.balance += amountInNumber;
    await wallet.save();

    await TransactionModel.create({
      userId: user._id,
      walletId: wallet._id,
      type: "deposit",
      amount: amountInNumber,
      commissionFee: 0,
      netAmount: amountInNumber,
      status: "success",
      reference: `DEP-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      description: "Direct wallet deposit",
    });

    return res.status(200).json({ message: "Wallet updated successfully", balance: wallet.balance });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

const initiateFlutterwavePayment = async (req, res) => {
  const userId = req.user.id;
  const { amount, email, phone_number } = req.body;

  if (!amount || !email) {
    return res.status(400).json({ error: "Amount and email are required" });
  }

  try {
    const tx_ref = "TX-" + Date.now();
    const payload = {
      tx_ref,
      amount: Number(amount),
      currency: "NGN",
      redirect_url: "https://kudiclap.com/api/payments/verify",
      customer: {
        email,
        phone_number: phone_number || "0000000000",
        name: req.user.name || "Creator",
      },
    };

    await PaymentModel.create({
      userId,
      txRef: tx_ref,
      amount: Number(amount),
      currency: "NGN",
      status: "pending",
    });

    const response = await flw.Charge.charge(payload);
    return res.status(200).json(response);
  } catch (error) {
    return res.status(500).json({ error: "Error initiating payment", details: error.message });
  }
};

const verifyFlutterwavePayment = async (req, res) => {
  try {
    const secretHash = process.env.FLW_SECRET_HASH;
    const signature = req.headers["verif-hash"];

    if (!signature || signature !== secretHash) {
      return res.status(401).end();
    }

    const payload = req.body;
    if (payload.status === "successful") {
      const payment = await PaymentModel.findOne({ txRef: payload.txRef });
      if (payment && payment.status !== "successful") {
        payment.status = "successful";
        payment.flwRef = payload.flwRef;
        await payment.save();

        const wallet = await WalletModel.findOne({ userId: payment.userId });
        if (wallet) {
          wallet.balance += payment.amount;
          await wallet.save();

          await TransactionModel.create({
            userId: payment.userId,
            walletId: wallet._id,
            type: "deposit",
            amount: payment.amount,
            commissionFee: 0,
            netAmount: payment.amount,
            status: "success",
            reference: payment.txRef,
            description: "Flutterwave tip credit",
          });
        }
      }
    }
    return res.status(200).end();
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

module.exports = { depositAmount, initiateFlutterwavePayment, verifyFlutterwavePayment };