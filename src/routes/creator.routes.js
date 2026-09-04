const express = require("express");
const {
  signupCreator,
  loginCreator,
  getCreatorProfile,
  setPin,
  changePassword,
} = require("../controllers/creator.controller");
const authenticate = require("../middlewares/auth");

const creatorRouter = express.Router();

creatorRouter.post("/register", signupCreator);
creatorRouter.post("/login", loginCreator);

// Protected routes
creatorRouter.get("/profile", authenticate, getCreatorProfile);
creatorRouter.put("/pin", authenticate, setPin);
creatorRouter.patch("/change-password", authenticate, changePassword);

module.exports = creatorRouter;