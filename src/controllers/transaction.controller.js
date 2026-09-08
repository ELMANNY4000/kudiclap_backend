const TransactionModel = require("../models/transaction.model");
const CreatorModel = require("../models/creator.model");

const getTransactions = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await CreatorModel.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "Creator not found" });
    }

    const transactions = await TransactionModel.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(50);

    return res.status(200).json(transactions);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

const getTransactionById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const transaction = await TransactionModel.findOne({ _id: id, userId });
    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    return res.status(200).json(transaction);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

module.exports = { getTransactions, getTransactionById };