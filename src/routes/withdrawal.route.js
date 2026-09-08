const express = require("express");
const { withdrawAmount } = require("../controllers/withdrawal.controller");
const authenticate = require("../middlewares/auth");

const withdrawalRouter = express.Router();

withdrawalRouter.post("/withdraw", authenticate, withdrawAmount);

module.exports = withdrawalRouter;