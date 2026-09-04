const express = require("express");
const {
  initiateUssdWithdrawal,
  verifyUssdTransaction,
  cancelUssdTransaction,
} = require("../controllers/ussd.controller");
const authenticate = require("../middlewares/auth");

const ussdRouter = express.Router();

ussdRouter.post("/initiate", authenticate, initiateUssdWithdrawal);
ussdRouter.post("/verify", authenticate, verifyUssdTransaction);
ussdRouter.post("/cancel", authenticate, cancelUssdTransaction);

module.exports = ussdRouter;