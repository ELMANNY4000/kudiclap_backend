const express = require("express");
const {
  depositAmount,
  initiateFlutterwavePayment,
  verifyFlutterwavePayment,
} = require("../controllers/payment.controller");
const authenticate = require("../middlewares/auth");

const paymentRouter = express.Router();

paymentRouter.post("/webhook", verifyFlutterwavePayment);
paymentRouter.post("/deposit", authenticate, depositAmount);
paymentRouter.post("/initiate", authenticate, initiateFlutterwavePayment);

module.exports = paymentRouter;