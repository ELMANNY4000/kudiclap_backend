const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const dotenv = require("dotenv");

dotenv.config();

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

// Route Mounting
const creatorRouter = require("./routes/creator.routes");
const withdrawalRouter = require("./routes/withdrawal.route");
const paymentRouter = require("./routes/payment.routes");
const transactionRouter = require("./routes/transaction.routes");
const ussdRouter = require("./routes/ussd.routes");
const errorMiddleware = require("./middlewares/error.middleware");

// Prefix all routes with /api/v1
app.use("/api/v1/creators", creatorRouter);
app.use("/api/v1/withdrawals", withdrawalRouter);
app.use("/api/v1/payments", paymentRouter);
app.use("/api/v1/transactions", transactionRouter);
app.use("/api/v1/ussd", ussdRouter);

// Global Error Handler
app.use(errorMiddleware);

module.exports = app;