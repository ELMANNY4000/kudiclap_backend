const express = require("express");
const {
  getTransactions,
  getTransactionById,
} = require("../controllers/transaction.controller");
const authenticate = require("../middlewares/auth");

const transactionRouter = express.Router();

transactionRouter.get("/", authenticate, getTransactions);
transactionRouter.get("/:id", authenticate, getTransactionById);

module.exports = transactionRouter;